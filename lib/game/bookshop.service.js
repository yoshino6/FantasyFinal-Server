import { recordAchievement } from "./achievement-events.js";
import { achievementBookSource } from "./achievement-state.js";
import { recordCharacterOperation } from "./character-operation.service.js";
import { consumeInventory, grantInventory } from "./inventory-binding.js";
import { getPool, withTransaction } from "../database/pool.js";
import { recordPvpLootSale } from "./pvp.service.js";
import { randomUUID } from "node:crypto";

//#region src/game/bookshop.service.ts
const PAGE_SIZE = 5;
const BOOKSHOP_TARGET_ID = "bookshop";
const characterFor = async (connection, qqUserId, lock = false) => {
	const [rows] = await connection.execute(`SELECT c.id,c.copper_coins,c.activity_status,c.current_region_id,c.pos_x,c.pos_y,c.pos_z FROM characters c JOIN players p ON p.id=c.player_id WHERE p.qq_user_id=? LIMIT 1${lock ? " FOR UPDATE" : ""}`, [qqUserId]);
	if (!rows[0]) throw new Error("请先注册角色。");
	return rows[0];
};
const requireBookshopAtCurrentPosition = async (connection, character) => {
	const [rows] = await connection.execute(`SELECT 1 FROM map_npcs WHERE code=? AND region_id=? AND pos_x=? AND pos_y=? AND pos_z=? LIMIT 1`, [
		BOOKSHOP_TARGET_ID,
		character.current_region_id,
		character.pos_x,
		character.pos_y,
		character.pos_z
	]);
	if (!rows[0]) throw new Error("你已经离开该目标坐标，无法继续互动。");
};
const assertBookshopFree = async (connection, character) => {
	if (character.activity_status !== "active") throw new Error("当前状态无法在百味书屋买卖。");
	const [travel] = await connection.execute("SELECT 1 FROM player_travels WHERE character_id=? LIMIT 1", [character.id]);
	if (travel[0]) throw new Error("旅行途中无法在百味书屋买卖。");
	const [combat] = await connection.execute(`SELECT 1 FROM combat_sessions cs
    LEFT JOIN combat_members cm ON cm.session_id=cs.id
    WHERE cs.state='active' AND (cs.character_id=? OR cm.character_id=?) LIMIT 1`, [character.id, character.id]);
	if (combat[0]) throw new Error("战斗中无法在百味书屋买卖。");
	const [pvp] = await connection.execute(`SELECT 1 FROM player_pvp_battle_sessions
    WHERE state='active' AND (attacker_character_id=? OR defender_character_id=?) LIMIT 1`, [character.id, character.id]);
	if (pvp[0]) throw new Error("玩家对战中无法在百味书屋买卖。");
};
const bookshopCharacterFor = async (connection, qqUserId, lock = false) => {
	const character = await characterFor(connection, qqUserId, lock);
	await requireBookshopAtCurrentPosition(connection, character);
	await assertBookshopFree(connection, character);
	return character;
};
const requireBookshopTarget = async (connection, qqUserId, targetId, lock = false) => {
	if (targetId !== "bookshop") throw new Error("书屋目标无效。");
	const character = await bookshopCharacterFor(connection, qqUserId, lock);
	return {
		characterId: Number(character.id),
		target: {
			id: BOOKSHOP_TARGET_ID,
			name: "百味书屋",
			locationRequired: true
		}
	};
};
const paging = (page, total) => ({
	page: Math.min(Math.max(1, page), Math.max(1, Math.ceil(total / PAGE_SIZE))),
	totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE))
});
const amountOf = (value) => {
	if (!Number.isInteger(value) || value < 1 || value > 999) throw new Error("数量必须是 1 至 999 之间的整数。");
	return value;
};
const bookshopCatalog = async (qqUserId, page = 1, keyword = "") => {
	const pool = await getPool();
	const character = await bookshopCharacterFor(pool, qqUserId);
	const term = `%${keyword.trim()}%`;
	const [countRows] = await pool.execute("SELECT COUNT(*) AS total FROM bookshop_items bs JOIN item_definitions i ON i.id=bs.item_id WHERE bs.is_active=1 AND i.name LIKE ?", [term]);
	const info = paging(page, Number(countRows[0]?.total ?? 0));
	const [rows] = await pool.execute(`SELECT i.id,i.codex_id,i.name,i.item_category,i.description,bs.buy_price,bs.stock_quantity,COALESCE(pi.quantity,0) AS owned_quantity
    FROM bookshop_items bs JOIN item_definitions i ON i.id=bs.item_id LEFT JOIN player_inventory pi ON pi.character_id=? AND pi.item_id=i.id
    WHERE bs.is_active=1 AND i.name LIKE ? ORDER BY i.id LIMIT ? OFFSET ?`, [
		character.id,
		term,
		String(PAGE_SIZE),
		String((info.page - 1) * PAGE_SIZE)
	]);
	return {
		...info,
		keyword: keyword.trim(),
		copper: Number(character.copper_coins),
		items: rows.map((row) => ({
			id: Number(row.id),
			codexId: row.codex_id,
			name: row.name,
			category: row.item_category,
			description: row.description,
			price: Number(row.buy_price),
			stockQuantity: Number(row.stock_quantity),
			ownedQuantity: Number(row.owned_quantity)
		}))
	};
};
const bookshopSellCatalog = async (qqUserId, page = 1, keyword = "") => {
	const pool = await getPool();
	const character = await bookshopCharacterFor(pool, qqUserId);
	const term = `%${keyword.trim()}%`;
	const where = "pi.character_id=? AND pi.quantity>0 AND i.is_tradeable=1 AND i.trade_price>0 AND i.item_category IN ('书籍','卷宗','技能书') AND i.name LIKE ?";
	const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM player_inventory pi JOIN item_definitions i ON i.id=pi.item_id WHERE ${where}`, [character.id, term]);
	const info = paging(page, Number(countRows[0]?.total ?? 0));
	const [rows] = await pool.execute(`SELECT i.id,i.name,i.item_category,pi.quantity,CEIL(i.trade_price*1.20) AS price FROM player_inventory pi JOIN item_definitions i ON i.id=pi.item_id WHERE ${where} ORDER BY i.item_category,i.name LIMIT ? OFFSET ?`, [
		character.id,
		term,
		String(PAGE_SIZE),
		String((info.page - 1) * PAGE_SIZE)
	]);
	return {
		...info,
		keyword: keyword.trim(),
		copper: Number(character.copper_coins),
		items: rows.map((row) => ({
			id: Number(row.id),
			name: row.name,
			category: row.item_category,
			quantity: Number(row.quantity),
			price: Number(row.price)
		}))
	};
};
const bookshopItemDetail = async (qqUserId, itemId) => {
	const pool = await getPool();
	const character = await bookshopCharacterFor(pool, qqUserId);
	const [rows] = await pool.execute(`SELECT i.id,i.codex_id,i.name,i.item_category,i.description,bs.buy_price,bs.stock_quantity,COALESCE(pi.quantity,0) AS owned_quantity
    FROM bookshop_items bs JOIN item_definitions i ON i.id=bs.item_id LEFT JOIN player_inventory pi ON pi.character_id=? AND pi.item_id=i.id
    WHERE bs.item_id=? AND bs.is_active=1 LIMIT 1`, [character.id, itemId]);
	const item = rows[0];
	if (!item) throw new Error("这本书已下架。");
	return {
		copper: Number(character.copper_coins),
		item: {
			id: Number(item.id),
			codexId: item.codex_id,
			name: item.name,
			category: item.item_category,
			description: item.description,
			price: Number(item.buy_price),
			stockQuantity: Number(item.stock_quantity),
			ownedQuantity: Number(item.owned_quantity)
		}
	};
};
const buyBookshopItemInTransaction = async (connection, qqUserId, itemId, quantity = 1, preview = false) => {
	const amount = amountOf(quantity);
	const character = await bookshopCharacterFor(connection, qqUserId, true);
	const [rows] = await connection.execute("SELECT i.name,i.code,i.item_category,i.is_tradeable,JSON_UNQUOTE(JSON_EXTRACT(i.effect_json,'$.skillBook')) AS skill_code,bs.buy_price,bs.stock_quantity FROM bookshop_items bs JOIN item_definitions i ON i.id=bs.item_id WHERE bs.item_id=? AND bs.is_active=1 FOR UPDATE", [itemId]);
	const item = rows[0];
	if (!item) throw new Error("这本书已下架。");
	if (Number(item.stock_quantity) < amount) throw new Error(`库存不足，剩余 ${item.stock_quantity} 本。`);
	if (item.code.startsWith("skill_book_resident_")) {
		if (amount !== 1) throw new Error("技能书每次只能购买一本。");
		const [known] = await connection.execute(`SELECT 1 FROM skill_definitions s LEFT JOIN player_skills ps ON ps.skill_id=s.id AND ps.character_id=?
      LEFT JOIN player_skill_discoveries d ON d.skill_id=s.id AND d.character_id=? WHERE s.code=? AND (ps.skill_id IS NOT NULL OR d.skill_id IS NOT NULL) LIMIT 1`, [
			character.id,
			character.id,
			item.skill_code
		]);
		if (known[0]) throw new Error("你已经领悟这项技能，无需重复购买技能书。");
	}
	const price = Number(item.buy_price) * amount;
	if (Number(character.copper_coins) < price) throw new Error(`铜币不足，需要 ${price} 铜币。`);
	const quote = {
		itemId,
		name: item.name,
		category: item.item_category,
		quantity: amount,
		unitPrice: Number(item.buy_price),
		price,
		copperBefore: Number(character.copper_coins),
		copperAfter: Number(character.copper_coins) - price,
		stockBefore: Number(item.stock_quantity),
		stockAfter: Number(item.stock_quantity) - amount,
		personalBound: !Number(item.is_tradeable)
	};
	if (preview) return quote;
	const [debit] = await connection.execute("UPDATE characters SET copper_coins=copper_coins-? WHERE id=? AND copper_coins>=?", [
		price,
		character.id,
		price
	]);
	if (debit.affectedRows !== 1) throw new Error("铜币已变化，请重新获取报价。");
	const [decrement] = await connection.execute("UPDATE bookshop_items SET stock_quantity=stock_quantity-? WHERE item_id=? AND is_active=1 AND stock_quantity>=?", [
		amount,
		itemId,
		amount
	]);
	if (decrement.affectedRows !== 1) throw new Error("商品库存已变化，请重新获取报价。");
	await grantInventory(connection, Number(character.id), Number(itemId), {
		trade: item.is_tradeable ? amount : 0,
		personal: item.is_tradeable ? 0 : amount,
		unbound: 0
	});
	await connection.execute("INSERT IGNORE INTO player_item_codex (character_id,item_id) VALUES (?,?)", [character.id, itemId]);
	recordAchievement(connection, Number(character.id), [
		{ metric: "ACH_J16" },
		{ metric: "ACH_K01" },
		{
			metric: "ACH_K08",
			value: price,
			life: true
		},
		{
			metric: "ACH_E23",
			distinct: String(itemId)
		}
	]);
	await recordCharacterOperation(connection, {
		characterId: Number(character.id),
		kind: "bookshop.bought",
		source: {
			system: "bookshop_purchase",
			id: randomUUID(),
			step: "settled"
		},
		outcome: "购入",
		summary: `在书店购买${item.name} ×${amount}`,
		detail: {
			itemId,
			itemName: item.name,
			quantity: amount,
			paidCopper: price
		}
	});
	return quote;
};
const buyBookshopItem = async (qqUserId, itemId, quantity = 1) => withTransaction((connection) => buyBookshopItemInTransaction(connection, qqUserId, itemId, quantity));
const sellBookshopItemInTransaction = async (connection, qqUserId, itemId, quantity = 1, preview = false) => {
	const amount = amountOf(quantity);
	const character = await bookshopCharacterFor(connection, qqUserId, true);
	const [rows] = await connection.execute(`SELECT i.name,i.item_category,i.is_tradeable,i.trade_price,pi.quantity,CEIL(i.trade_price*1.20) AS price FROM player_inventory pi JOIN item_definitions i ON i.id=pi.item_id WHERE pi.character_id=? AND pi.item_id=? FOR UPDATE`, [character.id, itemId]);
	const item = rows[0];
	if (!item || !item.is_tradeable || !Number(item.trade_price) || ![
		"书籍",
		"卷宗",
		"技能书"
	].includes(item.item_category)) throw new Error("店主只收购可交易的书籍、卷宗与技能书。");
	if (Number(item.quantity) < amount) throw new Error(`背包数量不足，当前仅有 ${item.quantity} 本。`);
	const price = Number(item.price) * amount;
	const quote = {
		itemId,
		name: item.name,
		category: item.item_category,
		quantity: amount,
		unitPrice: Number(item.price),
		price,
		copperBefore: Number(character.copper_coins),
		copperAfter: Number(character.copper_coins) + price,
		ownedBefore: Number(item.quantity),
		ownedAfter: Number(item.quantity) - amount
	};
	if (preview) return quote;
	await recordPvpLootSale(connection, Number(character.id), itemId, amount, price);
	await consumeInventory(connection, Number(character.id), itemId, amount);
	await connection.execute("UPDATE characters SET copper_coins=copper_coins+? WHERE id=?", [price, character.id]);
	recordAchievement(connection, Number(character.id), [{
		metric: "ACH_K09",
		value: price,
		life: true
	}]);
	await recordCharacterOperation(connection, {
		characterId: Number(character.id),
		kind: "bookshop.sold",
		source: {
			system: "bookshop_sale",
			id: randomUUID(),
			step: "settled"
		},
		outcome: "售出",
		summary: `向书店出售${item.name} ×${amount}`,
		detail: {
			itemId,
			itemName: item.name,
			quantity: amount,
			receivedCopper: price
		}
	});
	return quote;
};
const sellBookshopItem = async (qqUserId, itemId, quantity = 1) => withTransaction((connection) => sellBookshopItemInTransaction(connection, qqUserId, itemId, quantity));
const readSkillBook = async (qqUserId, itemId) => withTransaction(async (connection) => {
	const character = await characterFor(connection, qqUserId, true);
	const [items] = await connection.execute("SELECT i.name,pi.quantity,i.effect_json FROM player_inventory pi JOIN item_definitions i ON i.id=pi.item_id WHERE pi.character_id=? AND pi.item_id=? FOR UPDATE", [character.id, itemId]);
	const item = items[0];
	if (!item?.quantity) throw new Error("背包中没有这本技能书。");
	const effect = typeof item.effect_json === "string" ? JSON.parse(item.effect_json) : item.effect_json ?? {};
	const skillCode = String(effect.skillBook ?? "");
	if (!skillCode) throw new Error("这不是可研读的技能书。");
	const [skills] = await connection.execute("SELECT id,name FROM skill_definitions WHERE code=? LIMIT 1", [skillCode]);
	const skill = skills[0];
	if (!skill) throw new Error("书中的术式残缺，暂时无法研读。");
	const [discovered] = await connection.execute("SELECT 1 FROM player_skill_discoveries WHERE character_id=? AND skill_id=? FOR UPDATE", [character.id, skill.id]);
	const [learned] = await connection.execute("SELECT 1 FROM player_skills WHERE character_id=? AND skill_id=? FOR UPDATE", [character.id, skill.id]);
	if (discovered[0] || learned[0]) throw new Error(`你已经领悟技能「${skill.name}」。`);
	await connection.execute("UPDATE player_inventory SET quantity=quantity-1 WHERE character_id=? AND item_id=?", [character.id, itemId]);
	await connection.execute("DELETE FROM player_inventory WHERE character_id=? AND item_id=? AND quantity<=0", [character.id, itemId]);
	await connection.execute("INSERT INTO player_skill_discoveries (character_id,skill_id) VALUES (?,?)", [character.id, skill.id]);
	await achievementBookSource(connection, Number(character.id), Number(skill.id), itemId);
	await recordCharacterOperation(connection, {
		characterId: Number(character.id),
		kind: "bookshop.skill_book_read",
		source: {
			system: "skill_book",
			id: `${character.id}:${skill.id}`,
			step: "read"
		},
		outcome: "领悟",
		summary: `研读${item.name}并领悟${skill.name}`,
		detail: {
			itemId,
			bookName: item.name,
			skillId: Number(skill.id),
			skillName: skill.name
		}
	});
	return {
		book: item.name,
		skill: skill.name
	};
});

//#endregion
export { BOOKSHOP_TARGET_ID, bookshopCatalog, bookshopItemDetail, bookshopSellCatalog, buyBookshopItem, buyBookshopItemInTransaction, readSkillBook, requireBookshopAtCurrentPosition, requireBookshopTarget, sellBookshopItem, sellBookshopItemInTransaction };