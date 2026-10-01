import { experienceRequiredForLevel } from "../game/constants.js";
import { registeredAdvancedProfessionByCode } from "../game/advanced-profession.config.js";
import { getCharacter } from "../game/character.service.js";
import { getPool } from "../database/pool.js";
import { appStoryIllustrationFor } from "../game/story-illustrations.js";
import { formatToAppMessage, plainAppMessage } from "./app-format.js";
import { enterDungeon } from "../game/dungeon.service.js";
import { battleStatus, cancelResourceMining, chooseTarget, combatAction, continueForestArrival, coordinateInteraction, currentEncounter, equip, equipment, equipmentDetail, explore, forestGuideAdvance, forestGuideChoice, forestGuideProgress, forestGuideSnapshot, inventoryView, learnSkill, leaveParty, mineResource, move, moveTo, moveToMap, moveToNearbyMonster, movementProfile, negotiateEncounter, partyInfo, requireNpcAtCurrentPosition, resourceMiningStatus, resumeAction, skillDetail, skillList, startRest, switchCombatTarget, talkToNpc, toggleSkillShortcut, travelStatus, unequip, upgradeSkill } from "../game/adventure.service.js";
import { appSessionQqUser } from "../game/app-channel.service.js";
import { autoBattleConfig, setAutoBattleEnabled, setAutoPotionEnabled, setAutoPotionItem, setAutoPotionThreshold, toggleAutoBattleEncounterAction } from "../game/auto-battle.service.js";
import { messageFormat } from "../game/message.js";
import { divineCatalog, divineDetail, registrationScene } from "../game/divine-message.js";
import { Format } from "alemonjs";

