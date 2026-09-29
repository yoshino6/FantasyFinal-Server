import { recordAchievement } from "./achievement-events.js";
import { recordCharacterOperation } from "./character-operation.service.js";
import { addMaterialCosts, moveMaterialCosts, takeMaterialCosts } from "./talent-material-recovery.js";
import { consumeInventory, grantInventory } from "./inventory-binding.js";
import { getPool, withTransaction } from "../database/pool.js";
import { achievementTrade } from "./achievement-trade.js";

//#region src/game/market.service.ts
const MARKET_PAGE_SIZE = 5;
const MARKET_TYPES = [
	"全部",
	"怪材",
	"锻材",
	"炼材",
	"粒子",
	"药剂",
	"食物",
	"其他"
];
const MARKET_SORTS = [
	"price_asc",
	"price_desc",
	"newest"
];
const eligible = `i.is_tradeable=1 AND i.stackable=1 AND i.trade_price>0
  AND i.item_type IN ('material','consumable') AND COALESCE(JSON_EXTRACT(i.effect_json,'$.personalOnly'),0)=0
  AND i.item_category NOT IN ('地图','货币','任务','剧情')`;
const number = (value) => Number(value ?? 0);
const marketEligibilityReason = (character) => {
	if (!character) return "请先注册角色。";
	if (!Number.isFinite(number(character.level)) || number(character.level) < 10 || !number(character.adventurer_registered)) return "万叶联市仅向 10 级及以上、已登记的冒险者开放。";
	const age = Date.now() - new Date(character.created_at).getTime();
	if (!Number.isFinite(age) || age < 2592e5) return "角色注册满 72 小时后，才能使用万叶联市。";
	return null;
};
const integer = (value, label, min = 1, max = 999) => {
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}必须是 ${min} 至 ${max} 之间的整数。`);
	return value;
};
const pageInfo = (page, total) => ({
	page: Math.max(1, Math.min(Math.max(1, Math.ceil(total / 5)), page)),
	totalPages: Math.max(1, Math.ceil(total / 5))
});
const weekKey = () => {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).formatToParts(/* @__PURE__ */ new Date());
	const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	const date = /* @__PURE__ */ new Date(`${values.year}-${values.month}-${values.day}T00:00:00Z`);
	const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	const day = Math.floor((date.getTime() - start.getTime()) / 864e5) + 1;
	return `${values.year}${String(Math.ceil(day / 7)).padStart(2, "0")}`;
};
const characterFor = async (connection, qqUserId, lock = false) => {
	const [rows] = await connection.execute(`SELECT c.id,c.copper_coins,c.level,c.adventurer_registered,c.created_at
    FROM characters c JOIN players p ON p.id=c.player_id WHERE p.qq_user_id=? LIMIT 1${lock ? " FOR UPDATE" : ""}`, [qqUserId]);
	const reason = marketEligibilityReason(rows[0]);
	if (reason) throw new Error(reason);
	return rows[0];
};
const typeCondition = (type) => {
	if (!MARKET_TYPES.includes(type) || type === "全部") return {
		sql: "",
		params: []
	};
	if (type === "其他") return {
		sql: ` AND i.item_category NOT IN ('怪材','锻材','炼材','粒子','药剂','食物')`,
		params: []
	};
	return {
		sql: " AND i.item_category=?",
		params: [type]
	};
};
const ensureState = async (connection, itemId, anchor) => {
	const [definitions] = await connection.execute("SELECT JSON_EXTRACT(effect_json,'$.referencePrice') reference_price FROM item_definitions WHERE id=?", [itemId]);
	const initial = Math.max(1, Math.round(Number(definitions[0]?.reference_price) || anchor * 2));
	await connection.execute(`INSERT IGNORE INTO market_item_state (item_id,reference_price,npc_anchor_price) VALUES (?,?,?)`, [
		itemId,
		initial,
		Math.max(1, anchor)
	]);
	const [rows] = await connection.execute("SELECT reference_price,npc_anchor_price FROM market_item_state WHERE item_id=? LIMIT 1 FOR UPDATE", [itemId]);
	return {
		reference: number(rows[0]?.reference_price) || initial,
		anchor: number(rows[0]?.npc_anchor_price) || Math.max(1, anchor)
	};
};
const priceBand = (reference) => ({
	min: Math.max(1, Math.ceil(reference * .7)),
	max: Math.max(1, Math.floor(reference * 1.5))
});
const updateReference = async (connection, itemId, oldReference, price, quantity) => {
	const target = Math.round(oldReference * .8 + price * .2);
	const next = Math.max(Math.floor(oldReference * .92), Math.min(Math.ceil(oldReference * 1.08), target));
	await connection.execute(`UPDATE market_item_state SET reference_price=?,daily_buy_volume=daily_buy_volume+?,daily_sell_volume=daily_sell_volume+?,last_trade_at=NOW() WHERE item_id=?`, [
		Math.max(1, next),
		quantity,
		quantity,
		itemId
	]);
};
const rebalanceReference = async (connection, itemId, reference) => {
	const [rows] = await connection.execute(`SELECT
    COALESCE(SUM(CASE WHEN side='buy' THEN quantity_remaining ELSE 0 END),0) AS buy_quantity,
    COALESCE(SUM(CASE WHEN side='sell' THEN quantity_remaining ELSE 0 END),0) AS sell_quantity
    FROM market_orders WHERE item_id=? AND status IN ('open','partial') AND expires_at>NOW()`, [itemId]);
	const buy = number(rows[0]?.buy_quantity);
	const sell = number(rows[0]?.sell_quantity);
	if (!buy && !sell) return;
	const adjustment = Math.max(.9, Math.min(1.1, 1 + Math.log((buy || 1) / Math.max(1, sell)) * .05));
	const target = Math.round(reference * adjustment);
	const next = Math.max(Math.floor(reference * .92), Math.min(Math.ceil(reference * 1.08), target));
	await connection.execute("UPDATE market_item_state SET reference_price=? WHERE item_id=?", [Math.max(1, next), itemId]);
};
const feeForSale = (previous, gross) => {
	const tiers = [
		[1e4, .03],
		[5e4, .05],
		[15e4, .08],
		[5e5, .12],
		[Number.MAX_SAFE_INTEGER, .16]
	];
	let cursor = previous;
	let remaining = gross;
	let fee = 0;
	for (const [limit, rate] of tiers) {
		if (!remaining) break;
		const chunk = Math.min(remaining, Math.max(0, limit - cursor));
		if (chunk) {
			fee += Math.ceil(chunk * rate);
			remaining -= chunk;
			cursor += chunk;
		}
	}
	return Math.min(gross, fee);
};
const weeklySales = async (connection, characterId) => {
	const key = weekKey();
	await connection.execute("INSERT IGNORE INTO market_weekly_volume (character_id,week_key) VALUES (?,?)", [characterId, key]);
	const [rows] = await connection.execute("SELECT gross_sales,fee_paid,cancellation_count FROM market_weekly_volume WHERE character_id=? AND week_key=? FOR UPDATE", [characterId, key]);
	return {
		key,
		gross: number(rows[0]?.gross_sales),
		fees: number(rows[0]?.fee_paid),
		cancellations: number(rows[0]?.cancellation_count)
	};
};
const addInventory = (connection, characterId, itemId, quantity) => connection.execute(`INSERT INTO player_inventory (character_id,item_id,quantity) VALUES (?,?,?)
  ON DUPLICATE KEY UPDATE quantity=quantity+VALUES(quantity),acquired_at=NOW()`, [
	characterId,
	itemId,
	quantity
]);
const settleMatch = async (connection, sell, buy, quantity, price, reference) => {
	const gross = price * quantity;
	const sellerWeek = await weeklySales(connection, number(sell.character_id));
	const [sellers] = await connection.execute("SELECT created_at FROM characters WHERE id=? FOR UPDATE", [sell.character_id]);
	const cap = Date.now() - new Date(sellers[0].created_at).getTime() < 12096e5 ? 2e4 : 3e5;
	if (sellerWeek.gross + gross > cap) throw new Error("卖家本周交易额度已满，请选择其他订单。");
	const fee = feeForSale(sellerWeek.gross, gross);
	const refund = Math.max(0, number(buy.unit_price) - price) * quantity;
	await moveMaterialCosts(connection, "market", number(sell.id), "stock", number(buy.character_id), number(buy.item_id), quantity);
	await grantInventory(connection, number(buy.character_id), number(buy.item_id), {
		unbound: 0,
		personal: 0,
		trade: quantity
	});
	await connection.execute("UPDATE characters SET copper_coins=copper_coins+? WHERE id=?", [gross - fee, sell.character_id]);
	if (refund) await connection.execute("UPDATE characters SET copper_coins=copper_coins+? WHERE id=?", [refund, buy.character_id]);
	await connection.execute("UPDATE market_weekly_volume SET gross_sales=gross_sales+?,fee_paid=fee_paid+? WHERE character_id=? AND week_key=?", [
		gross,
		fee,
		sell.character_id,
		sellerWeek.key
	]);
	const [achievementTradeRow] = await connection.execute(`INSERT INTO market_trades (buy_order_id,sell_order_id,item_id,quantity,unit_price,gross_copper,fee_copper,seller_net_copper)
    VALUES (?,?,?,?,?,?,?,?)`, [
		buy.id,
		sell.id,
		sell.item_id,
		quantity,
		price,
		gross,
		fee,
		gross - fee
	]);
	const tradeId = Number(achievementTradeRow.insertId);
	const [tradedItems] = await connection.execute("SELECT name FROM item_definitions WHERE id=?", [sell.item_id]);
	const itemName = tradedItems[0]?.name ?? `物品 ${sell.item_id}`;
	await recordCharacterOperation(connection, {
		characterId: Number(buy.character_id),
		kind: "market.trade_bought",
		source: {
			system: "market_trade",
			id: tradeId,
			step: "buyer_settled"
		},
		outcome: "成交",
		summary: `买入 ${itemName} ×${quantity}`,
		detail: {
			tradeId,
			orderId: Number(buy.id),
			itemId: Number(sell.item_id),
			itemName,
			quantity,
			unitPrice: price,
			paidCopper: gross,
			refundCopper: refund
		}
	});
	await recordCharacterOperation(connection, {
		characterId: Number(sell.character_id),
		kind: "market.trade_sold",
		source: {
			system: "market_trade",
			id: tradeId,
			step: "seller_settled"
		},
		outcome: "成交",
		summary: `卖出 ${itemName} ×${quantity}`,
		detail: {
			tradeId,
			orderId: Number(sell.id),
			itemId: Number(sell.item_id),
			itemName,
			quantity,
			unitPrice: price,
			grossCopper: gross,
			feeCopper: fee,
			receivedCopper: gross - fee
		}
	});
	await (await import("./finance-settlement.js")).recordFinanceMarketTrade(connection, Number(achievementTradeRow.insertId), Number(sell.character_id), Number(sell.item_id));
	await achievementTrade(connection, Number(buy.character_id), Number(sell.character_id), Number(sell.item_id), gross, gross - fee, "market:" + achievementTradeRow.insertId);
	for (const order of [sell, buy]) {
		const remain = number(order.quantity_remaining) - quantity;
		const reserved = order.side === "buy" ? Math.max(0, number(order.reserved_copper) - number(order.unit_price) * quantity) : 0;
		await connection.execute(`UPDATE market_orders SET quantity_remaining=?,reserved_copper=?,status=? WHERE id=?`, [
			remain,
			reserved,
			remain ? "partial" : "filled",
			order.id
		]);
	}
	await connection.execute("UPDATE market_escrow_items SET quantity=GREATEST(0,quantity-?) WHERE order_id=?", [quantity, sell.id]);
	await updateReference(connection, sell.item_id, reference, price, quantity);
};
const matchOrder = async (connection, order, reference) => {
	const oppositeSide = order.side === "sell" ? "buy" : "sell";
	const operator = order.side === "sell" ? ">=" : "<=";
	const ordering = order.side === "sell" ? "unit_price DESC,created_at ASC,id ASC" : "unit_price ASC,created_at ASC,id ASC";
	const [opposites] = await connection.execute(`SELECT * FROM market_orders WHERE item_id=? AND side=? AND status IN ('open','partial')
    AND quantity_remaining>0 AND expires_at>NOW() AND unit_price ${operator} ? AND character_id<>? ORDER BY ${ordering} FOR UPDATE`, [
		order.item_id,
		oppositeSide,
		order.unit_price,
		order.character_id
	]);
	let remaining = number(order.quantity_remaining);
	for (const opponent of opposites) {
		if (!remaining) break;
		const quantity = Math.min(remaining, number(opponent.quantity_remaining));
		const sell = order.side === "sell" ? order : opponent;
		const buy = order.side === "buy" ? order : opponent;
		const older = new Date(order.created_at).getTime() <= new Date(opponent.created_at).getTime() ? order : opponent;
		await settleMatch(connection, sell, buy, quantity, number(older.unit_price), reference);
		remaining -= quantity;
		order.quantity_remaining = remaining;
		order.reserved_copper = order.side === "buy" ? Math.max(0, number(order.reserved_copper) - number(order.unit_price) * quantity) : 0;
	}
};
const releaseExpiredOwned = async (connection, characterId) => {
	const [orders] = await connection.execute(`SELECT * FROM market_orders WHERE character_id=? AND status IN ('open','partial') AND expires_at<=NOW() FOR UPDATE`, [characterId]);
	for (const order of orders) {
		if (order.side === "sell") {
			await moveMaterialCosts(connection, "market", number(order.id), "stock", characterId, number(order.item_id), number(order.quantity_remaining));
			await addInventory(connection, characterId, number(order.item_id), number(order.quantity_remaining));
		} else if (number(order.reserved_copper)) await connection.execute("UPDATE characters SET copper_coins=copper_coins+? WHERE id=?", [order.reserved_copper, characterId]);
		await connection.execute(`UPDATE market_orders SET status='expired',reserved_copper=0 WHERE id=?`, [order.id]);
		await recordCharacterOperation(connection, {
			characterId,
			kind: "market.order_expired",
			source: {
				system: "market_order",
				id: Number(order.id),
				step: "expired"
			},
			actorRole: "system",
			outcome: "到期",
			summary: `市场订单 ${order.id} 到期返还托管`,
			detail: {
				orderId: Number(order.id),
				side: order.side,
				itemId: Number(order.item_id),
				remaining: Number(order.quantity_remaining),
				refundedCopper: Number(order.reserved_copper)
			}
		});
		await connection.execute("DELETE FROM market_escrow_items WHERE order_id=?", [order.id]);
	}
	return orders.length;
};
const marketCatalog = async (qqUserId, page = 1, type = "全部", keyword = "", sort = "price_asc") => {
	const pool = await getPool();
	const character = await characterFor(pool, qqUserId);
	const filter = typeCondition(type);
	const term = `%${keyword.trim()}%`;
	const from = `FROM item_definitions i LEFT JOIN market_item_state ms ON ms.item_id=i.id
    LEFT JOIN (SELECT item_id,MIN(unit_price) AS lowest_sell,SUM(quantity_remaining) AS sell_quantity FROM market_orders WHERE side='sell' AND status IN ('open','partial') AND quantity_remaining>0 AND expires_at>NOW() GROUP BY item_id) sell ON sell.item_id=i.id
    LEFT JOIN (SELECT item_id,MAX(unit_price) AS highest_buy,SUM(quantity_remaining) AS buy_quantity FROM market_orders WHERE side='buy' AND status IN ('open','partial') AND quantity_remaining>0 AND expires_at>NOW() GROUP BY item_id) buy ON buy.item_id=i.id
    LEFT JOIN (SELECT item_id,MAX(created_at) AS last_order_at FROM market_orders WHERE status IN ('open','partial') AND quantity_remaining>0 AND expires_at>NOW() GROUP BY item_id) latest ON latest.item_id=i.id
    WHERE ${eligible}${filter.sql} AND i.name LIKE ? AND (sell.lowest_sell IS NOT NULL OR buy.highest_buy IS NOT NULL)`;
	const [countRows] = await pool.execute(`SELECT COUNT(*) AS total ${from}`, [...filter.params, term]);
	const paging = pageInfo(page, number(countRows[0]?.total));
	const orderBy = sort === "price_desc" ? "sell.lowest_sell IS NULL,sell.lowest_sell DESC,i.name" : sort === "newest" ? "latest.last_order_at DESC,i.name" : "sell.lowest_sell IS NULL,sell.lowest_sell ASC,i.name";
	const [rows] = await pool.execute(`SELECT i.id,i.name,i.item_category,i.description,i.trade_price,i.stack_limit,
    COALESCE(ms.reference_price,JSON_EXTRACT(i.effect_json,'$.referencePrice'),GREATEST(1,ROUND(i.trade_price*2))) AS reference_price,
    sell.lowest_sell,sell.sell_quantity,buy.highest_buy,buy.buy_quantity,latest.last_order_at ${from}
    ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [
		...filter.params,
		term,
		String(5),
		String((paging.page - 1) * 5)
	]);
	return {
		...paging,
		type: MARKET_TYPES.includes(type) ? type : "全部",
		keyword: keyword.trim(),
		sort: MARKET_SORTS.includes(sort) ? sort : "price_asc",
		copper: number(character.copper_coins),
		items: rows.map((row) => ({
			id: number(row.id),
			name: row.name,
			category: row.item_category,
			reference: number(row.reference_price),
			lowestSell: row.lowest_sell === null ? null : number(row.lowest_sell),
			sellQuantity: number(row.sell_quantity),
			highestBuy: row.highest_buy === null ? null : number(row.highest_buy),
			buyQuantity: number(row.buy_quantity),
			latestOrderAt: row.last_order_at
		}))
	};
};
/** 求购选物目录：包含当前没有公开挂单、但规则允许交易的堆叠物品。 */
const marketTradables = async (qqUserId, page = 1, type = "全部", keyword = "") => {
	const pool = await getPool();
	const character = await characterFor(pool, qqUserId);
	const filter = typeCondition(type);
	const term = `%${keyword.trim()}%`;
	const where = `WHERE ${eligible}${filter.sql} AND i.name LIKE ?`;
	const [counts] = await pool.execute(`SELECT COUNT(*) AS total FROM item_definitions i ${where}`, [...filter.params, term]);
	const paging = pageInfo(page, number(counts[0]?.total));
	const [items] = await pool.execute(`SELECT i.id,i.name,i.item_category,i.description,i.trade_price,i.stack_limit,
    COALESCE(ms.reference_price,JSON_EXTRACT(i.effect_json,'$.referencePrice'),GREATEST(1,ROUND(i.trade_price*2))) AS reference_price
    FROM item_definitions i LEFT JOIN market_item_state ms ON ms.item_id=i.id ${where}
    ORDER BY i.item_category,i.name,i.id LIMIT ? OFFSET ?`, [
		...filter.params,
		term,
		String(5),
		String((paging.page - 1) * 5)
	]);
	return {
		...paging,
		type: MARKET_TYPES.includes(type) ? type : "全部",
		keyword: keyword.trim(),
		copper: number(character.copper_coins),
		items: items.map((item) => {
			const reference = number(item.reference_price) || Math.max(1, Math.round(number(item.trade_price) * 2));
			return {
				id: number(item.id),
				name: item.name,
				category: item.item_category,
				description: item.description,
				stackLimit: number(item.stack_limit),
				reference,
				band: priceBand(reference)
			};
		})
	};
};
const marketSellable = async (qqUserId, page = 1, keyword = "") => {
	const pool = await getPool();
	const character = await characterFor(pool, qqUserId);
	const term = `%${keyword.trim()}%`;
	const where = `pi.character_id=? AND pi.quantity-pi.trade_bound_quantity-pi.personal_bound_quantity>0 AND ${eligible} AND i.name LIKE ?`;
	const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM player_inventory pi JOIN item_definitions i ON i.id=pi.item_id WHERE ${where}`, [character.id, term]);
	const paging = pageInfo(page, number(countRows[0]?.total));
	const [rows] = await pool.execute(`SELECT i.id,i.name,i.item_category,i.description,i.trade_price,i.stack_limit,(pi.quantity-pi.trade_bound_quantity-pi.personal_bound_quantity) AS quantity,
    COALESCE(ms.reference_price,JSON_EXTRACT(i.effect_json,'$.referencePrice'),GREATEST(1,ROUND(i.trade_price*2))) AS reference_price
    FROM player_inventory pi JOIN item_definitions i ON i.id=pi.item_id LEFT JOIN market_item_state ms ON ms.item_id=i.id WHERE ${where} ORDER BY i.item_category,i.name LIMIT ? OFFSET ?`, [
		character.id,
		term,
		String(5),
		String((paging.page - 1) * 5)
	]);
	return {
		...paging,
		keyword: keyword.trim(),
		items: rows.map((row) => ({
			id: number(row.id),
			name: row.name,
			category: row.item_category,
			quantity: number(row.quantity),
			reference: number(row.reference_price) || Math.max(1, Math.round(number(row.trade_price) * 2))
		}))
	};
};
const marketItemDetail = async (qqUserId, itemId) => {
	const pool = await getPool();
	await characterFor(pool, qqUserId);
	const [rows] = await pool.execute(`SELECT i.id,i.name,i.item_category,i.description,i.trade_price,i.stack_limit,
    COALESCE(ms.reference_price,JSON_EXTRACT(i.effect_json,'$.referencePrice'),GREATEST(1,ROUND(i.trade_price*2))) AS reference_price,sell.lowest_sell,buy.highest_buy,
    (SELECT COALESCE(SUM(mt.quantity),0) FROM market_trades mt WHERE mt.item_id=i.id AND mt.created_at>=DATE_SUB(NOW(),INTERVAL 24 HOUR)) AS volume
    FROM item_definitions i LEFT JOIN market_item_state ms ON ms.item_id=i.id
    LEFT JOIN (SELECT item_id,MIN(unit_price) AS lowest_sell FROM market_orders WHERE side='sell' AND status IN ('open','partial') AND quantity_remaining>0 AND expires_at>NOW() GROUP BY item_id) sell ON sell.item_id=i.id
    LEFT JOIN (SELECT item_id,MAX(unit_price) AS highest_buy FROM market_orders WHERE side='buy' AND status IN ('open','partial') AND quantity_remaining>0 AND expires_at>NOW() GROUP BY item_id) buy ON buy.item_id=i.id WHERE i.id=? AND ${eligible} LIMIT 1`, [itemId]);
	const item = rows[0];
	if (!item) throw new Error("该物品暂不支持在万叶联市交易。");
	const reference = number(item.reference_price) || Math.max(1, Math.round(number(item.trade_price) * 2));
	return {
		id: number(item.id),
		name: item.name,
		category: item.item_category,
		description: item.description,
		reference,
		band: priceBand(reference),
		lowestSell: item.lowest_sell === null ? null : number(item.lowest_sell),
		highestBuy: item.highest_buy === null ? null : number(item.highest_buy),
		volume: number(item.volume)
	};
};
const prepareOrder = async (connection, qqUserId, itemId, unitPrice, quantity, side) => {
	const price = integer(unitPrice, "单价", 1, 99999999);
	const amount = integer(quantity, "数量");
	const character = await characterFor(connection, qqUserId, true);
	await releaseExpiredOwned(connection, character.id);
	const [items] = await connection.execute(`SELECT i.id,i.name,i.item_category,i.description,i.trade_price,i.stack_limit FROM item_definitions i WHERE i.id=? AND ${eligible} LIMIT 1 FOR UPDATE`, [itemId]);
	const item = items[0];
	if (!item) throw new Error("该物品不可在万叶联市交易。");
	if (amount > number(item.stack_limit)) throw new Error(`单笔数量不能超过该物品的堆叠上限 ${item.stack_limit}。`);
	const state = await ensureState(connection, number(item.id), number(item.trade_price));
	const band = priceBand(state.reference);
	if (price < band.min || price > band.max) throw new Error(`当前参考价为 ${state.reference} 铜币，挂单单价需在 ${band.min} 至 ${band.max} 铜币之间。`);
	const [openRows] = await connection.execute(`SELECT COUNT(*) AS total FROM market_orders WHERE character_id=? AND status IN ('open','partial') FOR UPDATE`, [character.id]);
	const [instances] = await connection.execute("SELECT COUNT(*) total,COALESCE(SUM(price),0) reserved FROM market_instance_listings WHERE seller_id=? AND status='open'", [character.id]);
	if (number(openRows[0]?.total) + number(instances[0]?.total) >= 60) throw new Error("同时进行中的市场订单最多为 60 笔。");
	const [dailyRows] = await connection.execute(`SELECT COUNT(*) AS total FROM market_orders WHERE character_id=? AND item_id=? AND created_at>=CURDATE() FOR UPDATE`, [character.id, itemId]);
	if (number(dailyRows[0]?.total) >= 20) throw new Error("同一物品每天最多发布 20 笔订单。");
	const week = await weeklySales(connection, character.id);
	const weeklyCap = Math.floor((Date.now() - new Date(character.created_at).getTime()) / 864e5) < 14 ? 2e4 : 3e5;
	const [held] = await connection.execute("SELECT COALESCE(SUM(unit_price*quantity_remaining),0) reserved FROM market_orders WHERE character_id=? AND side='sell' AND status IN ('open','partial')", [character.id]);
	if (side === "sell" && week.gross + number(held[0]?.reserved) + number(instances[0]?.reserved) + price * amount > weeklyCap) throw new Error(`本周寄售额将超过 ${weeklyCap} 铜币的交易额度。`);
	const reserved = side === "buy" ? price * amount : 0;
	let availableQuantity = 0;
	const [wallet] = await connection.execute("SELECT copper_coins FROM characters WHERE id=? FOR UPDATE", [character.id]);
	const copper = number(wallet[0]?.copper_coins);
	if (side === "sell") {
		const [inventory] = await connection.execute(`SELECT quantity-trade_bound_quantity-personal_bound_quantity AS available
      FROM player_inventory WHERE character_id=? AND item_id=? FOR UPDATE`, [character.id, itemId]);
		availableQuantity = number(inventory[0]?.available);
		if (availableQuantity < amount) throw new Error("背包中的未绑定物品数量不足。");
	} else {
		if (reserved > 1e5) throw new Error("单笔求购的托管金额不能超过 100000 铜币。");
		if (copper < reserved) throw new Error(`铜币不足，需要托管 ${reserved} 铜币。`);
	}
	return {
		character,
		item,
		state,
		band,
		week,
		price,
		amount,
		reserved,
		availableQuantity,
		copper
	};
};
const marketOrderQuoteInTransaction = async (connection, qqUserId, itemId, price, quantity, side) => {
	const plan = await prepareOrder(connection, qqUserId, itemId, price, quantity, side);
	const [opposites] = await connection.execute(`SELECT COALESCE(SUM(quantity_remaining),0) AS quantity
    FROM market_orders WHERE item_id=? AND side=? AND status IN ('open','partial') AND quantity_remaining>0
      AND expires_at>NOW() AND character_id<>? AND unit_price ${side === "buy" ? "<=" : ">="} ?`, [
		itemId,
		side === "buy" ? "sell" : "buy",
		plan.character.id,
		plan.price
	]);
	const gross = plan.price * plan.amount;
	const estimatedFee = side === "sell" ? feeForSale(plan.week.gross, gross) : 0;
	return {
		side,
		itemId,
		name: plan.item.name,
		category: plan.item.item_category,
		price: plan.price,
		quantity: plan.amount,
		reference: plan.state.reference,
		band: plan.band,
		copper: plan.copper,
		availableQuantity: plan.availableQuantity,
		reservedCopper: plan.reserved,
		grossCopper: gross,
		estimatedFeeCopper: estimatedFee,
		estimatedNetCopper: side === "sell" ? gross - estimatedFee : 0,
		matchableQuantityEstimate: Math.min(plan.amount, number(opposites[0]?.quantity)),
		orderExpiresHours: 72
	};
};
const createMarketOrderInTransaction = async (connection, qqUserId, itemId, unitPrice, quantity, side) => {
	const { character, item, state, price, amount, reserved } = await prepareOrder(connection, qqUserId, itemId, unitPrice, quantity, side);
	let materialCost = {
		quantity: 0,
		paid: {}
	};
	if (side === "sell") {
		materialCost = await takeMaterialCosts(connection, "stock", character.id, itemId, amount);
		await consumeInventory(connection, character.id, itemId, amount, true);
		await connection.execute("DELETE FROM player_inventory WHERE character_id=? AND item_id=? AND quantity<=0", [character.id, itemId]);
	} else await connection.execute("UPDATE characters SET copper_coins=copper_coins-? WHERE id=?", [reserved, character.id]);
	const [insert] = await connection.execute(`INSERT INTO market_orders (character_id,item_id,side,unit_price,quantity_total,quantity_remaining,reserved_copper,expires_at)
    VALUES (?,?,?,?,?,?,?,DATE_ADD(NOW(),INTERVAL 72 HOUR))`, [
		character.id,
		itemId,
		side,
		price,
		amount,
		amount,
		reserved
	]);
	const order = {
		id: number(insert.insertId),
		character_id: character.id,
		item_id: itemId,
		side,
		unit_price: price,
		quantity_total: amount,
		quantity_remaining: amount,
		reserved_copper: reserved,
		status: "open",
		created_at: /* @__PURE__ */ new Date(),
		expires_at: new Date(Date.now() + 2592e5)
	};
	if (side === "sell") await addMaterialCosts(connection, "market", Number(order.id), itemId, materialCost);
	if (side === "sell") await connection.execute("INSERT INTO market_escrow_items (order_id,character_id,item_id,quantity) VALUES (?,?,?,?)", [
		order.id,
		character.id,
		itemId,
		amount
	]);
	await matchOrder(connection, order, state.reference);
	await rebalanceReference(connection, itemId, state.reference);
	const [current] = await connection.execute("SELECT * FROM market_orders WHERE id=? LIMIT 1", [order.id]);
	await recordCharacterOperation(connection, {
		characterId: Number(character.id),
		kind: "market.order_placed",
		source: {
			system: "market_order",
			id: Number(order.id),
			step: "placed"
		},
		outcome: current[0]?.status ?? "open",
		summary: `${side === "buy" ? "求购" : "寄售"} ${item.name} ×${amount}`,
		detail: {
			orderId: Number(order.id),
			side,
			itemId,
			itemName: item.name,
			quantity: amount,
			unitPrice: price,
			reservedCopper: reserved
		}
	});
	if (side === "sell") recordAchievement(connection, Number(character.id), ["ACH_K03"]);
	const [trades] = await connection.execute(`SELECT quantity,gross_copper,fee_copper,seller_net_copper
    FROM market_trades WHERE ${side === "buy" ? "buy_order_id" : "sell_order_id"}=?`, [order.id]);
	return {
		orderId: order.id,
		itemId,
		name: item.name,
		side,
		price,
		quantity: amount,
		remaining: number(current[0]?.quantity_remaining),
		status: current[0]?.status ?? "open",
		reservedCopper: number(current[0]?.reserved_copper),
		expiresAt: current[0]?.expires_at ?? order.expires_at,
		matchedQuantity: trades.reduce((sum, trade) => sum + number(trade.quantity), 0),
		tradedCopper: trades.reduce((sum, trade) => sum + number(trade.gross_copper), 0),
		feeCopper: trades.reduce((sum, trade) => sum + number(trade.fee_copper), 0),
		receivedCopper: trades.reduce((sum, trade) => sum + number(trade.seller_net_copper), 0)
	};
};
const createOrder = (qqUserId, itemId, unitPrice, quantity, side) => withTransaction((connection) => createMarketOrderInTransaction(connection, qqUserId, itemId, unitPrice, quantity, side));
const createMarketSellOrder = (qqUserId, itemId, price, quantity) => createOrder(qqUserId, itemId, price, quantity, "sell");
const createMarketBuyOrder = (qqUserId, itemId, price, quantity) => createOrder(qqUserId, itemId, price, quantity, "buy");
const marketOrders = (qqUserId) => withTransaction(async (connection) => {
	const character = await characterFor(connection, qqUserId, true);
	await releaseExpiredOwned(connection, character.id);
	const [orders] = await connection.execute(`SELECT o.*,i.name,i.item_category FROM market_orders o JOIN item_definitions i ON i.id=o.item_id
    WHERE o.character_id=? ORDER BY o.created_at DESC LIMIT 20`, [character.id]);
	const volume = await weeklySales(connection, character.id);
	const [wallet] = await connection.execute("SELECT copper_coins FROM characters WHERE id=?", [character.id]);
	return {
		copper: number(wallet[0]?.copper_coins),
		volume,
		orders: orders.map((order) => ({
			id: number(order.id),
			itemId: number(order.item_id),
			name: order.name,
			category: order.item_category,
			side: order.side,
			price: number(order.unit_price),
			remaining: number(order.quantity_remaining),
			total: number(order.quantity_total),
			status: order.status,
			expiresAt: order.expires_at
		}))
	};
});
const marketOrderPage = (qqUserId, requestedPage = 1) => withTransaction(async (connection) => {
	const character = await characterFor(connection, qqUserId, true);
	await releaseExpiredOwned(connection, character.id);
	const [counts] = await connection.execute("SELECT COUNT(*) AS total FROM market_orders WHERE character_id=?", [character.id]);
	const total = number(counts[0]?.total);
	const totalPages = Math.max(1, Math.ceil(total / 20));
	const page = Math.min(totalPages, Math.max(1, requestedPage));
	const [orders] = await connection.execute(`SELECT o.*,i.name,i.item_category FROM market_orders o JOIN item_definitions i ON i.id=o.item_id
    WHERE o.character_id=? ORDER BY CASE WHEN o.status IN ('open','partial') THEN 0 ELSE 1 END,o.created_at DESC,o.id DESC LIMIT 20 OFFSET ?`, [character.id, String((page - 1) * 20)]);
	const volume = await weeklySales(connection, character.id);
	const [wallet] = await connection.execute("SELECT copper_coins FROM characters WHERE id=?", [character.id]);
	return {
		page,
		totalPages,
		total,
		copper: number(wallet[0]?.copper_coins),
		volume,
		orders: orders.map((order) => ({
			id: number(order.id),
			itemId: number(order.item_id),
			name: order.name,
			category: order.item_category,
			side: order.side,
			price: number(order.unit_price),
			remaining: number(order.quantity_remaining),
			total: number(order.quantity_total),
			reservedCopper: number(order.reserved_copper),
			status: order.status,
			createdAt: order.created_at,
			expiresAt: order.expires_at
		}))
	};
});
const marketTradePage = (qqUserId, requestedPage = 1) => withTransaction(async (connection) => {
	const character = await characterFor(connection, qqUserId);
	const from = `FROM market_trades trade JOIN market_orders buy_order ON buy_order.id=trade.buy_order_id
    JOIN market_orders sell_order ON sell_order.id=trade.sell_order_id JOIN item_definitions item ON item.id=trade.item_id
    WHERE buy_order.character_id=? OR sell_order.character_id=?`;
	const [counts] = await connection.execute(`SELECT COUNT(*) AS total ${from}`, [character.id, character.id]);
	const total = number(counts[0]?.total);
	const totalPages = Math.max(1, Math.ceil(total / 20));
	const page = Math.min(totalPages, Math.max(1, requestedPage));
	const [trades] = await connection.execute(`SELECT trade.id,trade.item_id,item.name,item.item_category,
    CASE WHEN buy_order.character_id=? THEN 'buy' ELSE 'sell' END AS side,
    trade.quantity,trade.unit_price,trade.gross_copper,trade.fee_copper,trade.seller_net_copper,trade.created_at ${from}
    ORDER BY trade.created_at DESC,trade.id DESC LIMIT 20 OFFSET ?`, [
		character.id,
		character.id,
		character.id,
		String((page - 1) * 20)
	]);
	return {
		page,
		totalPages,
		total,
		trades: trades.map((trade) => ({
			id: number(trade.id),
			itemId: number(trade.item_id),
			name: trade.name,
			category: trade.item_category,
			side: trade.side,
			quantity: number(trade.quantity),
			price: number(trade.unit_price),
			grossCopper: number(trade.gross_copper),
			feeCopper: trade.side === "sell" ? number(trade.fee_copper) : 0,
			receivedCopper: trade.side === "sell" ? number(trade.seller_net_copper) : 0,
			createdAt: trade.created_at
		}))
	};
});
const marketMyListings = (qqUserId) => withTransaction(async (connection) => {
	const character = await characterFor(connection, qqUserId, true);
	await releaseExpiredOwned(connection, character.id);
	const [orders] = await connection.execute(`SELECT o.*,i.name,i.item_category FROM market_orders o JOIN item_definitions i ON i.id=o.item_id
    WHERE o.character_id=? AND o.side='sell' AND o.status IN ('open','partial') ORDER BY o.created_at DESC,o.id DESC LIMIT 60`, [character.id]);
	return orders.map((order) => ({
		id: number(order.id),
		itemId: number(order.item_id),
		name: order.name,
		category: order.item_category,
		price: number(order.unit_price),
		remaining: number(order.quantity_remaining),
		total: number(order.quantity_total),
		status: order.status,
		expiresAt: order.expires_at
	}));
});
const prepareCancellation = async (connection, qqUserId, orderId) => {
	integer(orderId, "订单编号", 1, Number.MAX_SAFE_INTEGER);
	const character = await characterFor(connection, qqUserId, true);
	await releaseExpiredOwned(connection, character.id);
	const [orders] = await connection.execute("SELECT * FROM market_orders WHERE id=? AND character_id=? AND status IN ('open','partial') LIMIT 1 FOR UPDATE", [orderId, character.id]);
	const order = orders[0];
	if (!order) throw new Error("该订单已完成、已结束或不属于你。");
	const volume = await weeklySales(connection, character.id);
	const rate = Date.now() - new Date(order.created_at).getTime() < 12e4 ? volume.cancellations >= 5 ? .02 : .005 : 0;
	const fee = rate ? Math.max(1, Math.ceil(number(order.quantity_remaining) * number(order.unit_price) * rate)) : 0;
	const [wallet] = await connection.execute("SELECT copper_coins FROM characters WHERE id=? FOR UPDATE", [character.id]);
	if (order.side === "sell" && number(wallet[0]?.copper_coins) < fee) throw new Error(`快速撤单需支付 ${fee} 铜币手续费，当前铜币不足。`);
	if (order.side === "buy" && number(order.reserved_copper) < fee) throw new Error("该订单的托管余额不足以支付快速撤单费用。");
	return {
		character,
		order,
		volume,
		fee
	};
};
const marketCancelQuoteInTransaction = async (connection, qqUserId, orderId) => {
	const { order, fee } = await prepareCancellation(connection, qqUserId, orderId);
	return {
		orderId: number(order.id),
		itemId: number(order.item_id),
		side: order.side,
		price: number(order.unit_price),
		quantity: number(order.quantity_remaining),
		reservedCopper: number(order.reserved_copper),
		feeCopper: fee,
		refundedCopper: order.side === "buy" ? number(order.reserved_copper) - fee : 0,
		returnedQuantity: order.side === "sell" ? number(order.quantity_remaining) : 0
	};
};
const cancelMarketOrderInTransaction = async (connection, qqUserId, orderId) => {
	const { character, order, volume, fee } = await prepareCancellation(connection, qqUserId, orderId);
	if (order.side === "sell") {
		await moveMaterialCosts(connection, "market", number(order.id), "stock", character.id, number(order.item_id), number(order.quantity_remaining));
		await addInventory(connection, character.id, number(order.item_id), number(order.quantity_remaining));
	}
	if (order.side === "buy" && number(order.reserved_copper)) {
		const refund = number(order.reserved_copper) - fee;
		await connection.execute("UPDATE characters SET copper_coins=copper_coins+? WHERE id=?", [refund, character.id]);
	}
	if (order.side === "sell" && fee) await connection.execute("UPDATE characters SET copper_coins=copper_coins-? WHERE id=?", [fee, character.id]);
	await connection.execute(`UPDATE market_orders SET status='cancelled',reserved_copper=0 WHERE id=?`, [order.id]);
	const [cancelledItems] = await connection.execute("SELECT name FROM item_definitions WHERE id=?", [order.item_id]);
	await recordCharacterOperation(connection, {
		characterId: Number(character.id),
		kind: "market.order_cancelled",
		source: {
			system: "market_order",
			id: Number(order.id),
			step: "cancelled"
		},
		outcome: "撤单",
		summary: `撤销${order.side === "buy" ? "求购" : "寄售"} ${cancelledItems[0]?.name ?? `物品 ${order.item_id}`}`,
		detail: {
			orderId: Number(order.id),
			side: order.side,
			itemId: Number(order.item_id),
			remaining: Number(order.quantity_remaining),
			feeCopper: fee
		}
	});
	await connection.execute("DELETE FROM market_escrow_items WHERE order_id=?", [order.id]);
	await connection.execute("UPDATE market_weekly_volume SET cancellation_count=cancellation_count+1 WHERE character_id=? AND week_key=?", [character.id, volume.key]);
	recordAchievement(connection, Number(character.id), ["ACH_K07"]);
	return {
		orderId: number(order.id),
		itemId: number(order.item_id),
		side: order.side,
		quantity: number(order.quantity_remaining),
		fee,
		refundedCopper: order.side === "buy" ? number(order.reserved_copper) - fee : 0
	};
};
const cancelMarketOrder = (qqUserId, orderId) => withTransaction((connection) => cancelMarketOrderInTransaction(connection, qqUserId, orderId));
const marketFeeProfile = async (qqUserId) => {
	const pool = await getPool();
	const character = await characterFor(pool, qqUserId);
	const [rows] = await pool.execute("SELECT gross_sales,fee_paid,cancellation_count FROM market_weekly_volume WHERE character_id=? AND week_key=? LIMIT 1", [character.id, weekKey()]);
	const gross = number(rows[0]?.gross_sales);
	const nextRate = gross < 1e4 ? 3 : gross < 5e4 ? 5 : gross < 15e4 ? 8 : gross < 5e5 ? 12 : 16;
	return {
		gross,
		fees: number(rows[0]?.fee_paid),
		cancellations: number(rows[0]?.cancellation_count),
		nextRate
	};
};

//#endregion
export { MARKET_PAGE_SIZE, MARKET_SORTS, MARKET_TYPES, cancelMarketOrder, cancelMarketOrderInTransaction, createMarketBuyOrder, createMarketOrderInTransaction, createMarketSellOrder, marketCancelQuoteInTransaction, marketCatalog, characterFor as marketCharacterFor, marketEligibilityReason, feeForSale as marketFeeForSale, marketFeeProfile, marketItemDetail, marketMyListings, marketOrderPage, marketOrderQuoteInTransaction, marketOrders, marketSellable, marketTradables, marketTradePage, weeklySales as marketWeeklySales };