import { recordAchievement } from "./achievement-events.js";
import { recordCharacterOperation } from "./character-operation.service.js";
import { consumeBinding, consumeInventory, grantInventory, productionBinding } from "./inventory-binding.js";
import { consumeTalentMaterial, talentMaterialPayment } from "./talent-production.js";
import { BAINA_GUILD_POSITION, BAINA_RESIDENCE_CODE, homeCosts, homePlotDistance, slotsPerFloor } from "./home.constants.js";
import { backfillHomeFloorLayout, findFurniturePlacement, furnitureDimensions, occupyFurnitureCells, roomForHouseLevel } from "./home-layout.service.js";
import { getPool, withTransaction } from "../database/pool.js";
import { randomUUID } from "node:crypto";

//#region src/game/home.service.ts
const characterFor = async (connection, qqUserId, lock = false) => {
	const [rows] = await connection.execute(`SELECT c.id,c.player_id,c.name,c.copper_coins,c.current_region_id,c.pos_x,c.pos_y,c.pos_z,c.activity_status,r.code AS region_code
    FROM characters c JOIN players p ON p.id=c.player_id JOIN map_regions r ON r.id=c.current_region_id
    WHERE p.qq_user_id=? AND c.npc_code IS NULL LIMIT 1${lock ? " FOR UPDATE" : ""}`, [qqUserId]);
	if (!rows[0]) throw new Error("请先发送“注册”创建角色。");
	return rows[0];
};
const homeFor = async (connection, characterId, lock = false) => {
	const [rows] = await connection.execute(`SELECT * FROM player_homes WHERE character_id=? AND status='active' LIMIT 1${lock ? " FOR UPDATE" : ""}`, [characterId]);
	return rows[0];
};
const json = (value) => {
	if (value && typeof value === "object") return value;
	try {
		return JSON.parse(String(value ?? "{}"));
	} catch {
		return {};
	}
};
const assertAtResidence = async (connection, character) => {
	const [rows] = await connection.execute(`SELECT 1 FROM map_npcs WHERE code=? AND region_id=? AND pos_x=? AND pos_y=? AND pos_z=? LIMIT 1`, [
		BAINA_RESIDENCE_CODE,
		character.current_region_id,
		character.pos_x,
		character.pos_y,
		character.pos_z
	]);
	if (!rows[0]) throw new Error("请先前往百纳镇的百纳居。");
};
const assertHomeShopFree = async (connection, character) => {
	if (character.activity_status !== "active") throw new Error("当前状态无法在百纳居买卖。");
	const [travel] = await connection.execute("SELECT 1 FROM player_travels WHERE character_id=? LIMIT 1", [character.id]);
	if (travel[0]) throw new Error("旅行途中无法在百纳居买卖。");
	const [mining] = await connection.execute("SELECT 1 FROM player_resource_mining WHERE character_id=? LIMIT 1", [character.id]);
	if (mining[0]) throw new Error("开采尚未结束，无法在百纳居买卖。");
	const [combat] = await connection.execute(`SELECT 1 FROM combat_sessions cs
    LEFT JOIN combat_members cm ON cm.session_id=cs.id
    WHERE cs.state='active' AND (cs.character_id=? OR cm.character_id=?) LIMIT 1`, [character.id, character.id]);
	if (combat[0]) throw new Error("战斗中无法在百纳居买卖。");
	const [pvp] = await connection.execute(`SELECT 1 FROM player_pvp_battle_sessions
    WHERE state='active' AND (attacker_character_id=? OR defender_character_id=?) LIMIT 1`, [character.id, character.id]);
	if (pvp[0]) throw new Error("玩家对战中无法在百纳居买卖。");
};
const requireHomeShopTarget = async (connection, qqUserId, targetId, lock = false) => {
	if (targetId !== "baina_residence") throw new Error("百纳居目标无效。");
	const character = await characterFor(connection, qqUserId, lock);
	await assertAtResidence(connection, character);
	await assertHomeShopFree(connection, character);
	return {
		characterId: Number(character.id),
		target: {
			id: BAINA_RESIDENCE_CODE,
			name: "百纳居",
			locationRequired: true
		}
	};
};
const assertFree = async (connection, character, allowResting = false, readOnly = false) => {
	if (character.activity_status === "detained") throw new Error("你正在被守卫关押。");
	if (character.activity_status === "unconscious") throw new Error("你已昏迷，暂时无法进入家园。");
	if (!allowResting && character.activity_status === "resting") throw new Error("请先结束休息。");
	if (!readOnly) {
		await connection.execute(`UPDATE player_pvp_battle_logs log
    JOIN player_pvp_battle_sessions battle ON battle.id=log.id
    SET log.outcome='escaped',log.ended_at=NOW()
    WHERE battle.state='active' AND battle.created_at<=DATE_SUB(NOW(),INTERVAL 30 MINUTE)
      AND (battle.attacker_character_id=? OR battle.defender_character_id=?)`, [character.id, character.id]);
		await connection.execute(`UPDATE player_pvp_battle_sessions SET state='escaped'
    WHERE state='active' AND created_at<=DATE_SUB(NOW(),INTERVAL 30 MINUTE)
      AND (attacker_character_id=? OR defender_character_id=?)`, [character.id, character.id]);
	}
	const [[travel], [mining], [combat], [pvp], [party]] = await Promise.all([
		connection.execute("SELECT 1 FROM player_travels WHERE character_id=? LIMIT 1", [character.id]),
		connection.execute("SELECT 1 FROM player_resource_mining WHERE character_id=? LIMIT 1", [character.id]),
		connection.execute(`SELECT 1 FROM combat_sessions cs LEFT JOIN combat_members cm ON cm.session_id=cs.id WHERE cs.state='active' AND (cs.character_id=? OR cm.character_id=?) LIMIT 1`, [character.id, character.id]),
		connection.execute(`SELECT 1 FROM player_pvp_battle_sessions WHERE state='active'${readOnly ? " AND created_at>DATE_SUB(NOW(),INTERVAL 30 MINUTE)" : ""} AND (attacker_character_id=? OR defender_character_id=?) LIMIT 1`, [character.id, character.id]),
		connection.execute("SELECT 1 FROM party_members WHERE character_id=? LIMIT 1", [character.id])
	]);
	if (travel[0]) throw new Error("移动或寻怪尚未结束。");
	if (mining[0]) throw new Error("开采尚未结束。");
	if (combat[0] || pvp[0]) throw new Error("战斗尚未结束。");
	if (party[0]) throw new Error("请先离开队伍后再进入家园。");
};
const addItem = async (connection, characterId, itemId, binding) => {
	await grantInventory(connection, characterId, itemId, binding);
	await connection.execute("INSERT IGNORE INTO player_item_codex (character_id,item_id) VALUES (?,?)", [characterId, itemId]);
};
const exchangedBinding = (used, count, inputPerTrade, outputPerTrade) => {
	const remaining = { ...used };
	const output = {
		unbound: 0,
		trade: 0,
		personal: 0
	};
	for (let index = 0; index < count; index++) {
		const part = consumeBinding(remaining, inputPerTrade);
		remaining.unbound -= part.unbound;
		remaining.trade -= part.trade;
		remaining.personal -= part.personal;
		const produced = productionBinding(part, outputPerTrade, false);
		output.unbound += produced.unbound;
		output.trade += produced.trade;
		output.personal += produced.personal;
	}
	return output;
};
const consumeMaterials = async (connection, characterId, materials) => {
	for (const [code, quantity] of Object.entries(materials)) {
		const [rows] = await connection.execute(`SELECT pi.item_id,pi.quantity FROM player_inventory pi JOIN item_definitions i ON i.id=pi.item_id WHERE pi.character_id=? AND i.code=? FOR UPDATE`, [characterId, code]);
		const paid = rows[0] ? await talentMaterialPayment(connection, characterId, Number(rows[0].item_id), quantity, "home") : quantity;
		if (!rows[0] || Number(rows[0].quantity) < paid) throw new Error(`材料不足：${code} 实际需要 ${paid}。`);
		await consumeTalentMaterial(connection, characterId, Number(rows[0].item_id), quantity, "home");
		await connection.execute("DELETE FROM player_inventory WHERE character_id=? AND item_id=? AND quantity<=0", [characterId, rows[0].item_id]);
	}
};
const homeEffects = (furniture) => furniture.reduce((result, item) => {
	for (const [key, value] of Object.entries(json(item.effect_json))) result[key] = (result[key] ?? 0) + Number(value);
	return result;
}, {});
const isInHome = async (connection, characterId) => {
	const [rows] = await connection.execute("SELECT 1 FROM player_home_visits WHERE character_id=? LIMIT 1", [characterId]);
	return Boolean(rows[0]);
};
const homeRestRecoveryBonus = async (connection, characterId) => {
	const [rows] = await connection.execute(`SELECT COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(d.effect_json,'$.restRecoveryPct')) AS UNSIGNED)),0) AS bonus
    FROM player_home_visits v JOIN player_home_furniture f ON f.home_id=v.home_id JOIN home_furniture_definitions d ON d.code=f.furniture_code
    WHERE v.character_id=?`, [characterId]);
	return Math.min(100, Number(rows[0]?.bonus ?? 0));
};
const homeRestExperiencePerMinute = async (connection, characterId) => {
	const [rows] = await connection.execute(`SELECT COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(d.effect_json,'$.homeRestExperiencePerMinute')) AS UNSIGNED)),0) AS experience
    FROM player_home_visits v JOIN player_home_furniture f ON f.home_id=v.home_id JOIN home_furniture_definitions d ON d.code=f.furniture_code
    WHERE v.character_id=?`, [characterId]);
	return Math.max(0, Number(rows[0]?.experience ?? 0));
};
const homePanel = async (qqUserId) => {
	const pool = await getPool();
	let character = await characterFor(pool, qqUserId);
	if (character.activity_status === "resting" && await isInHome(pool, Number(character.id))) {
		const { settleHomeRestExperience } = await import("./adventure.service.js");
		await withTransaction((connection) => settleHomeRestExperience(connection, Number(character.id)));
		character = await characterFor(pool, qqUserId);
	}
	const home = await homeFor(pool, character.id);
	if (!home) return {
		character,
		home: null,
		inHome: false,
		furniture: [],
		effects: {},
		materials: []
	};
	const [visitResult, furnitureResult, materialResult] = await Promise.all([
		pool.execute("SELECT 1 FROM player_home_visits WHERE character_id=? LIMIT 1", [character.id]),
		pool.execute(`SELECT f.id,f.furniture_code,d.name,d.description,d.effect_json,f.floor_no,f.slot_key,f.grid_x,f.grid_y,f.rotation,d.grid_width,d.grid_height FROM player_home_furniture f JOIN home_furniture_definitions d ON d.code=f.furniture_code WHERE f.home_id=? ORDER BY f.floor_no,f.id`, [home.id]),
		pool.execute(`SELECT i.code,i.name,pi.quantity FROM player_inventory pi JOIN item_definitions i ON i.id=pi.item_id WHERE pi.character_id=? AND i.code IN ('home_wood','home_stone','home_metal','slime_gel') ORDER BY i.id`, [character.id])
	]);
	const visit = visitResult[0];
	const furniture = furnitureResult[0];
	const materials = materialResult[0];
	return {
		character,
		home,
		inHome: Boolean(visit[0]),
		furniture,
		effects: homeEffects(furniture),
		materials: materials.map((row) => ({
			code: row.code,
			name: row.name,
			quantity: Number(row.quantity)
		}))
	};
};
const choosePlot = async (connection, townId) => {
	const candidates = [];
	for (let x = -25; x <= 24; x++) for (let y = -185; y <= -136; y++) {
		const distance = Math.abs(x - BAINA_GUILD_POSITION.x) + Math.abs(y - BAINA_GUILD_POSITION.y);
		if (distance >= homePlotDistance.min && distance <= homePlotDistance.max) candidates.push([x, y]);
	}
	for (const [x, y] of candidates.sort(() => Math.random() - .5).slice(0, 64)) {
		const [blocked] = await connection.execute(`SELECT 1 AS blocked FROM DUAL WHERE EXISTS(SELECT 1 FROM map_npcs WHERE region_id=? AND pos_x=? AND pos_y=? AND pos_z=0)
      OR EXISTS(SELECT 1 FROM map_special_objects WHERE region_id=? AND pos_x=? AND pos_y=? AND pos_z=0)
      OR EXISTS(SELECT 1 FROM resource_spawns WHERE region_id=? AND pos_x=? AND pos_y=? AND pos_z=0 AND mined_at IS NULL)
      OR EXISTS(SELECT 1 FROM monster_spawns WHERE region_id=? AND pos_x=? AND pos_y=? AND pos_z=0 AND defeated_at IS NULL)
      OR EXISTS(SELECT 1 FROM dungeon_entrances WHERE region_id=? AND pos_x=? AND pos_y=?) LIMIT 1`, [
			townId,
			x,
			y,
			townId,
			x,
			y,
			townId,
			x,
			y,
			townId,
			x,
			y,
			townId,
			x,
			y
		]);
		if (!blocked[0]) return {
			x,
			y,
			z: 0
		};
	}
	throw new Error("暂时找不到可安置的小屋地块，请稍后再试。");
};
const previewHomePurchaseInTransaction = async (connection, qqUserId) => {
	const character = await characterFor(connection, qqUserId, true);
	await assertAtResidence(connection, character);
	await assertFree(connection, character, false, true);
	if (await homeFor(connection, character.id, true)) throw new Error("你已经拥有一间小屋。");
	const price = homeCosts.purchase.copper;
	if (Number(character.copper_coins) < price) throw new Error(`铜币不足，需要 ${price} 铜币。`);
	return {
		siteCode: BAINA_RESIDENCE_CODE,
		name: `${character.name}的小屋`,
		price,
		copperBefore: Number(character.copper_coins),
		copperAfter: Number(character.copper_coins) - price,
		plotAssignedOnConfirm: true
	};
};
const purchaseHomeInTransaction = async (connection, qqUserId) => {
	const character = await characterFor(connection, qqUserId, true);
	await assertAtResidence(connection, character);
	await assertFree(connection, character);
	if (await homeFor(connection, character.id, true)) throw new Error("你已经拥有一间小屋。");
	const plot = await choosePlot(connection, character.current_region_id);
	const [paid] = await connection.execute("UPDATE characters SET copper_coins=copper_coins-? WHERE id=? AND copper_coins>=?", [
		homeCosts.purchase.copper,
		character.id,
		homeCosts.purchase.copper
	]);
	if (!Number(paid.affectedRows)) throw new Error(`铜币不足，需要 ${homeCosts.purchase.copper} 铜币。`);
	const homeName = `${character.name}的小屋`;
	const [created] = await connection.execute("INSERT INTO player_homes (character_id,home_name,town_region_id,plot_x,plot_y,plot_z) VALUES (?,?,?,?,?,?)", [
		character.id,
		homeName,
		character.current_region_id,
		plot.x,
		plot.y,
		plot.z
	]);
	const [homeEvent] = await connection.execute("INSERT INTO player_events (player_id,event_type,payload) VALUES (?,'home.purchased',JSON_OBJECT('homeId',?,'x',?,'y',?))", [
		character.player_id,
		created.insertId,
		plot.x,
		plot.y
	]);
	await recordCharacterOperation(connection, {
		characterId: Number(character.id),
		kind: "home.purchased",
		existingEventId: Number(homeEvent.insertId),
		source: {
			system: "home",
			id: Number(created.insertId),
			step: "purchased"
		},
		outcome: "购得",
		summary: `购得家园：${homeName}`,
		detail: {
			homeId: Number(created.insertId),
			name: homeName,
			plot,
			paidCopper: homeCosts.purchase.copper
		}
	});
	recordAchievement(connection, Number(character.id), ["ACH_K10"]);
	return {
		plot,
		copper: homeCosts.purchase.copper,
		homeId: Number(created.insertId),
		name: homeName
	};
};
const purchaseHome = async (qqUserId) => withTransaction((connection) => purchaseHomeInTransaction(connection, qqUserId));
const homePurchaseSite = async (qqUserId) => {
	const pool = await getPool();
	const character = await characterFor(pool, qqUserId);
	const home = await homeFor(pool, Number(character.id));
	const [rows] = await pool.execute(`SELECT n.region_id,r.code AS region_code,r.name AS region_name,n.code,n.name,n.pos_x,n.pos_y,n.pos_z
    FROM map_npcs n JOIN map_regions r ON r.id=n.region_id WHERE n.code=? AND r.code='baina_town' LIMIT 1`, [BAINA_RESIDENCE_CODE]);
	const site = rows[0];
	if (!site) throw new Error("百纳居的地图位置暂不可用。");
	return {
		owned: Boolean(home),
		purchaseCopper: homeCosts.purchase.copper,
		current: {
			regionCode: character.region_code,
			x: Number(character.pos_x),
			y: Number(character.pos_y),
			z: Number(character.pos_z)
		},
		target: {
			id: site.code,
			name: site.name,
			regionId: Number(site.region_id),
			regionCode: site.region_code,
			regionName: site.region_name,
			x: Number(site.pos_x),
			y: Number(site.pos_y),
			z: Number(site.pos_z),
			locationRequired: true
		},
		atSite: Number(character.current_region_id) === Number(site.region_id) && Number(character.pos_x) === Number(site.pos_x) && Number(character.pos_y) === Number(site.pos_y) && Number(character.pos_z) === Number(site.pos_z)
	};
};
const enterHome = async (qqUserId) => withTransaction(async (connection) => {
	const character = await characterFor(connection, qqUserId, true);
	const home = await homeFor(connection, character.id, true);
	if (!home) throw new Error("你还没有小屋，请先在百纳居购买。");
	if (character.region_code !== "baina_town" || Number(character.pos_x) !== Number(home.plot_x) || Number(character.pos_y) !== Number(home.plot_y) || Number(character.pos_z) !== Number(home.plot_z)) throw new Error("请先前往自己的小屋地块。");
	await assertFree(connection, character);
	if (await isInHome(connection, Number(character.id))) throw new Error("你已经在自己的家园中。");
	await connection.execute("INSERT INTO player_home_visits (character_id,home_id) VALUES (?,?) ON DUPLICATE KEY UPDATE home_id=VALUES(home_id),entered_at=NOW()", [character.id, home.id]);
	const { recordWarrantSighting } = await import("./pvp.service.js");
	await recordWarrantSighting(connection, Number(character.id), Number(home.town_region_id), Number(home.plot_x), Number(home.plot_y));
	const { createCityPursuitAtCurrentPosition } = await import("./adventure.service.js");
	const pursuit = await createCityPursuitAtCurrentPosition(connection, qqUserId);
	await recordCharacterOperation(connection, {
		characterId: Number(character.id),
		kind: "home.entered",
		source: {
			system: "home_visit",
			id: randomUUID(),
			step: "entered"
		},
		outcome: "进入",
		summary: `进入家园：${home.home_name}`,
		detail: {
			homeId: Number(home.id),
			homeName: home.home_name
		}
	});
	return {
		home,
		pursuit
	};
});
const leaveHome = async (qqUserId) => withTransaction(async (connection) => {
	const character = await characterFor(connection, qqUserId, true);
	const home = await homeFor(connection, character.id, true);
	if (!home || !await isInHome(connection, character.id)) throw new Error("你当前不在自己的家园中。");
	const { settleHomeRestExperience } = await import("./adventure.service.js");
	await settleHomeRestExperience(connection, Number(character.id));
	await connection.execute("DELETE FROM player_home_visits WHERE character_id=?", [character.id]);
	await connection.execute("UPDATE characters SET home_rest_experience_updated_at=NULL WHERE id=?", [character.id]);
	const [leaveEvent] = await connection.execute("INSERT INTO player_events (player_id,event_type,payload) VALUES (?,'home.left',JSON_OBJECT('homeId',?))", [character.player_id, home.id]);
	await recordCharacterOperation(connection, {
		characterId: Number(character.id),
		kind: "home.left",
		existingEventId: Number(leaveEvent.insertId),
		source: {
			system: "home_event",
			id: Number(leaveEvent.insertId),
			step: "left"
		},
		outcome: "离开",
		summary: `离开家园：${home.home_name}`,
		detail: {
			homeId: Number(home.id),
			name: home.home_name
		}
	});
	return home;
});
const renameHome = async (qqUserId, input) => withTransaction(async (connection) => {
	const name = input.trim();
	if (Array.from(name).length < 2 || Array.from(name).length > 32 || /[\r\n]/.test(name)) throw new Error("小屋名称需为 2～32 个字符，且不能包含换行。");
	const character = await characterFor(connection, qqUserId, true);
	const home = await homeFor(connection, character.id, true);
	if (!home) throw new Error("你还没有小屋。");
	if (name === home.home_name) return { name };
	await connection.execute("UPDATE player_homes SET home_name=? WHERE id=?", [name, home.id]);
	const [renameEvent] = await connection.execute("INSERT INTO player_events (player_id,event_type,payload) VALUES (?,'home.renamed',JSON_OBJECT('homeId',?,'name',?))", [
		character.player_id,
		home.id,
		name
	]);
	await recordCharacterOperation(connection, {
		characterId: Number(character.id),
		kind: "home.renamed",
		existingEventId: Number(renameEvent.insertId),
		source: {
			system: "home_event",
			id: Number(renameEvent.insertId),
			step: "renamed"
		},
		outcome: "改名",
		summary: `家园改名：${home.home_name} → ${name}`,
		detail: {
			homeId: Number(home.id),
			oldName: home.home_name,
			newName: name
		}
	});
	recordAchievement(connection, Number(character.id), ["ACH_K12"]);
	return { name };
});
const costForUpgrade = (home) => Number(home.house_level) === 1 ? homeCosts.upgrade2 : Number(home.house_level) === 2 ? homeCosts.upgrade3 : null;
const upgradeHome = async (qqUserId) => withTransaction(async (connection) => {
	const character = await characterFor(connection, qqUserId, true);
	const home = await homeFor(connection, character.id, true);
	if (!home) throw new Error("你还没有小屋。");
	const cost = costForUpgrade(home);
	if (!cost) throw new Error("房屋已经达到最高等级。");
	await consumeMaterials(connection, character.id, { ...cost.materials });
	const [paid] = await connection.execute("UPDATE characters SET copper_coins=copper_coins-? WHERE id=? AND copper_coins>=?", [
		cost.copper,
		character.id,
		cost.copper
	]);
	if (!Number(paid.affectedRows)) throw new Error(`铜币不足，需要 ${cost.copper} 铜币。`);
	await connection.execute("UPDATE player_homes SET house_level=house_level+1 WHERE id=?", [home.id]);
	await connection.execute("UPDATE player_home_furniture SET layout_version=0 WHERE home_id=?", [home.id]);
	await connection.execute("DELETE FROM player_home_floor_renders WHERE home_id=?", [home.id]);
	const level = Number(home.house_level) + 1;
	await recordCharacterOperation(connection, {
		characterId: Number(character.id),
		kind: "home.upgraded",
		source: {
			system: "home",
			id: Number(home.id),
			step: `level_${level}`
		},
		outcome: "升级",
		summary: `家园升至 Lv${level}`,
		detail: {
			homeId: Number(home.id),
			level,
			cost
		}
	});
	return {
		level,
		cost
	};
});
const expandHome = async (qqUserId, floor) => withTransaction(async (connection) => {
	const character = await characterFor(connection, qqUserId, true);
	const home = await homeFor(connection, character.id, true);
	if (!home) throw new Error("你还没有小屋。");
	const target = Number(floor);
	const cost = target === 2 ? homeCosts.expand2 : homeCosts.expand3;
	if (Number(home.floor_count) + 1 !== target || Number(home.house_level) < target || target === 3 && Number(home.floor_count) < 2) throw new Error(target === 2 ? "需要房屋 Lv.2 且尚未扩建二层。" : "需要房屋 Lv.3 且已拥有二层。");
	await consumeMaterials(connection, character.id, { ...cost.materials });
	const [paid] = await connection.execute("UPDATE characters SET copper_coins=copper_coins-? WHERE id=? AND copper_coins>=?", [
		cost.copper,
		character.id,
		cost.copper
	]);
	if (!Number(paid.affectedRows)) throw new Error(`铜币不足，需要 ${cost.copper} 铜币。`);
	await connection.execute("UPDATE player_homes SET floor_count=? WHERE id=?", [target, home.id]);
	await recordCharacterOperation(connection, {
		characterId: Number(character.id),
		kind: "home.expanded",
		source: {
			system: "home",
			id: Number(home.id),
			step: `floor_${target}`
		},
		outcome: "扩建",
		summary: `家园扩建至 ${target} 层`,
		detail: {
			homeId: Number(home.id),
			floor: target,
			cost
		}
	});
	return {
		floor: target,
		cost
	};
});
const listFurniture = async (qqUserId, floor) => {
	const pool = await getPool();
	const character = await characterFor(pool, qqUserId);
	const home = await homeFor(pool, character.id);
	if (!home) throw new Error("你还没有小屋。");
	if (floor) await withTransaction((connection) => backfillHomeFloorLayout(connection, Number(home.id), floor, Number(home.house_level)));
	const [definitions, installed, recipes, owned] = await Promise.all([
		pool.execute("SELECT * FROM home_furniture_definitions WHERE is_active=1 ORDER BY required_house_level,code"),
		pool.execute(`SELECT f.id,f.furniture_code,d.name,d.description,d.effect_json,f.floor_no,f.slot_key,f.grid_x,f.grid_y,f.rotation,d.grid_width,d.grid_height FROM player_home_furniture f JOIN home_furniture_definitions d ON d.code=f.furniture_code WHERE f.home_id=?${floor ? " AND f.floor_no=?" : ""} ORDER BY f.floor_no,f.id`, floor ? [home.id, floor] : [home.id]),
		pool.execute(`SELECT r.furniture_code,i.name,r.quantity FROM home_furniture_recipes r JOIN item_definitions i ON i.id=r.item_id ORDER BY r.furniture_code,i.id`),
		pool.execute("SELECT furniture_code,COUNT(*) AS quantity FROM player_home_furniture WHERE home_id=? GROUP BY furniture_code", [home.id])
	]);
	const recipesByCode = /* @__PURE__ */ new Map();
	recipes[0].forEach((row) => recipesByCode.set(row.furniture_code, [...recipesByCode.get(row.furniture_code) ?? [], {
		name: row.name,
		quantity: Number(row.quantity)
	}]));
	const ownedCounts = /* @__PURE__ */ new Map();
	owned[0].forEach((row) => ownedCounts.set(row.furniture_code, Number(row.quantity)));
	return {
		home,
		definitions: definitions[0],
		installed: installed[0],
		recipes: recipesByCode,
		ownedCounts,
		slots: slotsPerFloor(Number(home.house_level))
	};
};
const craftFurniture = async (qqUserId, code, floor, _legacySlotKey) => withTransaction(async (connection) => {
	const character = await characterFor(connection, qqUserId, true);
	const home = await homeFor(connection, character.id, true);
	if (!home) throw new Error("你还没有小屋。");
	if (!Number.isInteger(floor) || floor < 1 || floor > Number(home.floor_count)) throw new Error("楼层不存在。");
	const [definitions] = await connection.execute("SELECT * FROM home_furniture_definitions WHERE code=? AND is_active=1 FOR UPDATE", [code]);
	const definition = definitions[0];
	if (!definition || Number(definition.required_house_level) > Number(home.house_level)) throw new Error("该家具尚未解锁。");
	await backfillHomeFloorLayout(connection, Number(home.id), floor, Number(home.house_level));
	const [[usedRows], [same]] = await Promise.all([connection.execute("SELECT d.floor_slot_cost FROM player_home_furniture f JOIN home_furniture_definitions d ON d.code=f.furniture_code WHERE f.home_id=? AND f.floor_no=? FOR UPDATE", [home.id, floor]), connection.execute("SELECT COUNT(*) AS count FROM player_home_furniture WHERE home_id=? AND floor_no=? AND furniture_code=? FOR UPDATE", [
		home.id,
		floor,
		code
	])]);
	if (usedRows.reduce((sum, item) => sum + Number(item.floor_slot_cost), 0) + Number(definition.floor_slot_cost) > slotsPerFloor(Number(home.house_level))) throw new Error("这一层的家具槽位不足。");
	if (Number(same[0]?.count ?? 0) >= Number(definition.max_per_floor)) throw new Error(`每层最多放置 ${definition.max_per_floor} 个${definition.name}。`);
	const placement = await findFurniturePlacement(connection, Number(home.id), floor, Number(home.house_level), definition);
	const [recipe] = await connection.execute(`SELECT r.item_id,r.quantity,i.name FROM home_furniture_recipes r JOIN item_definitions i ON i.id=r.item_id WHERE r.furniture_code=? FOR UPDATE`, [code]);
	for (const material of recipe) {
		const [owned] = await connection.execute("SELECT quantity FROM player_inventory WHERE character_id=? AND item_id=? FOR UPDATE", [character.id, material.item_id]);
		const paid = await talentMaterialPayment(connection, character.id, Number(material.item_id), Number(material.quantity), "home");
		if (Number(owned[0]?.quantity ?? 0) < paid) throw new Error(`材料不足：${material.name}×${paid}。`);
	}
	for (const material of recipe) {
		await consumeTalentMaterial(connection, character.id, Number(material.item_id), Number(material.quantity), "home");
		await connection.execute("DELETE FROM player_inventory WHERE character_id=? AND item_id=? AND quantity<=0", [character.id, material.item_id]);
	}
	const slotKey = `auto-${floor}-${placement.x}-${placement.y}-${Date.now().toString(36)}`;
	const [created] = await connection.execute("INSERT INTO player_home_furniture (home_id,furniture_code,floor_no,slot_key,grid_x,grid_y,rotation,layout_version) VALUES (?,?,?,?,?,?,?,2)", [
		home.id,
		code,
		floor,
		slotKey,
		placement.x,
		placement.y,
		placement.rotation
	]);
	await occupyFurnitureCells(connection, Number(home.id), floor, Number(created.insertId), placement);
	await connection.execute("DELETE FROM player_home_floor_renders WHERE home_id=? AND floor_no=?", [home.id, floor]);
	await recordCharacterOperation(connection, {
		characterId: Number(character.id),
		kind: "home.furniture_crafted",
		source: {
			system: "home_furniture",
			id: Number(created.insertId),
			step: "crafted"
		},
		outcome: "制成",
		summary: `制成并摆放${definition.name}`,
		detail: {
			furnitureId: Number(created.insertId),
			homeId: Number(home.id),
			code,
			name: definition.name,
			floor,
			placement,
			materials: recipe.map((item) => ({
				name: item.name,
				quantity: Number(item.quantity)
			}))
		}
	});
	recordAchievement(connection, Number(character.id), ["ACH_K13"]);
	const [furnitureCount] = await connection.execute("SELECT COUNT(DISTINCT furniture_code) AS n FROM player_home_furniture WHERE home_id=?", [home.id]);
	recordAchievement(connection, Number(character.id), [{
		metric: "ACH_K14",
		maximum: true,
		value: Number(furnitureCount[0].n),
		life: true
	}]);
	return {
		id: Number(created.insertId),
		name: definition.name,
		floor,
		placement
	};
});
const removeFurniture = async (qqUserId, furnitureId) => withTransaction(async (connection) => {
	const character = await characterFor(connection, qqUserId, true);
	const home = await homeFor(connection, character.id, true);
	if (!home) throw new Error("你还没有小屋。");
	const [rows] = await connection.execute("SELECT f.id,f.furniture_code,d.name,d.description,d.effect_json,f.floor_no,f.slot_key,f.grid_x,f.grid_y,f.rotation,d.grid_width,d.grid_height FROM player_home_furniture f JOIN home_furniture_definitions d ON d.code=f.furniture_code WHERE f.id=? AND f.home_id=? FOR UPDATE", [furnitureId, home.id]);
	if (!rows[0]) throw new Error("没有找到该家具。");
	await connection.execute("DELETE FROM player_home_furniture WHERE id=?", [furnitureId]);
	await connection.execute("DELETE FROM player_home_floor_renders WHERE home_id=? AND floor_no=?", [home.id, rows[0].floor_no]);
	await recordCharacterOperation(connection, {
		characterId: Number(character.id),
		kind: "home.furniture_removed",
		source: {
			system: "home_furniture",
			id: furnitureId,
			step: "removed"
		},
		outcome: "拆除",
		summary: `拆除${rows[0].name}`,
		detail: {
			furnitureId,
			homeId: Number(home.id),
			code: rows[0].furniture_code,
			name: rows[0].name,
			floor: Number(rows[0].floor_no)
		}
	});
	return rows[0];
});
const listHomeShop = async (qqUserId) => {
	const pool = await getPool();
	const character = await characterFor(pool, qqUserId);
	await assertAtResidence(pool, character);
	await assertHomeShopFree(pool, character);
	const [rows] = await pool.execute(`SELECT o.id,o.offer_code,out_item.name AS output_name,o.output_quantity,in_item.name AS input_name,o.input_quantity,o.copper_price
    FROM home_shop_offers o JOIN item_definitions out_item ON out_item.id=o.output_item_id LEFT JOIN item_definitions in_item ON in_item.id=o.input_item_id WHERE o.is_active=1 ORDER BY o.sort_order,o.id`);
	return {
		copper: Number(character.copper_coins),
		offers: rows.map((row) => ({
			id: Number(row.id),
			code: row.offer_code,
			outputName: row.output_name,
			outputQuantity: Number(row.output_quantity),
			inputName: row.input_name,
			inputQuantity: Number(row.input_quantity),
			copperPrice: Number(row.copper_price)
		}))
	};
};
const homeShopOfferDetail = async (qqUserId, offerId) => {
	const pool = await getPool();
	const character = await characterFor(pool, qqUserId);
	await assertAtResidence(pool, character);
	await assertHomeShopFree(pool, character);
	const [rows] = await pool.execute(`SELECT o.id,o.offer_code,out_item.name AS output_name,o.output_quantity,o.input_item_id,in_item.name AS input_name,o.input_quantity,o.copper_price,COALESCE(pi.quantity,0) AS owned_quantity
    FROM home_shop_offers o JOIN item_definitions out_item ON out_item.id=o.output_item_id LEFT JOIN item_definitions in_item ON in_item.id=o.input_item_id
    LEFT JOIN player_inventory pi ON pi.character_id=? AND pi.item_id=o.input_item_id WHERE o.id=? AND o.is_active=1 LIMIT 1`, [character.id, offerId]);
	const row = rows[0];
	if (!row) throw new Error("该报价已失效。");
	return {
		copper: Number(character.copper_coins),
		offer: {
			id: Number(row.id),
			code: row.offer_code,
			outputName: row.output_name,
			outputQuantity: Number(row.output_quantity),
			inputName: row.input_name,
			inputQuantity: Number(row.input_quantity),
			inputOwnedQuantity: row.input_item_id ? Number(row.owned_quantity) : null,
			copperPrice: Number(row.copper_price)
		}
	};
};
const tradeHomeOfferInTransaction = async (connection, qqUserId, offerId, quantity, preview = false) => {
	if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new Error("数量必须是 1 至 999 之间的整数。");
	const character = await characterFor(connection, qqUserId, true);
	await assertAtResidence(connection, character);
	await assertHomeShopFree(connection, character);
	const [offers] = await connection.execute(`SELECT o.*,i.name AS output_name FROM home_shop_offers o JOIN item_definitions i ON i.id=o.output_item_id WHERE o.id=? AND o.is_active=1 FOR UPDATE`, [offerId]);
	const offer = offers[0];
	if (!offer) throw new Error("该报价已失效。");
	const gained = Number(offer.output_quantity) * quantity;
	const need = offer.input_item_id ? Number(offer.input_quantity) * quantity : 0;
	const price = offer.input_item_id ? 0 : Number(offer.copper_price) * quantity;
	let ownedBefore = null;
	let inputBindingBefore = null;
	let inputBindingUsed = null;
	let outputBinding = {
		unbound: gained,
		trade: 0,
		personal: 0
	};
	if (offer.input_item_id) {
		const [owned] = await connection.execute("SELECT quantity,trade_bound_quantity,personal_bound_quantity FROM player_inventory WHERE character_id=? AND item_id=? FOR UPDATE", [character.id, offer.input_item_id]);
		ownedBefore = Number(owned[0]?.quantity ?? 0);
		if (ownedBefore < need) throw new Error("兑换材料不足。");
		const trade = Number(owned[0]?.trade_bound_quantity ?? 0);
		const personal = Number(owned[0]?.personal_bound_quantity ?? 0);
		inputBindingBefore = {
			unbound: ownedBefore - trade - personal,
			trade,
			personal
		};
		inputBindingUsed = consumeBinding(inputBindingBefore, need);
		outputBinding = exchangedBinding(inputBindingUsed, quantity, Number(offer.input_quantity), Number(offer.output_quantity));
	} else if (Number(character.copper_coins) < price) throw new Error(`铜币不足，需要 ${price} 铜币。`);
	const quote = {
		offerId,
		code: offer.offer_code,
		name: offer.output_name,
		quantity: gained,
		tradeCount: quantity,
		outputItemId: Number(offer.output_item_id),
		unitOutputQuantity: Number(offer.output_quantity),
		inputItemId: offer.input_item_id ? Number(offer.input_item_id) : null,
		unitInputQuantity: Number(offer.input_quantity),
		inputQuantity: need,
		inputOwnedBefore: ownedBefore,
		inputOwnedAfter: ownedBefore === null ? null : ownedBefore - need,
		inputBindingBefore,
		inputBindingUsed,
		outputBinding,
		unitCopperPrice: Number(offer.copper_price),
		price,
		copperBefore: Number(character.copper_coins),
		copperAfter: Number(character.copper_coins) - price
	};
	if (preview) return quote;
	if (offer.input_item_id) {
		const consumed = await consumeInventory(connection, Number(character.id), Number(offer.input_item_id), need);
		if (JSON.stringify(consumed) !== JSON.stringify(inputBindingUsed)) throw new Error("兑换材料绑定状态已变化，请重新获取报价。");
	} else {
		const [paid] = await connection.execute("UPDATE characters SET copper_coins=copper_coins-? WHERE id=? AND copper_coins>=?", [
			price,
			character.id,
			price
		]);
		if (paid.affectedRows !== 1) throw new Error(`铜币不足，需要 ${price} 铜币。`);
	}
	await addItem(connection, character.id, Number(offer.output_item_id), outputBinding);
	await recordCharacterOperation(connection, {
		characterId: Number(character.id),
		kind: "home.offer_traded",
		source: {
			system: "home_shop_trade",
			id: randomUUID(),
			step: "settled"
		},
		outcome: "兑换",
		summary: `在家园兑换${offer.output_name} ×${gained}`,
		detail: {
			offerId,
			tradeCount: quantity,
			outputItemId: Number(offer.output_item_id),
			outputName: offer.output_name,
			outputQuantity: gained,
			inputItemId: offer.input_item_id ? Number(offer.input_item_id) : null,
			inputQuantity: offer.input_item_id ? Number(offer.input_quantity) * quantity : 0,
			inputBindingUsed,
			outputBinding,
			paidCopper: offer.input_item_id ? 0 : Number(offer.copper_price) * quantity
		}
	});
	return quote;
};
const tradeHomeOffer = async (qqUserId, offerId, quantity) => withTransaction((connection) => tradeHomeOfferInTransaction(connection, qqUserId, offerId, quantity));
const homeStorageCapacityFor = async (connection, homeId) => {
	const [rows] = await connection.execute(`SELECT COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(d.effect_json,'$.storageCapacity')) AS UNSIGNED)),0) AS capacity
    FROM player_home_furniture f JOIN home_furniture_definitions d ON d.code=f.furniture_code WHERE f.home_id=?`, [homeId]);
	return Math.max(0, Number(rows[0]?.capacity ?? 0));
};
const homeStorageWeightFor = async (connection, homeId) => {
	const [rows] = await connection.execute(`SELECT COALESCE(SUM(weight),0) AS weight FROM (
    SELECT hs.quantity*i.weight AS weight FROM player_home_storage_items hs JOIN item_definitions i ON i.id=hs.item_id WHERE hs.home_id=? AND hs.quantity>0
    UNION ALL
    SELECT i.weight AS weight FROM player_home_storage_instances hs JOIN player_item_instances ii ON ii.id=hs.instance_id JOIN item_definitions i ON i.id=ii.item_id WHERE hs.home_id=?
  ) stored_weights`, [homeId, homeId]);
	return Number(rows[0]?.weight ?? 0);
};
/** 世界页远程只读视图；不结算休息、不修补旧布局，也不进入家园场景。 */
const homeOverview = (qqUserId) => withTransaction(async (connection) => {
	const character = await characterFor(connection, qqUserId);
	const home = await homeFor(connection, Number(character.id));
	const purchase = {
		siteCode: BAINA_RESIDENCE_CODE,
		copper: homeCosts.purchase.copper,
		locationRequired: true
	};
	if (!home) return {
		owned: false,
		home: null,
		purchase
	};
	const [visits] = await connection.execute("SELECT 1 FROM player_home_visits WHERE character_id=? AND home_id=? LIMIT 1", [character.id, home.id]);
	const [placed] = await connection.execute(`SELECT f.id,f.furniture_code,d.name,d.description,d.effect_json,f.floor_no,f.slot_key,f.grid_x,f.grid_y,f.rotation,f.layout_version,
    d.grid_width,d.grid_height,d.floor_slot_cost,d.layer_order FROM player_home_furniture f JOIN home_furniture_definitions d ON d.code=f.furniture_code
    WHERE f.home_id=? ORDER BY f.floor_no,d.layer_order,f.id`, [home.id]);
	const [materials] = await connection.execute(`SELECT i.code,i.name,pi.quantity FROM player_inventory pi JOIN item_definitions i ON i.id=pi.item_id
    WHERE pi.character_id=? AND i.code IN ('home_wood','home_stone','home_metal','slime_gel') ORDER BY i.id`, [character.id]);
	const [stacked] = await connection.execute(`SELECT COUNT(*) AS kinds,COALESCE(SUM(quantity),0) AS quantity
    FROM player_home_storage_items WHERE home_id=? AND quantity>0`, [home.id]);
	const [instances] = await connection.execute("SELECT COUNT(*) AS count FROM player_home_storage_instances WHERE home_id=?", [home.id]);
	const storageCapacity = await homeStorageCapacityFor(connection, Number(home.id));
	const usedWeight = await homeStorageWeightFor(connection, Number(home.id));
	const effects = homeEffects(placed);
	const level = Number(home.house_level);
	const floorCount = Number(home.floor_count);
	const room = roomForHouseLevel(level);
	const floors = Array.from({ length: floorCount }, (_, index) => {
		const number = index + 1;
		const furniture = placed.filter((item) => Number(item.floor_no) === number);
		return {
			number,
			room,
			slotsTotal: slotsPerFloor(level),
			slotsUsed: furniture.reduce((sum, item) => sum + Number(item.floor_slot_cost), 0),
			layoutPending: furniture.some((item) => Number(item.layout_version) < 2 || item.grid_x == null || item.grid_y == null),
			furniture: furniture.map((item) => {
				const pending = Number(item.layout_version) < 2 || item.grid_x == null || item.grid_y == null;
				const dimensions = furnitureDimensions(Number(item.grid_width), Number(item.grid_height), Number(item.rotation));
				return {
					id: Number(item.id),
					code: item.furniture_code,
					name: item.name,
					description: item.description,
					effects: json(item.effect_json),
					gridX: pending ? null : Number(item.grid_x),
					gridY: pending ? null : Number(item.grid_y),
					width: dimensions.width,
					height: dimensions.height,
					rotation: Number(item.rotation),
					slotCost: Number(item.floor_slot_cost),
					layerOrder: Number(item.layer_order)
				};
			})
		};
	});
	const atPlot = character.region_code === "baina_town" && Number(character.current_region_id) === Number(home.town_region_id) && Number(character.pos_x) === Number(home.plot_x) && Number(character.pos_y) === Number(home.plot_y) && Number(character.pos_z) === Number(home.plot_z);
	return {
		owned: true,
		purchase,
		home: {
			id: Number(home.id),
			name: home.home_name || `${character.name}的小屋`,
			level,
			floorCount,
			location: {
				regionId: Number(home.town_region_id),
				x: Number(home.plot_x),
				y: Number(home.plot_y),
				z: Number(home.plot_z)
			},
			inHome: Boolean(visits[0]),
			atPlot,
			effects,
			materials: materials.map((item) => ({
				code: item.code,
				name: item.name,
				quantity: Number(item.quantity)
			})),
			furnitureCount: placed.length,
			floors,
			storage: {
				available: storageCapacity > 0,
				capacityKg: storageCapacity,
				usedKg: usedWeight,
				stackedKinds: Number(stacked[0]?.kinds ?? 0),
				stackedQuantity: Number(stacked[0]?.quantity ?? 0),
				instanceCount: Number(instances[0]?.count ?? 0)
			}
		}
	};
});
const homeStorageView = async (qqUserId, scope, category) => {
	const panel = await homePanel(qqUserId);
	if (!panel.home) throw new Error("你还没有小屋。");
	const capacity = Math.max(0, Number(panel.effects.storageCapacity ?? 0));
	if (!capacity && scope === "backpack") throw new Error("尚未摆放储物箱，暂时没有可用仓储空间。");
	const pool = await getPool();
	const itemType = category === "装备" ? "equipment" : category === "道具" ? "consumable" : "material";
	const stackedQuery = scope === "storage" ? pool.execute("SELECT i.id,i.code,i.codex_id,i.name,i.item_category,hs.quantity,i.weight,i.description FROM player_home_storage_items hs JOIN item_definitions i ON i.id=hs.item_id WHERE hs.home_id=? AND hs.quantity>0 AND i.item_type=? ORDER BY i.name", [panel.home.id, itemType]) : pool.execute("SELECT i.id,i.code,i.codex_id,i.name,i.item_category,pi.quantity,i.weight,i.description FROM player_inventory pi JOIN item_definitions i ON i.id=pi.item_id WHERE pi.character_id=? AND i.item_type=? AND i.stackable=1 ORDER BY i.name", [panel.character.id, itemType]);
	const instanceQuery = scope === "storage" ? pool.execute("SELECT ii.id,i.codex_id AS definition_codex_id,i.name,i.item_category,ii.quality,ii.durability,ii.durability_max,i.description FROM player_home_storage_instances hs JOIN player_item_instances ii ON ii.id=hs.instance_id JOIN item_definitions i ON i.id=ii.item_id WHERE hs.home_id=? AND i.item_type=? ORDER BY hs.stored_at DESC", [panel.home.id, itemType]) : pool.execute("SELECT ii.id,i.codex_id AS definition_codex_id,i.name,i.item_category,ii.quality,ii.durability,ii.durability_max,i.description FROM player_item_instances ii JOIN item_definitions i ON i.id=ii.item_id WHERE ii.character_id=? AND i.item_type=? AND NOT EXISTS (SELECT 1 FROM player_home_storage_instances hs WHERE hs.instance_id=ii.id) ORDER BY ii.acquired_at DESC", [panel.character.id, itemType]);
	const [stackedResult, instanceResult, usedWeight] = await Promise.all([
		stackedQuery,
		instanceQuery,
		homeStorageWeightFor(pool, Number(panel.home.id))
	]);
	return {
		capacity,
		usedWeight,
		stacked: stackedResult[0].map((item) => ({
			...item,
			id: Number(item.id),
			quantity: Number(item.quantity),
			weight: Number(item.weight)
		})),
		instances: instanceResult[0].map((item) => ({
			...item,
			id: Number(item.id),
			quality: Number(item.quality),
			durability: Number(item.durability),
			durability_max: Number(item.durability_max)
		}))
	};
};
const depositHomeStorageInTransaction = async (connection, qqUserId, itemId, quantity, preview = false) => {
	if (!Number.isSafeInteger(itemId) || itemId < 1 || !Number.isSafeInteger(quantity) || quantity < 1) throw new Error("物品编号和数量必须为正整数。");
	const character = await characterFor(connection, qqUserId, true);
	const home = await homeFor(connection, Number(character.id), true);
	if (!home) throw new Error("你还没有小屋。");
	const capacity = await homeStorageCapacityFor(connection, Number(home.id));
	if (!capacity) throw new Error("尚未摆放储物箱，暂时没有可用仓储空间。");
	const [rows] = await connection.execute("SELECT pi.item_id,i.name,pi.quantity,i.weight,pi.trade_bound_quantity,pi.personal_bound_quantity,CASE WHEN JSON_EXTRACT(i.effect_json,'$.personalOnly')=true THEN 1 ELSE 0 END AS personal_only FROM player_inventory pi JOIN item_definitions i ON i.id=pi.item_id WHERE pi.character_id=? AND pi.item_id=? AND pi.quantity>0 AND i.stackable=1 FOR UPDATE", [character.id, itemId]);
	const item = rows[0];
	if (!item) throw new Error("背包中没有可放入的该物品。");
	if (Number(item.personal_only)) throw new Error("足迹永久道具必须保留在背包中，无法转存。");
	if (Number(item.quantity) < quantity) throw new Error(`背包数量不足，当前仅有 ${item.quantity} 个。`);
	const usedWeight = await homeStorageWeightFor(connection, Number(home.id));
	const addedWeight = Number(item.weight) * quantity;
	if (usedWeight + addedWeight > capacity + 1e-6) throw new Error(`仓储容量不足，还可放入 ${Math.max(0, capacity - usedWeight).toFixed(2)} kg。`);
	const bindingBefore = {
		unbound: Number(item.quantity) - Number(item.trade_bound_quantity) - Number(item.personal_bound_quantity),
		trade: Number(item.trade_bound_quantity),
		personal: Number(item.personal_bound_quantity)
	};
	const bindingUsed = consumeBinding(bindingBefore, quantity);
	const quote = {
		side: "deposit",
		homeId: Number(home.id),
		itemId: Number(item.item_id),
		name: item.name,
		quantity,
		ownedBefore: Number(item.quantity),
		weightEach: Number(item.weight),
		addedWeight,
		usedWeightBefore: usedWeight,
		usedWeightAfter: usedWeight + addedWeight,
		usedWeight: usedWeight + addedWeight,
		capacity,
		bindingBefore,
		bindingUsed,
		bindingReturned: bindingUsed
	};
	if (preview) return quote;
	const binding = await consumeInventory(connection, Number(character.id), Number(item.item_id), quantity);
	if (JSON.stringify(binding) !== JSON.stringify(bindingUsed)) throw new Error("物品绑定状态已变化，请重新预览。");
	await connection.execute("INSERT INTO player_home_storage_items (home_id,item_id,quantity,trade_bound_quantity,personal_bound_quantity) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE quantity=quantity+VALUES(quantity),trade_bound_quantity=trade_bound_quantity+VALUES(trade_bound_quantity),personal_bound_quantity=personal_bound_quantity+VALUES(personal_bound_quantity),stored_at=NOW()", [
		home.id,
		item.item_id,
		quantity,
		binding.trade,
		binding.personal
	]);
	await recordCharacterOperation(connection, {
		characterId: Number(character.id),
		kind: "home.storage_deposited",
		source: {
			system: "home_storage_deposit",
			id: randomUUID(),
			step: "settled"
		},
		outcome: "存入",
		summary: `向家园仓储存入${item.name} ×${quantity}`,
		detail: {
			homeId: Number(home.id),
			itemId: Number(item.item_id),
			itemName: item.name,
			quantity,
			binding
		}
	});
	return quote;
};
const depositHomeStorage = async (qqUserId, itemId, quantity) => withTransaction((connection) => depositHomeStorageInTransaction(connection, qqUserId, itemId, quantity));
const assertHomeStorageWithdrawalFree = async (connection, character) => {
	if (character.activity_status !== "active") throw new Error("当前状态无法从家园仓储取出物品。");
	const [travel] = await connection.execute("SELECT 1 FROM player_travels WHERE character_id=? LIMIT 1", [character.id]);
	if (travel[0]) throw new Error("旅行途中无法从家园仓储取出物品。");
	const [mining] = await connection.execute("SELECT 1 FROM player_resource_mining WHERE character_id=? LIMIT 1", [character.id]);
	if (mining[0]) throw new Error("开采尚未结束，无法从家园仓储取出物品。");
	const [combat] = await connection.execute(`SELECT 1 FROM combat_sessions cs
    LEFT JOIN combat_members cm ON cm.session_id=cs.id
    WHERE cs.state='active' AND (cs.character_id=? OR cm.character_id=?) LIMIT 1`, [character.id, character.id]);
	if (combat[0]) throw new Error("战斗中无法从家园仓储取出物品。");
	const [pvp] = await connection.execute(`SELECT 1 FROM player_pvp_battle_sessions
    WHERE state='active' AND (attacker_character_id=? OR defender_character_id=?) LIMIT 1`, [character.id, character.id]);
	if (pvp[0]) throw new Error("玩家对战中无法从家园仓储取出物品。");
};
/** 仓储绑定份额与背包发放处于同一事务；拆掉最后一个箱子后仍可取回旧物。 */
const withdrawHomeStorageInTransaction = async (connection, qqUserId, itemId, quantity, preview = false) => {
	if (!Number.isSafeInteger(itemId) || itemId < 1 || !Number.isSafeInteger(quantity) || quantity < 1) throw new Error("物品编号和数量必须为正整数。");
	const character = await characterFor(connection, qqUserId, true);
	const home = await homeFor(connection, Number(character.id), true);
	if (!home) throw new Error("你还没有小屋。");
	await assertHomeStorageWithdrawalFree(connection, character);
	const [rows] = await connection.execute(`SELECT hs.item_id,i.name,i.weight,i.stackable,hs.quantity,hs.trade_bound_quantity,hs.personal_bound_quantity,
    CASE WHEN i.is_tradeable=0 OR i.item_category IN ('任务','剧情') OR JSON_EXTRACT(i.effect_json,'$.personalOnly')=true THEN 1 ELSE 0 END AS inherently_personal
    FROM player_home_storage_items hs JOIN item_definitions i ON i.id=hs.item_id
    WHERE hs.home_id=? AND hs.item_id=? AND hs.quantity>0 FOR UPDATE`, [home.id, itemId]);
	const item = rows[0];
	if (!item || !Number(item.stackable)) throw new Error("仓储中没有可取出的该堆叠物品。");
	if (Number(item.quantity) < quantity) throw new Error(`仓储数量不足，当前仅有 ${item.quantity} 个。`);
	const bindingBefore = {
		unbound: Number(item.quantity) - Number(item.trade_bound_quantity) - Number(item.personal_bound_quantity),
		trade: Number(item.trade_bound_quantity),
		personal: Number(item.personal_bound_quantity)
	};
	const bindingUsed = consumeBinding(bindingBefore, quantity);
	const bindingReturned = Number(item.inherently_personal) ? {
		unbound: 0,
		trade: 0,
		personal: quantity
	} : bindingUsed;
	const capacity = await homeStorageCapacityFor(connection, Number(home.id));
	const usedWeight = await homeStorageWeightFor(connection, Number(home.id));
	const removedWeight = Number(item.weight) * quantity;
	const quote = {
		side: "withdraw",
		homeId: Number(home.id),
		itemId: Number(item.item_id),
		name: item.name,
		quantity,
		ownedBefore: Number(item.quantity),
		weightEach: Number(item.weight),
		removedWeight,
		usedWeightBefore: usedWeight,
		usedWeightAfter: Math.max(0, usedWeight - removedWeight),
		usedWeight: Math.max(0, usedWeight - removedWeight),
		capacity,
		bindingBefore,
		bindingUsed,
		bindingReturned
	};
	if (preview) return quote;
	const [updated] = await connection.execute(`UPDATE player_home_storage_items SET
    quantity=quantity-?,trade_bound_quantity=trade_bound_quantity-?,personal_bound_quantity=personal_bound_quantity-?
    WHERE home_id=? AND item_id=? AND quantity>=? AND trade_bound_quantity>=? AND personal_bound_quantity>=?
      AND quantity-trade_bound_quantity-personal_bound_quantity>=?`, [
		quantity,
		bindingUsed.trade,
		bindingUsed.personal,
		home.id,
		item.item_id,
		quantity,
		bindingUsed.trade,
		bindingUsed.personal,
		bindingUsed.unbound
	]);
	if (Number(updated.affectedRows) !== 1) throw new Error("仓储数量或绑定状态已变化，请重新预览。");
	await connection.execute("DELETE FROM player_home_storage_items WHERE home_id=? AND item_id=? AND quantity=0", [home.id, item.item_id]);
	await grantInventory(connection, Number(character.id), Number(item.item_id), bindingReturned);
	await recordCharacterOperation(connection, {
		characterId: Number(character.id),
		kind: "home.storage_withdrawn",
		source: {
			system: "home_storage_withdraw",
			id: randomUUID(),
			step: "settled"
		},
		outcome: "取出",
		summary: `从家园仓储取出${item.name} ×${quantity}`,
		detail: {
			homeId: Number(home.id),
			itemId: Number(item.item_id),
			itemName: item.name,
			quantity,
			bindingUsed,
			bindingReturned
		}
	});
	return quote;
};
const withdrawHomeStorage = async (qqUserId, itemId, quantity) => withTransaction((connection) => withdrawHomeStorageInTransaction(connection, qqUserId, itemId, quantity));

//#endregion
export { craftFurniture, depositHomeStorage, depositHomeStorageInTransaction, enterHome, expandHome, homeOverview, homePanel, homePurchaseSite, homeRestExperiencePerMinute, homeRestRecoveryBonus, homeShopOfferDetail, homeStorageView, isInHome, leaveHome, listFurniture, listHomeShop, previewHomePurchaseInTransaction, purchaseHome, purchaseHomeInTransaction, removeFurniture, renameHome, requireHomeShopTarget, tradeHomeOffer, tradeHomeOfferInTransaction, upgradeHome, withdrawHomeStorage, withdrawHomeStorageInTransaction };