//#region src/app-api/app-command.service.ts
const openingText = async (view, reply = "我陪你把这段初行走完。") => formatToAppMessage((await import("../game/opening-message.js")).openingFormat(view), reply);
const menuText = async (page) => {
	const { menuCardImage } = await import("../game/menu-card.service.js");
	const buttons = Format.createButtonGroup().addRow().addButton("核心功能", "/菜单", {
		type: "command",
		autoEnter: true,
		style: page === 1 ? "blue" : void 0
	}).addButton("进阶功能", "/菜单 进阶", {
		type: "command",
		autoEnter: true,
		style: page === 2 ? "blue" : void 0
	}).addButton("面板", "/面板", {
		type: "command",
		autoEnter: true
	}).addButton("角色", "/角色", {
		type: "command",
		autoEnter: true
	}).addButton("任务", "/任务", {
		type: "command",
		autoEnter: true
	});
	return formatToAppMessage(Format.create().addImage(await menuCardImage(page)).addButtonGroup(buttons), page === 1 ? "常用功能都整理在这里。" : "进阶功能都整理在这里。");
};
const forestChapterText = (stage, text) => {
	const buttons = [];
	if (stage === 1) buttons.push({
		label: "循声而去",
		command: "/初章 包容之镇 循声而去"
	});
	if (stage === 2) buttons.push({
		label: "上前打招呼",
		command: "/初章 包容之镇 上前打招呼"
	});
	if (stage === 3) buttons.push({
		label: "说明来历",
		command: "/初章 包容之镇 我也不清楚，睁开眼时就在这儿了"
	});
	if (stage === 4) {
		buttons.push({
			label: "加入队伍",
			command: "/初章 包容之镇 加入"
		});
		buttons.push({
			label: "婉拒并问路",
			command: "/初章 包容之镇 婉拒并询问城镇位置"
		});
	}
	return {
		...plainAppMessage(`【初章·包容之镇（${stage}/5）】\n\n${text}`, buttons, "我陪你把这段相遇走完。"),
		storyImage: appStoryIllustrationFor(`forest.guide.${stage}`)
	};
};
const townArrivalText = (story) => {
	if (story.completed || story.arrivalBuilding) return plainAppMessage(`${story.text}\n\n你已经抵达冒险者公会柜台。`, [{
		label: "进入公会",
		command: "/初行入会"
	}, {
		label: "查看状态",
		command: "/状态"
	}], "公会就在眼前，先进去登记吧。");
	return {
		...plainAppMessage(`【${story.chapter === "guild" ? "初临·梨子带路" : "初临·百纳镇"}（${story.stage}）】\n\n${story.text}`, [{
			label: "继续剧情",
			command: "/继续剧情"
		}], "跟紧脚步，很快就到公会了。"),
		storyImage: appStoryIllustrationFor(`forest.${story.chapter === "guild" ? "guild" : "town"}.${story.stage}`)
	};
};
const continueJourneyText = async (user) => {
	const { openingStatus, beginOpening } = await import("../game/opening.service.js");
	const opening = await openingStatus(user);
	if (opening && opening.state !== "completed") return openingText(opening.state === "armed" ? await beginOpening(user) ?? opening : opening);
	const guide = await forestGuideProgress(user);
	if (guide?.status === "met" && guide.stage >= 1 && guide.stage <= 4) {
		const snapshot = await forestGuideSnapshot(user);
		if (snapshot) return forestChapterText(snapshot.stage, snapshot.text);
	}
	if (guide?.status === "joined" || guide?.status === "declined") return battleText(user, []);
	const story = await continueForestArrival(user);
	return townArrivalText(story);
};
const forestGuideChoiceText = async (user, action) => {
	const result = await forestGuideAdvance(user, action);
	if (!result.battleChoice) return forestChapterText(result.stage, result.text);
	const battle = await forestGuideChoice(user, result.battleChoice);
	await chooseTarget(user, battle.spawnId);
	return plainAppMessage(`${battle.text}\n\n剧情战斗已经开始。`, [
		{
			label: "查看战斗",
			command: "/战斗"
		},
		{
			label: "攻击",
			command: "/战斗 攻击"
		},
		{
			label: "防御",
			command: "/战斗 防御"
		}
	], "小心应战，胜利后点击继续剧情。");
};
const battleActionMessage = async (user, text, petReply) => {
	const buttons = (await forestGuideProgress(user).catch(() => null))?.status === "awaiting_arrival" ? [{
		label: "继续剧情",
		command: "/继续剧情"
	}, {
		label: "状态",
		command: "/状态"
	}] : [
		{
			label: "战斗状态",
			command: "/战斗"
		},
		{
			label: "攻击",
			command: "/战斗 攻击"
		},
		{
			label: "防御",
			command: "/战斗 防御"
		}
	];
	return plainAppMessage(text, buttons, petReply);
};
const openingChoiceText = async (user, revision, action) => {
	const { advanceOpening } = await import("../game/opening.service.js");
	const result = await advanceOpening(user, revision, action);
	if (result.forestBattleChoice) {
		const forest = await forestGuideChoice(user, result.forestBattleChoice);
		await chooseTarget(user, forest.spawnId);
		return plainAppMessage(`${forest.text}\n\n剧情战斗已经开始。`, [
			{
				label: "查看战斗",
				command: "/战斗"
			},
			{
				label: "攻击",
				command: "/战斗 攻击"
			},
			{
				label: "防御",
				command: "/战斗 防御"
			}
		], "小心应战，胜利后点击继续剧情。");
	}
	if (result.state === "completed") return plainAppMessage("初行故事完成，你已经抵达冒险者公会。", [{
		label: "状态",
		command: "/状态"
	}, {
		label: "进入公会",
		command: "/初行公会"
	}], "欢迎来到新的起点。");
	return openingText(result);
};
const characterText = async (qqUserId) => {
	const character = await getCharacter(qqUserId);
	if (!character) return plainAppMessage("你还没有创建角色。发送“注册”开始异世界之旅。", [{
		label: "注册",
		command: "/注册"
	}]);
	return formatToAppMessage(messageFormat("角色", [
		`昵称：${character.name}`,
		`性别：${character.gender === "男" ? "♂" : character.gender === "女" ? "♀" : "未设定"}`,
		`等级：Lv.${character.level}`,
		`职业：${character.professionName ?? "未选择"}`,
		`经验：${character.experience}`,
		`生命：${Math.round(character.currentHp)}/${Math.round(character.hpMax)}`,
		`魔力：${Math.round(character.currentMp)}/${Math.round(character.mpMax)}`,
		`体力：${Math.round(character.stamina)}/${Math.round(character.staminaMax)}`,
		`位置：${character.regionName} (${character.x}, ${character.y}, ${character.z})`,
		`天赋：${character.giftName ?? "无"}`
	].join("\n")), "今天也要一起出发吗？");
};
const attributesText = async (qqUserId) => {
	const character = await getCharacter(qqUserId);
	if (!character) return plainAppMessage("你还没有创建角色。请先完成注册剧情。", [{
		label: "注册",
		command: "/注册"
	}]);
	const lines = [
		"【基础属性】",
		`体质：${character.constitution}　精神：${character.spirit}`,
		`力量：${character.strength}　智力：${character.intelligence}`,
		`敏捷：${character.agility}　感知：${character.perception}`,
		"",
		`物攻：${Math.round(character.physicalAttack)}　魔攻：${Math.round(character.magicAttack)}`,
		`物防：${Math.round(character.physicalDefense)}　魔防：${Math.round(character.magicDefense)}`,
		`命中：${Math.round(character.accuracy)}　闪避：${Math.round(character.evasion)}　速度：${Math.round(character.speed)}`
	];
	return plainAppMessage(lines.join("\n"), [{
		label: "角色",
		command: "/角色"
	}, {
		label: "天赋",
		command: "/天赋"
	}], "属性面板整理好了。");
};
const talentText = async (qqUserId) => {
	const character = await getCharacter(qqUserId);
	if (!character) return plainAppMessage("你还没有创建角色。请先完成注册剧情。", [{
		label: "注册",
		command: "/注册"
	}]);
	return plainAppMessage(`【天赋 / 恩赐】\n当前恩赐：${character.giftName ?? "未选择"}\n\n注册剧情中的恩赐选择会直接绑定到角色。`, [{
		label: "属性",
		command: "/属性"
	}, {
		label: "角色",
		command: "/角色"
	}], "这份恩赐会陪你走很远。");
};
const inventoryText = async (qqUserId, category) => {
	const view = await inventoryView(qqUserId, category);
	const lines = [`【背包${category ? `·${category}` : ""}】`];
	if (view.stacked.length) {
		lines.push("", "可堆叠物品：");
		lines.push(...view.stacked.slice(0, 20).map((item) => `${item.name} ×${item.quantity}`));
	}
	if (view.instances.length) {
		lines.push("", "装备与实例：");
		lines.push(...view.instances.slice(0, 20).map((item) => `${item.name}（${item.quality}%）`));
	}
	const recent = category ? view.recent.filter((item) => item.item_type === (category === "装备" ? "equipment" : category === "道具" ? "consumable" : "material")) : view.recent;
	if (recent.length) {
		lines.push("", "最近获得：");
		lines.push(...recent.slice(0, 5).map((item) => item.name));
	}
	if (lines.length === 1) lines.push("背包空空如也。");
	return plainAppMessage(lines.join("\n"), [
		{
			label: "装备",
			command: "/背包 装备"
		},
		{
			label: "道具",
			command: "/背包 道具"
		},
		{
			label: "材料",
			command: "/背包 材料"
		}
	], "你的行囊我帮你记着。");
};
const exploreText = async (qqUserId) => {
	const { openingStatus, beginOpening } = await import("../game/opening.service.js");
	const opening = await openingStatus(qqUserId);
	if (opening && opening.state !== "completed") {
		if (opening.state === "armed") return openingText(await beginOpening(qqUserId, "hunt") ?? opening);
		return openingText(opening);
	}
	const result = await explore(qqUserId);
	const lines = [result.text];
	if (result.spawns.length) {
		lines.push("", "发现：");
		lines.push(...result.spawns.map((spawn) => `#${spawn.id} ${spawn.name} Lv.${spawn.level}`));
	}
	const buttons = result.spawns.length ? [{
		label: "目标",
		command: `/目标 ${result.spawns[0].id}`
	}] : [];
	return plainAppMessage(lines.join("\n"), buttons, result.spawns.length ? "前面有动静。" : "暂时没有敌人。");
};
const moveText = async (qqUserId, direction) => {
	const { openingStatus, beginOpening } = await import("../game/opening.service.js");
	const opening = await openingStatus(qqUserId);
	if (opening && opening.state !== "completed") {
		if (opening.state === "armed") return openingText(await beginOpening(qqUserId, "move") ?? opening);
		return openingText(opening);
	}
	const text = (await move(qqUserId, direction)).text ?? "你移动了一步。";
	return plainAppMessage(text, [], "我跟着你走。");
};
const mapTravelText = async (qqUserId, mapCode) => {
	const result = await moveToMap(qqUserId, mapCode);
	const text = "text" in result && result.text ? String(result.text) : "你开始前往目标地点。";
	return plainAppMessage(text, [], "路上小心。");
};
/**
* H5 地图概览只返回当前角色与队友所在区域的公开地图标识。
* 实际可达性仍由 moveToLocalCoordinate / 游戏移动服务校验，
* 这里的边界和地标仅用于绘图，不能作为客户端的权限依据。
*/
const mapDataFor = async (character, qqUserId) => {
	const pool = await getPool();
	const [rows] = await pool.execute("SELECT code,name,danger_level,min_x,max_x,min_y,max_y,min_z,max_z FROM map_regions WHERE is_enabled=1 ORDER BY id");
	const partyMembers = [];
	let characterId;
	if (qqUserId) {
		const [characterRows] = await pool.execute(`SELECT c.id
      FROM characters c JOIN players p ON p.id=c.player_id WHERE p.qq_user_id=? LIMIT 1`, [qqUserId]);
		characterId = characterRows[0] ? Number(characterRows[0].id) : void 0;
	}
	if (characterId !== void 0) {
		const [memberRows] = await pool.execute(`SELECT c.id,c.game_id,c.name,p.leader_character_id,
        r.code AS region_code,r.name AS region_name,c.pos_x,c.pos_y,c.pos_z
      FROM party_members pm
      JOIN parties p ON p.id=pm.party_id
      JOIN characters c ON c.id=pm.character_id
      JOIN map_regions r ON r.id=c.current_region_id
      WHERE pm.party_id=(SELECT party_id FROM party_members WHERE character_id=? LIMIT 1)
      ORDER BY pm.joined_at,c.id`, [characterId]);
		for (const row of memberRows) partyMembers.push({
			id: Number(row.id),
			gameId: Number(row.game_id),
			name: String(row.name),
			isLeader: Number(row.id) === Number(row.leader_character_id),
			isSelf: Number(row.id) === Number(characterId),
			regionCode: String(row.region_code),
			regionName: String(row.region_name),
			x: Number(row.pos_x),
			y: Number(row.pos_y),
			z: Number(row.pos_z)
		});
	}
	const currentRegion = rows.find((row) => String(row.name) === String(character.regionName));
	if (!partyMembers.length) partyMembers.push({
		id: Number(characterId ?? 0),
		gameId: Number(character.gameId ?? 0),
		name: String(character.name),
		isLeader: true,
		isSelf: true,
		regionCode: String(currentRegion?.code ?? ""),
		regionName: String(character.regionName ?? ""),
		x: Number(character.x),
		y: Number(character.y),
		z: Number(character.z)
	});
	const focusCodes = [...new Set(partyMembers.map((member) => member.regionCode).filter(Boolean))];
	const landmarks = [];
	if (focusCodes.length) {
		const placeholders = focusCodes.map(() => "?").join(",");
		const [buildingRows] = await pool.execute(`SELECT n.code,n.name,r.code AS region_code,r.name AS region_name,n.pos_x AS x,n.pos_y AS y,n.pos_z AS z
      FROM map_npcs n JOIN map_regions r ON r.id=n.region_id
      WHERE n.interaction_kind='building' AND r.code IN (${placeholders})`, focusCodes);
		landmarks.push(...buildingRows.map((row) => ({
			code: String(row.code),
			name: String(row.name),
			type: "building",
			regionCode: String(row.region_code),
			regionName: String(row.region_name),
			x: Number(row.x),
			y: Number(row.y),
			z: Number(row.z)
		})));
		const [objectRows] = await pool.execute(`SELECT o.code,o.name,r.code AS region_code,r.name AS region_name,o.pos_x AS x,o.pos_y AS y,o.pos_z AS z
      FROM map_special_objects o JOIN map_regions r ON r.id=o.region_id
      WHERE r.code IN (${placeholders})`, focusCodes);
		landmarks.push(...objectRows.map((row) => ({
			code: String(row.code),
			name: String(row.name),
			type: "landmark",
			regionCode: String(row.region_code),
			regionName: String(row.region_name),
			x: Number(row.x),
			y: Number(row.y),
			z: Number(row.z)
		})));
	}
	return {
		current: {
			name: String(character.regionName ?? ""),
			x: Number(character.x),
			y: Number(character.y),
			z: Number(character.z)
		},
		maps: rows.map((row) => ({
			code: String(row.code),
			name: String(row.name),
			danger: Number(row.danger_level),
			isCurrent: String(row.name) === String(character.regionName),
			bounds: {
				minX: Number(row.min_x),
				maxX: Number(row.max_x),
				minY: Number(row.min_y),
				maxY: Number(row.max_y),
				minZ: Number(row.min_z),
				maxZ: Number(row.max_z)
			}
		})),
		partyMembers,
		landmarks
	};
};
const mapText = async (qqUserId) => {
	const character = await getCharacter(qqUserId);
	if (!character) return plainAppMessage("你还没有角色。请先完成注册剧情。", [{
		label: "注册",
		command: "/注册"
	}]);
	const mapData = await mapDataFor(character, qqUserId);
	const lines = [
		`当前位置：${character.regionName} (${character.x}, ${character.y}, ${character.z})`,
		"",
		"已知地图："
	];
	lines.push(...mapData.maps.map((row) => `${row.isCurrent ? "●" : "○"} ${row.name}（${row.code}，危险度 ${row.danger}）`));
	return {
		...plainAppMessage(lines.join("\n"), mapData.maps.filter((row) => !row.isCurrent).slice(0, 8).map((row) => ({
			label: `前往 ${row.name}`,
			command: `/地图前往 ${row.code}`
		})), "地图已经接入，先确认好路线。"),
		mapData
	};
};
const moveToCoordinateText = async (qqUserId, x, y, z) => {
	const result = await moveTo(qqUserId, x, y, z);
	if ("text" in result && result.text) return plainAppMessage(String(result.text), [{
		label: "查看面板",
		command: "/面板"
	}], "路线已经安排好了。");
	if (result.kind === "travel") return plainAppMessage(`已规划前往坐标（${x}, ${y}, ${z}），预计 ${result.seconds} 秒。`, [{
		label: "查看面板",
		command: "/面板"
	}], "路上小心。");
	return plainAppMessage(`已抵达坐标（${x}, ${y}, ${z}）。`, [{
		label: "查看面板",
		command: "/面板"
	}], "到了。");
};
const moveToNearbyMonsterText = async (qqUserId, spawnId) => {
	const result = await moveToNearbyMonster(qqUserId, spawnId);
	return plainAppMessage(result.canAmbush ? "已抵达目标位置，可以开始战斗或伏击。" : "已抵达目标位置，可以开始战斗。", [{
		label: "战斗",
		command: "/战斗"
	}, {
		label: "查看面板",
		command: "/面板"
	}], "找到它了。");
};
const statusText = async (qqUserId) => {
	const [character, travel, encounter] = await Promise.all([
		getCharacter(qqUserId),
		travelStatus(qqUserId),
		currentEncounter(qqUserId).catch(() => null)
	]);
	const lines = [];
	if (character) {
		lines.push(`角色：${character.name} Lv.${character.level}`);
		lines.push(`位置：${character.regionName} (${character.x}, ${character.y}, ${character.z})`);
		lines.push(`状态：${character.activityStatus === "active" ? "行动中" : character.activityStatus === "resting" ? "休息中" : character.activityStatus}`);
	}
	if (travel) lines.push(`行程：正在前往${travel.destinationName ?? travel.regionName}，剩余 ${travel.remaining} 秒`);
	if (encounter?.spawns?.length) lines.push(`遭遇：${encounter.spawns.map((spawn) => spawn.name).join("、")}`);
	if (!lines.length) lines.push("你还没有角色。发送“注册”开始冒险。");
	return plainAppMessage(lines.join("\n"), [
		{
			label: "角色",
			command: "/角色"
		},
		{
			label: "背包",
			command: "/背包"
		},
		{
			label: "探索",
			command: "/探索"
		}
	], "这是现在的旅途。");
};
const restText = async (qqUserId, command) => {
	if (command.includes("起床") || command.includes("继续")) {
		const result = await resumeAction(qqUserId);
		return plainAppMessage(result.message, [], "休息好了。");
	}
	const result = await startRest(qqUserId);
	return plainAppMessage(result.message, [{
		label: "起床",
		command: "/起床"
	}], "你休息吧，我守夜。");
};
const battleText = async (qqUserId, args) => {
	const battle = await battleStatus(qqUserId);
	const action = args[0] ?? "";
	if (action === "攻击" || action === "普攻" || action === "atk") {
		const result = await combatAction(qqUserId, "attack");
		return battleActionMessage(qqUserId, result.log ?? "你发起了攻击。", "上了！");
	}
	if (action === "防御" || action === "defend") {
		const result = await combatAction(qqUserId, "defend");
		return battleActionMessage(qqUserId, result.log ?? "你进入防御。", "稳住。");
	}
	if (action === "逃跑" || action === "escape") {
		const result = await combatAction(qqUserId, "escape");
		return battleActionMessage(qqUserId, result.log ?? "你尝试脱离战斗。", "跑得掉就跑！");
	}
	if (action === "道具" || action === "item") {
		const itemId = Number(args[1] ?? 0);
		if (itemId > 0) {
			const result = await combatAction(qqUserId, "item", void 0, void 0, itemId);
			return battleActionMessage(qqUserId, result.log ?? "你使用了战斗道具。", "补给跟上！");
		}
		const items = (await inventoryView(qqUserId, "道具")).stacked.slice(0, 8);
		return plainAppMessage(items.length ? `【战斗道具】\n${items.map((item) => `${item.name} ×${item.quantity}`).join("\n")}` : "没有可用的战斗道具。", items.map((item) => ({
			label: `使用 ${item.name}`,
			command: `/战斗 道具 ${item.id}`
		})), "选一个合适的道具吧。");
	}
	if (/^\d+$/.test(action)) {
		const slot = Number(action);
		const result = await combatAction(qqUserId, "skill", slot);
		return battleActionMessage(qqUserId, result.log ?? `你使用了技能 ${slot}。`, "这一手漂亮！");
	}
	const lines = [
		battle.targets.length ? `目标：${battle.targets.map((target) => target.name).join("、")}` : "战斗中没有目标。",
		`我方 HP：${battle.playerHp}/${battle.playerHpMax}｜MP：${battle.playerMp}/${battle.playerMpMax}`,
		battle.turn ? `回合：${battle.turn}` : ""
	].filter(Boolean);
	return plainAppMessage(lines.join("\n"), [
		{
			label: "攻击",
			command: "/战斗 攻击"
		},
		{
			label: "防御",
			command: "/战斗 防御"
		},
		{
			label: "逃跑",
			command: "/战斗 逃跑"
		}
	], "战斗还没结束。");
};
/**
* 将本体交涉结果转换为 App/H5 可消费的消息，同时保留完整 negotiation
* 对象。网页优先使用独立 /negotiation API；命令入口保留同一份状态，
* 方便桌宠、旧版 H5 和 QQ 按钮继续共用 sessionId/revision 防重放规则。
*/
const negotiationAppMessage = async (result) => {
	const { negotiationFormat } = await import("../response/negotiation.js");
	return {
		...formatToAppMessage(negotiationFormat(result), "先观察它的反应，再决定下一步。"),
		negotiation: result
	};
};
const negotiationActionType = (raw) => {
	const action = raw.trim();
	if (action === "交谈" || action === "talk") return "talk";
	if (action === "开战" || action === "战斗" || action === "fight") return "fight";
	if (action === "离开" || action === "结束" || action === "leave") return "leave";
};
const negotiationViewText = async (qqUserId, args) => {
	const spawnId = Number(args[0] ?? 0);
	if (!Number.isSafeInteger(spawnId) || spawnId <= 0) return plainAppMessage("交涉需要怪物编号：/交涉 <编号>", [], "告诉我想接近哪个目标。");
	const sessionId = String(args[1] ?? "").trim();
	const page = Number(args[2] ?? 1);
	const keyword = args.slice(3).join(" ").trim();
	const command = {
		type: "view",
		...sessionId ? { sessionId } : {},
		...Number.isSafeInteger(page) && page > 0 ? { page } : {},
		...keyword ? { keyword } : {}
	};
	return negotiationAppMessage(await negotiateEncounter(qqUserId, spawnId, command));
};
const negotiationActionText = async (qqUserId, args) => {
	const spawnId = Number(args[0] ?? 0);
	const sessionId = String(args[1] ?? "").trim();
	const revision = Number(args[2] ?? NaN);
	const type = negotiationActionType(String(args[3] ?? ""));
	if (!Number.isSafeInteger(spawnId) || spawnId <= 0 || !sessionId || !Number.isSafeInteger(revision) || revision < 0 || !type) return plainAppMessage("交涉行动参数无效：/交涉行动 <怪物编号> <会话编号> <版本> <交谈|开战|离开>", [], "请从当前交涉面板重新操作。");
	const result = await negotiateEncounter(qqUserId, spawnId, {
		type,
		sessionId,
		revision
	});
	return negotiationAppMessage(result);
};
/** 先展示物品确认，实际消耗由 /交涉交付 复用本体事务完成。 */
const negotiationItemText = async (qqUserId, args) => {
	const spawnId = Number(args[0] ?? 0);
	const sessionId = String(args[1] ?? "").trim();
	const revision = Number(args[2] ?? NaN);
	const itemId = Number(args[3] ?? 0);
	const quantity = Number(args[4] ?? 1);
	if (!Number.isSafeInteger(spawnId) || spawnId <= 0 || !sessionId || !Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(itemId) || itemId <= 0 || !Number.isSafeInteger(quantity) || quantity < 1) return plainAppMessage("交涉物品参数无效，请从当前交涉面板重新选择。", [], "物品信息已经过期。");
	const viewed = await negotiateEncounter(qqUserId, spawnId, {
		type: "view",
		sessionId,
		page: 1,
		keyword: String(itemId)
	});
	if (viewed.kind !== "ongoing") return negotiationAppMessage(viewed);
	const item = viewed.inventory.items.find((entry) => Number(entry.id) === itemId);
	if (!item || quantity > Number(item.available)) throw new Error("交付数量无效或未绑定数量不足。");
	const text = `向【${viewed.name}】交付：${item.name} ×${quantity}\n可用数量：${item.available}\n类别：${item.policy.subtype}\n\n确认后才会交由本体交涉规则判定，拒收物品不会被扣除。`;
	return {
		...plainAppMessage(text, [{
			label: "确认交付",
			command: `/交涉交付 ${spawnId} ${sessionId} ${viewed.revision} ${itemId} ${quantity}`
		}, {
			label: "返回交涉",
			command: `/交涉分页 ${spawnId} ${sessionId} 1`
		}], "要把这份礼物交给它吗？"),
		negotiation: viewed
	};
};
const negotiationGiftText = async (qqUserId, args) => {
	const spawnId = Number(args[0] ?? 0);
	const sessionId = String(args[1] ?? "").trim();
	const revision = Number(args[2] ?? NaN);
	const itemId = Number(args[3] ?? 0);
	const quantity = Number(args[4] ?? 1);
	if (!Number.isSafeInteger(spawnId) || spawnId <= 0 || !sessionId || !Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(itemId) || itemId <= 0 || !Number.isSafeInteger(quantity) || quantity < 1) return plainAppMessage("交涉交付参数无效，请从当前交涉面板重新选择。", [], "物品信息已经过期。");
	return negotiationAppMessage(await negotiateEncounter(qqUserId, spawnId, {
		type: "gift",
		sessionId,
		revision,
		itemId,
		quantity
	}));
};
const equipmentText = async (qqUserId) => {
	const items = await equipment(qqUserId);
	if (!items.length) return plainAppMessage("你还没有穿戴任何装备。", [{
		label: "背包",
		command: "/背包 装备"
	}], "空荡荡的，去背包看看吧。");
	const slotNames = {
		weapon: "武器",
		offhand: "副手",
		shoulder: "头肩",
		upper: "上装",
		waist: "腰部",
		lower: "下装",
		feet: "脚部",
		necklace: "项链",
		bracelet: "手镯",
		ring: "戒指"
	};
	const lines = ["【我的装备】"];
	for (const item of items) lines.push(`${slotNames[item.slot] ?? item.slot}：${item.name}${item.appearanceName && item.appearanceName !== item.name ? `（外观：${item.appearanceName}）` : ""}`);
	return plainAppMessage(lines.join("\n"), [{
		label: "背包",
		command: "/背包"
	}, {
		label: "技能",
		command: "/技能"
	}], "这一身很适合你。");
};
const equipmentDetailText = async (qqUserId, id) => {
	const item = await equipmentDetail(qqUserId, id);
	const lines = [
		`【${item.name}】`,
		`部位：${item.item_category}`,
		`稀有度：${item.rarity}`,
		`等级：${item.required_level}`,
		`品质：${item.quality}%`,
		`耐久：${item.durability}/${item.durability_max}`
	];
	if (item.description) lines.push(`说明：${item.description}`);
	return plainAppMessage(lines.join("\n"), [{
		label: "装备",
		command: "/装备"
	}], "这是你的伙伴。");
};
const equipText = async (qqUserId, slot, id) => {
	const item = await equip(qqUserId, slot, id);
	return plainAppMessage(`已装备【${item.name}】。`, [{
		label: "装备",
		command: "/装备"
	}], "穿好了。");
};
const unequipText = async (qqUserId, slot) => {
	const item = await unequip(qqUserId, slot);
	return plainAppMessage(`已卸下【${item.name}】。`, [{
		label: "装备",
		command: "/装备"
	}], "收好了。");
};
const skillsText = async (qqUserId, view, id) => {
	if (id) {
		const skill = await skillDetail(qqUserId, id);
		const lines = [
			`【${skill.name}】Lv.${skill.level}`,
			`类别：${skill.category}｜${skill.tier}`,
			`法力：${skill.actualManaCost}｜冷却：${skill.actualCooldown}回合`,
			`威力：${skill.actualPower}`,
			skill.description ? `说明：${skill.description}` : ""
		];
		const buttons = skill.learned ? [{
			label: "升级",
			command: `/升级技能 ${skill.id}`
		}, {
			label: "快捷",
			command: `/技能快捷 ${skill.id}`
		}] : [{
			label: "学习",
			command: `/学习技能 ${skill.id}`
		}];
		return plainAppMessage(lines.filter(Boolean).join("\n"), buttons, "这是你的力量。");
	}
	const data = await skillList(qqUserId);
	const source = view === "未学习" ? data.discoveries : data.skills;
	const lines = [
		`【技能列表·${view}】`,
		`技能点：${data.skillPoints}`,
		""
	];
	if (!source.length) lines.push(view === "未学习" ? "没有可学习的技能。" : "还没有学会任何技能。");
	for (const skill of source.slice(0, 12)) lines.push(`#${skill.id} ${skill.name}${"level" in skill && skill.level ? ` Lv.${skill.level}` : ""}${"category" in skill && skill.category === "passive" ? "（被动）" : ""}`);
	const detailButtons = source.slice(0, 4).map((skill) => ({
		label: `查看 ${skill.name}`,
		command: `/技能详情 ${skill.id}`
	}));
	return plainAppMessage(lines.join("\n"), [
		{
			label: "已学习",
			command: "/技能 已学习"
		},
		{
			label: "未学习",
			command: "/技能 未学习"
		},
		...detailButtons
	], "想学点什么？");
};
const learnSkillText = async (qqUserId, id) => {
	const result = await learnSkill(qqUserId, id);
	return plainAppMessage(`已学会【${result.name}】${result.cost ? `，消耗 ${result.cost} 技能点。` : "。"}`, [{
		label: "技能",
		command: "/技能"
	}], "又变强了一点。");
};
const upgradeSkillText = async (qqUserId, id) => {
	const result = await upgradeSkill(qqUserId, id);
	return plainAppMessage(`【${result.name}】升至 Lv.${result.level}，消耗 ${result.cost} 技能点。`, [{
		label: "技能",
		command: "/技能"
	}], "越来越熟练了。");
};
const toggleShortcutText = async (qqUserId, id) => {
	const result = await toggleSkillShortcut(qqUserId, id);
	return plainAppMessage(result.slot ? `已将【${result.name}】放入快捷栏 ${result.slot}。` : `已从快捷栏移除【${result.name}】。`, [{
		label: "技能",
		command: "/技能"
	}], "快捷栏更新好了。");
};
const partyText = async (qqUserId) => {
	const party = await partyInfo(qqUserId);
	if (!party) return plainAppMessage("你还没有加入任何队伍。", [], "一个人走也可以。");
	const lines = [`【队伍·${party.name}】`, `队长：${party.leader?.name ?? "未知"}`];
	for (const member of party.members) lines.push(`成员：${member.name}（${member.gameId}）`);
	return plainAppMessage(lines.join("\n"), [{
		label: "退出队伍",
		command: "/退出队伍"
	}, {
		label: "刷新队伍",
		command: "/队伍"
	}], "一起走吧。");
};
const mailText = async (qqUserId, page = 1) => {
	const { playerMails } = await import("../game/mail.service.js");
	const data = await playerMails(qqUserId, page);
	const lines = [`【我的邮件】第 ${data.page}/${data.totalPages} 页`, ""];
	if (!data.mails.length) lines.push("邮箱空空如也。");
	for (const mail of data.mails) lines.push(`${mail.id}. ${mail.title}${mail.attachmentCount ? `（${mail.claimed ? "已领取" : "有附件"}）` : ""}`);
	return plainAppMessage(lines.join("\n"), [
		{
			label: "上一页",
			command: `/邮件页 ${Math.max(1, page - 1)}`
		},
		{
			label: "一键领取",
			command: "/一键领取邮件"
		},
		{
			label: "下一页",
			command: `/邮件页 ${Math.min(data.totalPages, page + 1)}`
		}
	], "有新的消息。");
};
const mailDetailText = async (qqUserId, id) => {
	const { mailDetail } = await import("../game/mail.service.js");
	const mail = await mailDetail(qqUserId, id);
	return plainAppMessage(`【${mail.title}】\n${mail.content || "无内容"}\n\n附件：${mail.attachments}`, mail.attachmentCount && !mail.claimed ? [{
		label: "领取",
		command: `/领取邮件 ${mail.id}`
	}] : [], "这是给你的信。");
};
const mailClaimText = async (qqUserId, id) => {
	const { claimMail, claimAllMails } = await import("../game/mail.service.js");
	if (!id) {
		const result = await claimAllMails(qqUserId);
		return plainAppMessage(`已领取 ${result.mailCount} 封邮件的附件。\n${result.items.map((item) => `获得【${item.name}】×${item.quantity}`).join("\n") || "没有额外物品。"}`, [{
			label: "邮件",
			command: "/邮件"
		}], "都收下啦。");
	}
	const result = await claimMail(qqUserId, id);
	return plainAppMessage(`附件已领取：${result.items.map((item) => `【${item.name}】×${item.quantity}`).join("、")}`, [{
		label: "邮件",
		command: "/邮件"
	}], "收到！");
};
const useItemText = async (qqUserId, id) => {
	const { randomUUID } = await import("node:crypto");
	const { useInventoryItem } = await import("../game/item-use.service.js");
	const result = await useInventoryItem(qqUserId, id, randomUUID());
	return plainAppMessage(result.message, [{
		label: "背包",
		command: "/背包 道具"
	}], "用好了。");
};
const giftText = async (qqUserId, code) => {
	const { chooseGift } = await import("../game/character.service.js");
	const character = await chooseGift(qqUserId, code);
	if (!character) return plainAppMessage("选择天赋失败，请重试。", [], "再试一次。");
	return plainAppMessage(`天赋已绑定【${character.giftName ?? "未知"}】。`, [{
		label: "角色",
		command: "/角色"
	}], "这条路的起点定了。");
};
const registerText = async (qqUserId, command) => {
	const args = command.replace(/^注册\s*/, "").trim().split(/\s+/).filter(Boolean);
	if (args[0] === "继续") {
		const { continueRegistration } = await import("../game/character.service.js");
		const next = await continueRegistration(qqUserId, args[1] ?? void 0);
		if (next === "completed") return plainAppMessage("你已经完成注册，可以开始冒险了。", [{
			label: "角色",
			command: "/角色"
		}], "欢迎回来！");
		return formatToAppMessage(await registrationScene(next, qqUserId), "我在这里等你。");
	}
	const { beginRegistration } = await import("../game/character.service.js");
	const result = await beginRegistration(qqUserId);
	if (result.alreadyRegistered) return plainAppMessage("你已经创建过角色，直接继续冒险吧。", [{
		label: "角色",
		command: "/角色"
	}], "老伙伴了。");
	return formatToAppMessage(await registrationScene(result.stage, qqUserId), "欢迎来到猫拉瑞亚。");
};
const autoBattleText = async (qqUserId, mode = "pve") => {
	const data = await autoBattleConfig(qqUserId, mode);
	const settings = data.settings;
	const lines = [
		`【自动战斗·${mode === "pvp" ? "PVP" : "PVE"}】`,
		`状态：${settings.enabled ? "已开启" : "已关闭"}`,
		...mode === "pve" ? [`默认遇敌：${settings.default_encounter_action === "persuade" ? "交涉" : "战斗"}`] : [],
		`自动嗑药：${settings.auto_potion_enabled ? "已开启" : "已关闭"}`,
		`生命门槛：${settings.hp_threshold}% · ${settings.hp_item_name ?? "不使用药剂"}`,
		`魔力门槛：${settings.mp_threshold}% · ${settings.mp_item_name ?? "不使用药剂"}`,
		`出招顺序：${data.actions.length ? data.actions.map((action) => action.name).join(" → ") : "普通攻击"}`
	];
	const nextSequence = Math.min(30, data.actions.length + 1);
	const buttons = [
		{
			label: settings.enabled ? "关闭自动战斗" : "开启自动战斗",
			command: `/自动战斗 ${settings.enabled ? "关闭" : "开启"}${mode === "pvp" ? " PVP" : ""}`
		},
		{
			label: settings.auto_potion_enabled ? "关闭自动嗑药" : "开启自动嗑药",
			command: `/自动战斗 嗑药 ${settings.auto_potion_enabled ? "关闭" : "开启"}${mode === "pvp" ? " PVP" : ""}`
		},
		{
			label: "新增出招",
			command: `/自动战斗 出招选择 ${nextSequence} 1${mode === "pvp" ? " PVP" : ""}`
		},
		{
			label: mode === "pve" ? "切换遇敌决策" : "切换 PVE",
			command: mode === "pve" ? "/自动战斗 默认选择" : "/自动战斗 PVE"
		}
	];
	return plainAppMessage(lines.join("\n"), buttons, "自动战斗会在战斗回合中按这份配置行动。");
};
const unsupportedText = (command) => plainAppMessage(`命令“${command}”暂未接入 App 网关。当前支持：面板、角色、属性、职业、天赋、背包、装备、技能、探索、移动、前往、前往目标、前往坐标、地图、状态、休息、战斗、切换目标、交涉、好友、好友申请、好友资料、玩家互动、赠礼、星誓、星誓申请、队伍、退出队伍、邮件、注册、初行剧情、天赋目录、天赋详情、坐标互动、NPC 对话、建筑进入、开采、刷新开采、取消开采、下迷宫。`, [
	{
		label: "角色",
		command: "/角色"
	},
	{
		label: "背包",
		command: "/背包"
	},
	{
		label: "状态",
		command: "/状态"
	}
], "这条命令我还没学会。");
const socialStageText = (stage) => String(stage?.title ?? stage ?? "好友");
const friendListText = async (qqUserId) => {
	const { friendList, friendRequests } = await import("../game/social.service.js");
	const [friends, requests] = await Promise.all([friendList(qqUserId), friendRequests(qqUserId)]);
	const lines = friends.length ? friends.map((friend) => `【${friend.name}】ID：${friend.game_id}\n关系：${friend.status === "oath" ? "星誓" : "好友"} · ${socialStageText(friend.stage)} · 好感 ${Number(friend.affinity)}`).join("\n\n") : "当前还没有游戏内好友。";
	const buttons = [{
		label: "好友申请",
		command: "/好友申请"
	}];
	for (const friend of friends.slice(0, 4)) buttons.push({
		label: `${friend.name}资料`,
		command: `/好友资料 ${friend.game_id}`
	});
	if (requests.length) buttons.push({
		label: `待处理申请（${requests.length}）`,
		command: "/好友申请"
	});
	return plainAppMessage(`【好友】\n\n${lines}`, buttons, "和同行者保持联系吧。");
};
const friendRequestsText = async (qqUserId) => {
	const { friendRequests } = await import("../game/social.service.js");
	const rows = await friendRequests(qqUserId);
	if (!rows.length) return plainAppMessage("【好友申请】\n\n当前没有待处理的好友申请。", [{
		label: "好友列表",
		command: "/好友"
	}], "新的相遇会在合适的时候到来。");
	const buttons = [];
	const text = rows.slice(0, 8).map((row) => {
		buttons.push({
			label: `接受 ${row.name}`,
			command: `/同意好友 ${row.id}`
		}, {
			label: `拒绝 ${row.name}`,
			command: `/拒绝好友 ${row.id}`
		});
		return `【${row.name}】ID：${row.game_id} · 申请编号 ${row.id}`;
	}).join("\n");
	buttons.push({
		label: "好友列表",
		command: "/好友"
	});
	return plainAppMessage(`【好友申请】\n\n${text}`, buttons, "请处理新的同行邀请。");
};
const friendDetailText = async (qqUserId, targetGameId) => {
	const { friendDetail } = await import("../game/social.service.js");
	const detail = await friendDetail(qqUserId, targetGameId);
	return plainAppMessage(`【玩家资料】\n\n${detail.name} · ID ${detail.gameId}\n等级：Lv.${detail.level} · 评级：${detail.rank}\n职业：${detail.profession}\n副职业：${detail.secondaryProfession}${detail.secondaryLevel ? ` Lv.${detail.secondaryLevel}` : ""}\n技能：${detail.skills.length ? detail.skills.map((skill) => `${skill.name} Lv.${skill.level}`).join("、") : "暂无"}`, [
		{
			label: "互动",
			command: `/玩家互动 ${detail.gameId}`
		},
		{
			label: "赠礼",
			command: `/好友赠礼选择 ${detail.gameId}`
		},
		{
			label: "好友列表",
			command: "/好友"
		}
	], "看看对方最近的冒险状态。");
};
const oathText = async (qqUserId) => {
	const { oathStatus, oathRequests } = await import("../game/social.service.js");
	const [oath, requests] = await Promise.all([oathStatus(qqUserId), oathRequests(qqUserId)]);
	const buttons = [{
		label: "星誓申请",
		command: "/星誓申请"
	}];
	let text = oath ? `同行者：【${oath.name}】ID：${oath.game_id}\n状态：${oath.status}\n好感：${oath.affinity} · ${socialStageText(oath.stage)}` : "当前还没有星誓关系。请与好友一同来到圣恩教堂后发起申请。";
	if (oath?.status === "ceremony_pending") buttons.unshift({
		label: "开始仪式",
		command: "/星誓仪式"
	});
	if (oath?.status === "active") buttons.unshift({
		label: "记录纪念",
		command: "/星誓纪念"
	}, {
		label: "发起解除",
		command: "/解除星誓"
	});
	if (requests.length) text += `\n\n待处理申请：${requests.length} 条`;
	return plainAppMessage(`【星誓】\n\n${text}`, buttons, "星光会记录你们共同走过的路。");
};
const miningResultMessage = (result) => {
	if (result.state === "started" || result.state === "mining") {
		const stateText = result.state === "started" ? "已开始" : "正在";
		return plainAppMessage(`${stateText}开采【${result.name}】（${result.kind}），每轮约 ${result.seconds} 秒，本轮剩余 ${result.remaining} 秒。同坐标资源会自动连续开采。`, [{
			label: "刷新开采",
			command: "/刷新开采"
		}, {
			label: "取消开采",
			command: "/取消开采"
		}], "采矿进行中。");
	}
	return plainAppMessage(`开采结算：${result.rewardText || "没有新的产出。"}`, [{
		label: "返回探索",
		command: "/探索"
	}], "本轮采矿已经结束。");
};
const coordinateInteractionButtons = (result) => {
	if (result?.kind === "npc" && result.npc?.code) {
		if (result.npc.interaction_kind === "building") {
			const action = String(result.npc.code).startsWith("dw_") ? "建筑敲门" : "建筑进入";
			return [{
				label: action === "建筑敲门" ? "敲门" : "进入",
				command: `/${action} ${result.npc.code}`
			}, {
				label: "忽略",
				command: `/建筑忽略 ${result.npc.code}`
			}];
		}
		return [{
			label: "对话",
			command: `/NPC对话 ${result.npc.code}`
		}, {
			label: "忽略",
			command: `/NPC忽略 ${result.npc.code}`
		}];
	}
	if (result?.kind === "resource" && result.resource?.id) return [{
		label: "开采",
		command: `/开采 ${result.resource.id}`
	}, {
		label: "忽略",
		command: "/面板"
	}];
	if (result?.kind === "dungeon_entrance" && result.entrance?.id) {
		const stage = Number(result.discovery?.stage ?? 0);
		return [{
			label: stage >= 5 ? "进入迷宫" : "调查石门",
			command: stage >= 5 ? `/下迷宫 ${result.entrance.id}` : "/地图"
		}, {
			label: "忽略",
			command: "/面板"
		}];
	}
	if (result?.kind === "interaction" && Array.isArray(result.targets)) return result.targets.slice(0, 6).flatMap((target) => {
		if (target.type === "建筑" && target.id) return [{
			label: `进入 ${target.name}`,
			command: `/建筑进入 ${target.id}`
		}];
		if ((target.type === "域民" || target.type === "NPC") && target.id) return [{
			label: `对话 ${target.name}`,
			command: `/NPC对话 ${target.id}`
		}];
		if (target.type === "资源" && target.id) return [{
			label: `开采 ${target.name}`,
			command: `/开采 ${target.id}`
		}];
		return [];
	});
	if (result?.kind === "object") return [{
		label: "返回操作面板",
		command: "/面板"
	}];
	return [];
};
const executeAppCommand = async (input) => {
	const raw = String(input.command ?? "").trim();
	const command = raw.startsWith("/") ? raw.slice(1) : raw;
	const [head, ...args] = command.split(/\s+/).filter(Boolean);
	switch (head) {
		case "菜单": return menuText(args[0] === "进阶" ? 2 : 1);
		case "角色":
		case "我": return characterText(input.qqUserId);
		case "属性": return attributesText(input.qqUserId);
		case "天赋": return talentText(input.qqUserId);
		case "职业": return characterText(input.qqUserId);
		case "背包":
		case "物品": {
			const category = args[0] === "装备" || args[0] === "道具" || args[0] === "材料" ? args[0] : void 0;
			return inventoryText(input.qqUserId, category);
		}
		case "探索":
		case "寻怪": return exploreText(input.qqUserId);
		case "目标":
			if (!args[0]) return plainAppMessage("目标需要编号：/目标 <编号>", [], "告诉我要找哪个目标。");
			await chooseTarget(input.qqUserId, Number(args[0]));
			return battleText(input.qqUserId, []);
		case "切换目标": {
			const targetId = Number(args[0] ?? 0);
			if (!Number.isSafeInteger(targetId) || targetId <= 0) return plainAppMessage("切换目标需要战斗目标编号：/切换目标 <编号>", [], "告诉我要锁定哪一个目标。");
			await switchCombatTarget(input.qqUserId, targetId, "target");
			return battleText(input.qqUserId, []);
		}
		case "交涉": return negotiationViewText(input.qqUserId, args);
		case "交涉行动": return negotiationActionText(input.qqUserId, args);
		case "交涉物品": return negotiationItemText(input.qqUserId, args);
		case "交涉交付": return negotiationGiftText(input.qqUserId, args);
		case "交涉分页": return negotiationViewText(input.qqUserId, args);
		case "交涉搜索": {
			const searchArgs = [
				args[0] ?? "",
				args[1] ?? "",
				"1",
				...args.slice(2)
			];
			return negotiationViewText(input.qqUserId, searchArgs);
		}
		case "坐标互动": {
			const rawType = String(args[0] ?? "");
			const id = args[1] ?? "";
			if (!rawType || !id) return plainAppMessage("互动需要类型和编号：/坐标互动 <类型> <编号>", [], "把目标告诉我。");
			const type = rawType;
			if (![
				"玩家",
				"域民",
				"NPC",
				"建筑",
				"资源",
				"入口",
				"地标"
			].includes(type)) return plainAppMessage("不支持的互动类型：" + rawType, [], "换个目标吧。");
			const result = await coordinateInteraction(input.qqUserId, type, id);
			return plainAppMessage(result.text || "你查看了这个目标。", coordinateInteractionButtons(result), "这里有点东西。");
		}
		case "NPC对话": {
			const text = await talkToNpc(input.qqUserId, args[0] ?? "");
			return plainAppMessage(text, [{
				label: "返回操作面板",
				command: "/面板"
			}], "我听见了。");
		}
		case "NPC忽略": return plainAppMessage("你暂时忽略了这位域民。", [{
			label: "返回操作面板",
			command: "/面板"
		}], "下次再聊也不迟。");
		case "建筑忽略": return plainAppMessage("你暂时没有进入这处建筑。", [{
			label: "返回操作面板",
			command: "/面板"
		}], "我们先看看别处。");
		case "建筑敲门":
		case "建筑进入": {
			const building = await requireNpcAtCurrentPosition(input.qqUserId, args[0] ?? "");
			const command = args[0] === "guild_counter" ? "/初行公会" : "/面板";
			return plainAppMessage(`你来到【${building.name}】。\n${building.description || "门内传来回应。"}`, [{
				label: command === "/初行公会" ? "进入公会" : "返回操作面板",
				command
			}], "这里有新的入口。");
		}
		case "开采": {
			const result = await mineResource(input.qqUserId, Number(args[0] ?? 0));
			return miningResultMessage(result);
		}
		case "刷新开采": {
			const status = await resourceMiningStatus(input.qqUserId);
			if (!status) return plainAppMessage("当前没有正在进行的资源开采。", [{
				label: "返回探索",
				command: "/探索"
			}], "可以继续寻找新的资源。");
			const result = await mineResource(input.qqUserId, status.resourceId);
			return miningResultMessage(result);
		}
		case "取消开采": {
			const result = await cancelResourceMining(input.qqUserId);
			return plainAppMessage(`你停止了【${result.name}】的连续开采。${result.rewardText ? ` 已结算：${result.rewardText}。` : ""}`, [{
				label: "返回探索",
				command: "/探索"
			}], "已收起采矿工具。");
		}
		case "下迷宫": {
			const result = await enterDungeon(input.qqUserId, Number(args[0] ?? 0));
			return plainAppMessage(`已进入地下迷宫（${result.x}, ${result.y}, ${result.z}）。`, [{
				label: "查看地图",
				command: "/地图"
			}, {
				label: "查看面板",
				command: "/面板"
			}], "地下的风有点冷。");
		}
		case "移动":
		case "走":
			if (!args[0]) return plainAppMessage("移动需要方向：/移动 上｜下｜左｜右", [], "告诉我往哪走。");
			return moveText(input.qqUserId, args[0]);
		case "前往":
		case "地图前往":
			if (!args[0]) return plainAppMessage("前往需要地图代码：/前往 baina_town", [], "要去哪张地图？");
			return mapTravelText(input.qqUserId, args[0]);
		case "前往目标": {
			const spawnId = Number(args[0] ?? 0);
			if (!Number.isInteger(spawnId) || spawnId <= 0) return plainAppMessage("前往目标需要怪物编号。", [], "告诉我目标编号。");
			return moveToNearbyMonsterText(input.qqUserId, spawnId);
		}
		case "前往坐标": {
			const coordinates = args.slice(0, 3).map(Number);
			if (coordinates.length < 3 || coordinates.some((value) => !Number.isInteger(value))) return plainAppMessage("前往坐标需要三个整数：/前往坐标 <x> <y> <z>", [], "把目标坐标告诉我。");
			return moveToCoordinateText(input.qqUserId, coordinates[0], coordinates[1], coordinates[2]);
		}
		case "地图": return mapText(input.qqUserId);
		case "状态":
		case "旅途":
		case "面板": return statusText(input.qqUserId);
		case "休息":
		case "起床": return restText(input.qqUserId, command);
		case "战斗":
		case "攻击": return battleText(input.qqUserId, args);
		case "自动战斗": {
			const action = String(args[0] ?? "配置");
			const mode = String(args[1] ?? "").toUpperCase() === "PVP" || action.toUpperCase() === "PVP" ? "pvp" : "pve";
			if (action === "开启" || action === "关闭") {
				await setAutoBattleEnabled(input.qqUserId, action === "开启", mode);
				return autoBattleText(input.qqUserId, mode);
			}
			if (action === "嗑药") {
				const enabled = String(args[1] ?? "") === "开启";
				const potionMode = String(args[2] ?? "").toUpperCase() === "PVP" ? "pvp" : "pve";
				await setAutoPotionEnabled(input.qqUserId, enabled, potionMode);
				return autoBattleText(input.qqUserId, potionMode);
			}
			if (action === "设置门槛") {
				const kind = String(args[1] ?? "") === "魔力" ? "mp" : "hp";
				const threshold = Number(args[2] ?? 0);
				const thresholdMode = String(args[3] ?? "").toUpperCase() === "PVP" ? "pvp" : "pve";
				if (!Number.isFinite(threshold)) return plainAppMessage("门槛需要填写百分比数字。");
				await setAutoPotionThreshold(input.qqUserId, kind, threshold, thresholdMode);
				return autoBattleText(input.qqUserId, thresholdMode);
			}
			if (action === "选择药剂") {
				const kind = String(args[1] ?? "") === "魔力" ? "mp" : "hp";
				const itemId = Number(args[2] ?? 0);
				const potionMode = String(args[3] ?? "").toUpperCase() === "PVP" ? "pvp" : "pve";
				await setAutoPotionItem(input.qqUserId, kind, itemId > 0 ? itemId : null, potionMode);
				return autoBattleText(input.qqUserId, potionMode);
			}
			if (action === "默认选择") {
				await toggleAutoBattleEncounterAction(input.qqUserId);
				return autoBattleText(input.qqUserId, "pve");
			}
			return autoBattleText(input.qqUserId, mode);
		}
		case "注册": return registerText(input.qqUserId, command);
		case "询问": {
			const { askWhereAmI } = await import("../game/character.service.js");
			const stage = await askWhereAmI(input.qqUserId);
			return formatToAppMessage(await registrationScene(stage, input.qqUserId), "我听着呢。");
		}
		case "选择去向": {
			const destination = args[0];
			if (destination !== "天堂" && destination !== "异世界") return plainAppMessage("请选择：天堂或异世界。", [{
				label: "转生异世界",
				command: "/选择去向 异世界"
			}], "去向要想清楚。");
			const { chooseDestination } = await import("../game/character.service.js");
			const stage = await chooseDestination(input.qqUserId, destination);
			return formatToAppMessage(await registrationScene(stage, input.qqUserId), "决定好了，就向前走吧。");
		}
		case "天堂": {
			if (args[0] !== "继续") return plainAppMessage("如果你决定前往天堂，请点击“踏入天堂”。", [{
				label: "踏入天堂",
				command: "/天堂 继续"
			}]);
			const { completeHeavenRebirth } = await import("../game/character.service.js");
			const result = await completeHeavenRebirth(input.qqUserId);
			return plainAppMessage(result.replayed ? "这段告别已经完成。" : "你选择了宁静的彼岸。本次不会创建冒险者角色。", [{
				label: "重新注册",
				command: "/注册"
			}], "有一天想重新出发时，再来找我。");
		}
		case "初行选择":
			if (args.length < 2) return plainAppMessage("剧情选择参数缺失，请重新点击剧情按钮。");
			return openingChoiceText(input.qqUserId, Number(args[0]), args.slice(1).join(" "));
		case "初章":
			if (args[0] !== "包容之镇" || args.length < 2) return plainAppMessage("请按当前初章提示选择行动。");
			return forestGuideChoiceText(input.qqUserId, args.slice(1).join(" "));
		case "继续剧情": return continueJourneyText(input.qqUserId);
		case "天赋目录": {
			const page = Number(args[0] ?? 1);
			const group = args[1] ?? "全部";
			const keyword = args[2] ?? "";
			return formatToAppMessage(divineCatalog(Number.isFinite(page) ? page : 1, keyword, group), "从目录里挑一条适合你的路。");
		}
		case "天赋详情":
			if (!args[0]) return plainAppMessage("请选择一个天赋编号。", [{
				label: "打开天赋目录",
				command: "/天赋目录 1 全部"
			}], "先看看可选的天赋吧。");
			try {
				return formatToAppMessage(divineDetail(args[0]), "看清楚这条路，再决定是否选择。");
			} catch (error) {
				return plainAppMessage(error instanceof Error ? error.message : "天赋不存在，请从目录中选择。", [{
					label: "打开天赋目录",
					command: "/天赋目录 1 全部"
				}], "换一条看看吧。");
			}
		case "初行入会":
		case "初行公会": {
			const { enterOpeningGuild } = await import("../game/opening-guild.service.js");
			if (head === "初行入会") await enterOpeningGuild(input.qqUserId, true);
			const { openingGuildFormat } = await import("../response/opening-guild.js");
			return formatToAppMessage(await openingGuildFormat(input.qqUserId, args[0] ?? "大厅"), "冒险者公会会替你安排下一步。");
		}
		case "装备":
		case "我的装备": return equipmentText(input.qqUserId);
		case "装备详情":
		case "已装备详情": return equipmentDetailText(input.qqUserId, Number(args[0] ?? 0));
		case "穿戴装备": return equipText(input.qqUserId, args[0] ?? "", Number(args[1] ?? 0));
		case "卸下装备": return unequipText(input.qqUserId, args[0] ?? "");
		case "技能":
		case "技能列表": return skillsText(input.qqUserId, args[0] ?? "已学习");
		case "技能详情": return skillsText(input.qqUserId, "已学习", Number(args[0] ?? 0));
		case "学习技能": return learnSkillText(input.qqUserId, Number(args[0] ?? 0));
		case "升级技能": return upgradeSkillText(input.qqUserId, Number(args[0] ?? 0));
		case "技能快捷": return toggleShortcutText(input.qqUserId, Number(args[0] ?? 0));
		case "好友": return friendListText(input.qqUserId);
		case "好友申请": return friendRequestsText(input.qqUserId);
		case "加好友": {
			const { sendFriendRequest } = await import("../game/social.service.js");
			const result = await sendFriendRequest(input.qqUserId, Number(args[0] ?? 0));
			return plainAppMessage(`好友申请已送达。你向【${result.targetName}】发出了好友申请，请等待对方回应。`, [{
				label: "好友列表",
				command: "/好友"
			}], "新的同行关系正在建立。");
		}
		case "同意好友": {
			const { acceptFriendRequest } = await import("../game/social.service.js");
			const result = await acceptFriendRequest(input.qqUserId, Number(args[0] ?? 0));
			return plainAppMessage(`你与【${result.name}】成为了游戏内好友。`, [{
				label: "好友列表",
				command: "/好友"
			}], "可以一起探索了。");
		}
		case "拒绝好友": {
			const { rejectFriendRequest } = await import("../game/social.service.js");
			await rejectFriendRequest(input.qqUserId, Number(args[0] ?? 0));
			return plainAppMessage("这条好友申请已处理。", [{
				label: "好友申请",
				command: "/好友申请"
			}], "新的相遇会在合适的时候到来。");
		}
		case "好友资料": return friendDetailText(input.qqUserId, Number(args[0] ?? 0));
		case "玩家互动": {
			const { interactFriend } = await import("../game/social.service.js");
			const result = await interactFriend(input.qqUserId, Number(args[0] ?? 0));
			return plainAppMessage(`你和【${result.targetName}】聊了一会儿，好感 ${result.changed ? "+5" : "今日互动次数已用完"}。\n当前阶段：${socialStageText(result.stage)} · 好感 ${result.affinity}`, [{
				label: "好友列表",
				command: "/好友"
			}], "关系会在日常相处中慢慢升温。");
		}
		case "好友赠礼选择": return plainAppMessage("请选择要交给对方的礼物：", [{
			label: "心意花束",
			command: `/好友赠礼 ${Number(args[0] ?? 0)} heart_bouquet`
		}, {
			label: "共鸣果实",
			command: `/好友赠礼 ${Number(args[0] ?? 0)} resonance_fruit`
		}], "一份心意，足以让旅途更温暖。");
		case "好友赠礼": {
			const { giveAffinityGift } = await import("../game/social.service.js");
			const result = await giveAffinityGift(input.qqUserId, Number(args[0] ?? 0), String(args[1] ?? ""));
			return plainAppMessage(`你将【${result.itemName}】交到【${result.targetName}】手中。\n好感 +${result.gain}\n当前阶段：${socialStageText(result.stage)} · 好感 ${result.affinity}`, [{
				label: "好友列表",
				command: "/好友"
			}], "心意已经送达。");
		}
		case "星誓": return oathText(input.qqUserId);
		case "星誓申请": {
			const { oathRequests } = await import("../game/social.service.js");
			const rows = await oathRequests(input.qqUserId);
			if (!rows.length) return plainAppMessage("当前没有待处理的星誓申请。", [{
				label: "星誓",
				command: "/星誓"
			}], "星光还在等待回应。");
			const buttons = [];
			const text = rows.slice(0, 8).map((row) => {
				buttons.push({
					label: `接受 ${row.name}`,
					command: `/接受星誓 ${row.id}`
				}, {
					label: `拒绝 ${row.name}`,
					command: `/拒绝星誓 ${row.id}`
				});
				return `【${row.name}】ID：${row.game_id} · 好感 ${row.affinity} · 申请编号 ${row.id}`;
			}).join("\n");
			buttons.push({
				label: "星誓",
				command: "/星誓"
			});
			return plainAppMessage(`【星誓申请】\n\n${text}`, buttons, "请回应这份星光邀请。");
		}
		case "发起星誓": {
			const { requestOath } = await import("../game/social.service.js");
			const result = await requestOath(input.qqUserId, Number(args[0] ?? 0));
			return plainAppMessage(`你已向【${result.targetName}】发出星誓申请，请在圣恩教堂等待回应。`, [{
				label: "星誓",
				command: "/星誓"
			}], "把共同的约定交给星光见证。");
		}
		case "接受星誓": {
			const { acceptOath } = await import("../game/social.service.js");
			const result = await acceptOath(input.qqUserId, Number(args[0] ?? 0));
			return plainAppMessage(`你已接受【${result.partnerName}】的星誓申请。请与对方一同回到圣恩教堂开始仪式。\n当前阶段：${socialStageText(result.stage)} · 好感 ${result.affinity}`, [{
				label: "星誓",
				command: "/星誓"
			}], "仪式还需要你们一起完成。");
		}
		case "拒绝星誓": {
			const { rejectOath } = await import("../game/social.service.js");
			await rejectOath(input.qqUserId, Number(args[0] ?? 0));
			return plainAppMessage("这份星誓申请已处理。", [{
				label: "星誓申请",
				command: "/星誓申请"
			}], "星光暂时回到了夜空。");
		}
		case "星誓仪式": {
			const { startOathCeremony } = await import("../game/social.service.js");
			const result = await startOathCeremony(input.qqUserId);
			return plainAppMessage(`你与【${result.partnerName}】完成了星誓仪式，正式成为星誓同行。`, [{
				label: "星誓",
				command: "/星誓"
			}], "愿你们在异世界彼此照亮。");
		}
		case "星誓纪念": {
			const { recordOathMemory } = await import("../game/social.service.js");
			const result = await recordOathMemory(input.qqUserId);
			return plainAppMessage(`你和【${result.partnerName}】记录了一次星誓纪念。好感 +10，当前好感 ${result.affinity}。`, [{
				label: "星誓",
				command: "/星誓"
			}], "共同经历会成为你们的纪念。");
		}
		case "解除星誓": {
			const { requestOathRelease } = await import("../game/social.service.js");
			const result = await requestOathRelease(input.qqUserId);
			return plainAppMessage(`你已向【${result.partnerName}】发出解除星誓的申请，等待对方回应。`, [{
				label: "星誓申请",
				command: "/星誓申请"
			}], "请认真对待这份关系。");
		}
		case "同意解除星誓": {
			const { acceptOathRelease } = await import("../game/social.service.js");
			const result = await acceptOathRelease(input.qqUserId, Number(args[0] ?? 0));
			return plainAppMessage(`你与【${result.partnerName}】的星誓记录已归档，好友关系与已有好感继续保留。`, [{
				label: "好友",
				command: "/好友"
			}], "同行方式改变，记忆仍然保留。");
		}
		case "拒绝解除星誓": {
			const { rejectOathRelease } = await import("../game/social.service.js");
			const result = await rejectOathRelease(input.qqUserId, Number(args[0] ?? 0));
			return plainAppMessage(`你拒绝了【${result.partnerName}】的解除申请，星誓同行状态保持不变。`, [{
				label: "星誓",
				command: "/星誓"
			}], "你们仍在同一条星光下。");
		}
		case "队伍":
		case "队伍列表": return partyText(input.qqUserId);
		case "退出队伍":
			await leaveParty(input.qqUserId);
			return plainAppMessage("你已退出当前队伍。", [{
				label: "查看队伍",
				command: "/队伍"
			}], "接下来按自己的节奏走吧。");
		case "邮件": return mailText(input.qqUserId, Number(args[0] ?? 1));
		case "邮件页": return mailText(input.qqUserId, Number(args[0] ?? 1));
		case "查看邮件": return mailDetailText(input.qqUserId, Number(args[0] ?? 0));
		case "领取邮件": return mailClaimText(input.qqUserId, Number(args[0] ?? 0));
		case "一键领取邮件": return mailClaimText(input.qqUserId);
		case "使用道具": return useItemText(input.qqUserId, Number(args[0] ?? 0));
		case "选择恩赐": return giftText(input.qqUserId, args[0] ?? "");
		default: return unsupportedText(raw);
	}
};
const menuItem = (id, label, command, enabled, reason, refresh, action, children) => ({
	id,
	label,
	...command ? { command } : {},
	...action ? { action } : {},
	enabled,
	...reason ? { reason } : {},
	...refresh ? { refresh } : {},
	...children ? { children } : {}
});
const desktopMenuFor = (session, character) => {
	const hasCharacter = Boolean(character);
	const evolutionUnlocked = Boolean(character && character.realmStage >= 3);
	return [
		{
			id: "character",
			label: "角色",
			priority: "P0",
			items: [
				menuItem("character.profile", "角色", "/角色", hasCharacter, hasCharacter ? void 0 : "请先完成角色注册。", ["summary"]),
				menuItem("character.attributes", "属性", "/属性", hasCharacter, hasCharacter ? void 0 : "请先完成角色注册。", ["summary"]),
				menuItem("character.profession", "职业 / 冒险者", "/职业", hasCharacter, hasCharacter ? void 0 : "请先完成角色注册。", ["summary"]),
				menuItem("character.talent", "天赋 / 恩赐", "/天赋", hasCharacter, hasCharacter ? void 0 : "请先完成角色注册。", ["summary"]),
				menuItem("character.skills", "技能", "/技能", hasCharacter, hasCharacter ? void 0 : "请先完成角色注册。", ["skills"]),
				menuItem("character.equipment", "装备", "/装备", hasCharacter, hasCharacter ? void 0 : "请先完成角色注册。", ["equipment", "inventory"]),
				menuItem("character.evolution", "进化", void 0, evolutionUnlocked, evolutionUnlocked ? void 0 : "完成开化后开放。")
			]
		},
		{
			id: "inventory",
			label: "背包",
			priority: "P0",
			items: [
				menuItem("inventory.all", "总览", "/背包", hasCharacter, hasCharacter ? void 0 : "请先完成角色注册。", ["inventory"]),
				menuItem("inventory.equipment", "装备", "/背包 装备", hasCharacter, hasCharacter ? void 0 : "请先完成角色注册。", ["inventory"]),
				menuItem("inventory.items", "道具", "/背包 道具", hasCharacter, hasCharacter ? void 0 : "请先完成角色注册。", ["inventory"]),
				menuItem("inventory.materials", "材料", "/背包 材料", hasCharacter, hasCharacter ? void 0 : "请先完成角色注册。", ["inventory"])
			]
		},
		{
			id: "quests",
			label: "任务",
			priority: "P1",
			items: [
				menuItem("quests.main", "主线", void 0, false, "任务面板正在接入。"),
				menuItem("quests.side", "支线", void 0, false, "任务面板正在接入。"),
				menuItem("quests.dungeon", "副本", void 0, false, "副本任务正在接入。"),
				menuItem("quests.bounty", "悬赏", void 0, false, "悬赏面板正在接入。"),
				menuItem("quests.commission", "委托", void 0, false, "委托面板正在接入。"),
				menuItem("quests.achievement", "成就 / 足迹", void 0, false, "成就面板正在接入。")
			]
		},
		{
			id: "social",
			label: "社交",
			priority: "P1",
			items: [
				menuItem("social.friends", "好友", "/好友", hasCharacter, hasCharacter ? void 0 : "请先完成角色注册。", ["social"]),
				menuItem("social.friend-requests", "好友申请", "/好友申请", hasCharacter, hasCharacter ? void 0 : "请先完成角色注册。", ["social"]),
				menuItem("social.oath", "星誓", "/星誓", hasCharacter, hasCharacter ? void 0 : "请先完成角色注册。", ["social"]),
				menuItem("social.oath-requests", "星誓申请", "/星誓申请", hasCharacter, hasCharacter ? void 0 : "请先完成角色注册。", ["social"]),
				menuItem("social.gifts", "赠礼", void 0, false, "请从好友资料中选择赠礼对象。"),
				menuItem("social.party", "队伍", "/队伍", hasCharacter, hasCharacter ? void 0 : "请先完成角色注册。", ["party"]),
				menuItem("social.mail", "邮件", "/邮件", hasCharacter, hasCharacter ? void 0 : "请先完成角色注册。", ["mail", "inventory"])
			]
		},
		{
			id: "shops",
			label: "商店",
			priority: "P1",
			items: [
				menuItem("shops.exchange", "交易所", void 0, false, "交易所正在接入。"),
				menuItem("shops.general", "商店", void 0, false, "商店正在接入。"),
				menuItem("shops.market", "市场 / 钱庄", void 0, false, "市场服务正在接入。")
			]
		},
		{
			id: "account",
			label: "账号",
			priority: "P0",
			items: [
				menuItem("account.uid", `当前 Game ID：${session.gameUserId}`, void 0, false),
				menuItem("account.password", session.passwordLoginEnabled ? "修改密码" : "设置密码", void 0, true, void 0, void 0, session.passwordLoginEnabled ? "account.change-password" : "account.set-password"),
				menuItem("account.switch", "切换账号", void 0, true, void 0, void 0, "account.switch"),
				menuItem("account.logout", "注销当前设备", void 0, true, void 0, void 0, "account.logout")
			]
		},
		{
			id: "pet",
			label: "桌宠设置",
			priority: "P0",
			items: [
				menuItem("pet.always-on-top", "置顶", void 0, true, void 0, void 0, "pet.always-on-top"),
				menuItem("pet.tracking", "逗猫棒 / 追踪", void 0, true, void 0, void 0, "pet.tracking"),
				menuItem("pet.idle", "休息模式", void 0, true, void 0, void 0, "pet.idle"),
				menuItem("pet.activity", "活动频率", void 0, true, void 0, void 0, "pet.activity"),
				menuItem("pet.mouse", "鼠标穿透", void 0, true, void 0, void 0, "pet.mouse"),
				menuItem("pet.model", "模型切换", void 0, true, void 0, void 0, "pet.model"),
				menuItem("pet.server", "服务器设置", void 0, true, void 0, void 0, "pet.server")
			]
		},
		{
			id: "system",
			label: "系统",
			priority: "P0",
			items: [
				menuItem("system.refresh", "刷新连接", void 0, true, void 0, void 0, "system.refresh"),
				menuItem("system.help", "帮助", void 0, true, void 0, void 0, "system.help"),
				menuItem("system.about", "关于 / 版本", void 0, true, void 0, void 0, "system.about"),
				menuItem("system.hide", "隐藏桌宠", void 0, true, void 0, void 0, "system.hide"),
				menuItem("system.quit", "退出桌宠", void 0, true, void 0, void 0, "system.quit")
			]
		}
	];
};
/**
* 立绘只传稳定的语义键，不把 web 的文件路径写进游戏服务。
*
* H5 使用整张透明 PNG 立绘切换；二转优先显示对应职业，
* 未绘制时回退一转或初始立绘。装备仍在装备栏显示。
*/
const portraitForCharacter = (character) => {
	const genderKey = character.gender === "女" ? "female" : "male";
	const profession = String(character.professionName ?? "").trim();
	const professionCode = String(character.professionCode ?? "").trim().toLowerCase();
	const professionKey = professionCode === "warrior" || profession.includes("战士") ? "warrior" : professionCode === "mage" || profession.includes("法师") ? "mage" : professionCode === "rogue" || profession.includes("盗贼") ? "rogue" : professionCode === "priest" || profession.includes("牧师") || profession.includes("祭司") ? "priest" : professionCode === "archer" || profession.includes("射手") || profession.includes("弓箭") ? "archer" : null;
	const fallbackKey = professionKey ? `profession_${professionKey}_${genderKey}` : `player_${genderKey}_initial`;
	const advancedCode = String(character.advancedProfessionCode ?? "").trim();
	const advanced = advancedCode ? registeredAdvancedProfessionByCode(advancedCode) : null;
	return advanced ? {
		baseKey: `advanced_${advanced.code}_${genderKey}`,
		poseKey: `standing_${advanced.code}`,
		fallbackKey
	} : {
		baseKey: fallbackKey,
		poseKey: professionKey ? `standing_${professionKey}` : "standing_initial"
	};
};
/** Only reads committed progress. In particular, /继续剧情 must not be run while restoring a page. */
const pendingAppStory = async (qqUserId, hasCharacter, inBattle = false) => {
	if (!hasCharacter) return {
		command: "/注册",
		revision: "registration"
	};
	if (inBattle) return void 0;
	const { openingStatus } = await import("../game/opening.service.js");
	const opening = await openingStatus(qqUserId);
	if (opening && opening.state !== "armed" && opening.state !== "completed") return {
		revision: `opening:${opening.route}:${opening.revision}:${opening.state}:${opening.page}`,
		messages: [await openingText(opening)]
	};
	const forest = await forestGuideSnapshot(qqUserId);
	if (!forest) return void 0;
	const message = forest.chapter === "forest" ? forestChapterText(forest.stage, forest.text) : forest.status === "awaiting_arrival" ? plainAppMessage(forest.text, [{
		label: "前往百纳镇",
		command: "/继续剧情"
	}]) : townArrivalText({
		...forest,
		chapter: forest.chapter,
		completed: false
	});
	return {
		revision: `forest:${forest.status}:${forest.stage}`,
		messages: [message]
	};
};
const appQuickPanel = async (session) => {
	const qqUserId = await appSessionQqUser(session);
	const [character, travel, encounter, battle, nearby, movement, inventory, autoPve, autoPvp, mining] = await Promise.all([
		getCharacter(qqUserId),
		travelStatus(qqUserId).catch(() => null),
		currentEncounter(qqUserId).catch(() => null),
		battleStatus(qqUserId).catch(() => ({ targets: [] })),
		import("../game/adventure.service.js").then(({ nearbyPoints }) => nearbyPoints(qqUserId).then((near) => near.points ? near : null).catch(() => null)),
		movementProfile(qqUserId).catch(() => null),
		inventoryView(qqUserId, void 0, { updateCodex: false }).catch(() => null),
		autoBattleConfig(qqUserId, "pve").catch(() => null),
		autoBattleConfig(qqUserId, "pvp").catch(() => null),
		resourceMiningStatus(qqUserId).catch(() => null)
	]);
	const [equipped, skillData] = await Promise.all([character ? equipment(qqUserId).catch(() => []) : Promise.resolve([]), character ? skillList(qqUserId).catch(() => null) : Promise.resolve(null)]);
	const realmStage = Number(character?.realmStage ?? 0);
	const mapData = character ? await mapDataFor(character, qqUserId) : void 0;
	const regionMap = mapData ? {
		currentRegionCode: mapData.partyMembers?.find((member) => member.isSelf)?.regionCode ?? "",
		regions: mapData.maps.map((map) => {
			const member = mapData.partyMembers?.find((item) => item.regionCode === map.code && item.isSelf);
			return {
				code: map.code,
				name: map.name,
				danger: map.danger,
				isCurrent: map.isCurrent,
				...member ? { current: {
					x: member.x,
					y: member.y,
					z: member.z
				} } : {}
			};
		}),
		members: mapData.partyMembers ?? [],
		landmarks: (mapData.landmarks ?? []).map((item) => ({
			...item,
			id: `${item.regionCode}:${item.code}:${item.x}:${item.y}:${item.z}`
		}))
	} : void 0;
	const inBattle = Array.isArray(battle.targets) && battle.targets.length > 0;
	const pendingStory = await pendingAppStory(qqUserId, Boolean(character), inBattle);
	const activeBattle = inBattle ? battle : void 0;
	const summary = character ? {
		name: character.name,
		gender: character.gender,
		level: Number(character.level),
		experience: Number(character.experience),
		experienceRequired: experienceRequiredForLevel(Number(character.level)),
		realmStage: Number(character.realmStage ?? 1),
		profession: character.professionName ?? void 0,
		hp: {
			current: Math.round(character.currentHp),
			max: Math.round(character.hpMax)
		},
		mp: {
			current: Math.round(character.currentMp),
			max: Math.round(character.mpMax)
		},
		stamina: {
			current: Math.round(character.stamina),
			max: Math.round(character.staminaMax)
		},
		physicalAttack: Math.round(character.physicalAttack),
		magicAttack: Math.round(character.magicAttack),
		physicalDefense: Math.round(character.physicalDefense),
		magicDefense: Math.round(character.magicDefense),
		accuracy: Math.round(character.accuracy),
		evasion: Math.round(character.evasion),
		critRateBp: Math.round(character.critRateBp),
		critDamageBp: Math.round(character.critDamageBp),
		critResistBp: Math.round(character.critResistBp),
		critDamageReductionBp: Math.round(character.critDamageReductionBp),
		tenacity: Math.round(character.tenacity),
		tenacityPierce: Math.round(character.tenacityPierce),
		speed: Math.round(character.speed),
		attributes: {
			constitution: Number(Number(character.constitution).toFixed(1)),
			spirit: Number(Number(character.spirit).toFixed(1)),
			strength: Number(Number(character.strength).toFixed(1)),
			intelligence: Number(Number(character.intelligence).toFixed(1)),
			agility: Number(Number(character.agility).toFixed(1)),
			perception: Number(Number(character.perception).toFixed(1))
		},
		extraAttributes: character.extraAttributes,
		elementMastery: character.elementMastery,
		elementResistance: character.elementResistance,
		giftName: character.giftName,
		staminaFullSeconds: Number(character.staminaFullSeconds),
		activeBuffs: character.activeBuffs,
		region: character.regionName,
		position: {
			x: Number(character.x),
			y: Number(character.y),
			z: Number(character.z)
		},
		activity: character.activityStatus,
		equipment: equipped.map((item) => ({
			slot: String(item.slot),
			id: item.instance_id == null ? null : Number(item.instance_id),
			code: String(item.code),
			codexId: item.codex_id == null ? null : String(item.codex_id),
			name: String(item.name),
			itemCategory: String(item.item_category ?? ""),
			rarity: String(item.rarity ?? ""),
			requiredLevel: Number(item.required_level ?? 0),
			quality: Number(item.quality ?? 100),
			durability: Number(item.durability ?? 0),
			durabilityMax: Number(item.durability_max ?? 0),
			description: String(item.description ?? ""),
			...item.weapon_type ? { weaponType: String(item.weapon_type) } : {},
			...item.appearanceCode ? { appearanceCode: String(item.appearanceCode) } : {},
			...item.appearanceName ? { appearanceName: String(item.appearanceName) } : {}
		})),
		portrait: portraitForCharacter(character),
		...movement ? { movement: {
			step: Number(movement.step),
			maximum: Number(movement.maximum)
		} } : {},
		...travel ? { travel: {
			destination: String(travel.destinationName ?? travel.regionName ?? ""),
			remaining: Number(travel.remaining ?? 0),
			activityType: travel.activityType
		} } : {},
		unreadMail: 0,
		...encounter?.spawns?.length ? { encounter: { count: encounter.spawns.length } } : {}
	} : void 0;
	return {
		...plainAppMessage(character ? "桌宠待命中。" : "还没有角色，先完成注册吧。", [
			{
				label: "角色",
				command: "/角色"
			},
			{
				label: "背包",
				command: "/背包"
			},
			{
				label: "状态",
				command: "/状态"
			},
			{
				label: "探索",
				command: "/探索"
			}
		], character ? "今天想去哪里？" : "我们先创建一个角色吧。"),
		serverTime: (/* @__PURE__ */ new Date()).toISOString(),
		connection: "online",
		inBattle,
		...pendingStory ? { pendingStory } : {},
		...activeBattle ? { battle: activeBattle } : {},
		...mining ? { mining } : {},
		...movement ? { movement } : {},
		account: {
			authenticated: true,
			uid: session.gameUserId || session.loginId,
			loginId: session.loginId,
			gameUserId: session.gameUserId,
			passwordLoginEnabled: session.passwordLoginEnabled,
			hasCharacter: Boolean(character),
			displayName: session.displayName
		},
		...summary ? { summary } : {},
		...mapData ? { mapData } : {},
		...regionMap ? { regionMap } : {},
		...nearby ? { nearby: {
			description: String(nearby.description ?? ""),
			range: Number(nearby.range ?? nearby.actionRange ?? 0),
			actionRange: Number(nearby.actionRange ?? nearby.range ?? 0),
			points: (nearby.points ?? []).map((point) => ({
				type: String(point.type),
				name: String(point.name),
				x: Number(point.x),
				y: Number(point.y),
				z: Number(point.z),
				distance: Number(point.distance),
				...point.code ? { code: point.code } : {},
				...point.interaction ? { interaction: {
					type: String(point.interaction.type),
					id: String(point.interaction.id)
				} } : {},
				...point.observedOnly !== void 0 ? { observedOnly: point.observedOnly } : {}
			}))
		} } : {},
		...inventory ? { inventory: {
			stacked: inventory.stacked.map((item) => ({
				id: Number(item.id),
				code: String(item.code),
				name: String(item.name),
				itemType: String(item.item_type),
				itemCategory: String(item.item_category),
				quantity: Number(item.quantity),
				description: String(item.description ?? "")
			})),
			instances: inventory.instances.map((item) => ({
				id: Number(item.id),
				code: String(item.code),
				definitionCodexId: String(item.definition_codex_id),
				name: String(item.name),
				itemType: String(item.item_type),
				itemCategory: String(item.item_category),
				quality: Number(item.quality),
				durability: Number(item.durability),
				durabilityMax: Number(item.durability_max),
				boundKind: String(item.bound_kind ?? ""),
				description: String(item.description ?? "")
			})),
			recent: inventory.recent.map((item) => ({
				id: Number(item.id),
				code: String(item.code),
				name: String(item.name),
				itemType: String(item.item_type),
				itemCategory: String(item.item_category)
			}))
		} } : {},
		...skillData ? { skills: {
			skillPoints: Number(skillData.skillPoints),
			passiveLinkLimit: Number(skillData.passiveLinkLimit),
			skills: skillData.skills.map((skill) => ({
				id: Number(skill.id),
				code: String(skill.code),
				name: String(skill.name),
				category: String(skill.category),
				tier: String(skill.tier),
				level: Number(skill.level),
				quickSlot: skill.quick_slot == null ? null : Number(skill.quick_slot),
				passiveLinked: Boolean(skill.passive_linked)
			})),
			discoveries: skillData.discoveries.map((skill) => ({
				id: Number(skill.id),
				name: String(skill.name),
				category: String(skill.category),
				tier: String(skill.tier),
				learnCost: Number(skill.learn_cost)
			}))
		} } : {},
		evolution: {
			unlocked: realmStage >= 3,
			level: Number(character?.level ?? 1),
			title: realmStage >= 3 ? `进化阶段 ${realmStage}` : "初始形态",
			progress: realmStage >= 3 ? 100 : 0,
			nextRequirement: realmStage >= 3 ? "继续积累进化观察" : "完成开化剧情后开放进化功能。"
		},
		...autoPve ? {
			autoBattle: {
				mode: "pve",
				enabled: Boolean(autoPve.settings?.enabled),
				potionEnabled: Boolean(autoPve.settings?.auto_potion_enabled),
				hpThreshold: Number(autoPve.settings?.hp_threshold ?? 30),
				mpThreshold: Number(autoPve.settings?.mp_threshold ?? 30),
				hpItemName: autoPve.settings?.hp_item_name ?? null,
				mpItemName: autoPve.settings?.mp_item_name ?? null,
				defaultAction: autoPve.settings?.default_encounter_action ?? "battle",
				actions: autoPve.actions ?? []
			},
			autoBattlePvp: autoPvp ? {
				enabled: Boolean(autoPvp.settings?.enabled),
				actions: autoPvp.actions ?? []
			} : null
		} : {},
		menu: desktopMenuFor(session, character)
	};
};

//#endregion
export { appQuickPanel, executeAppCommand, pendingAppStory };