import { depositHomeStorageInTransaction, homeOverview, withdrawHomeStorageInTransaction } from "../game/home.service.js";
import { getPool, withTransaction } from "../database/pool.js";
import { completeCraftRequest, craftCharacterId, craftRequestFor, createCraftRequest } from "../game/alchemy-journal.service.js";
import { randomUUID } from "node:crypto";

//#region src/app-api/home-storage.service.ts
const pageSize = 20;
const quoteMinutes = 2;
const requestKind = (side) => side === "deposit" ? "web_home_store_in" : "web_home_store_out";
const validCredential = (value) => /^[0-9a-f-]{36}$/i.test(value);
const itemType = (category) => category === "装备" ? "equipment" : category === "道具" ? "consumable" : "material";
const validCategory = (value) => value === "装备" || value === "道具" || value === "材料";
const validScope = (value) => value === "backpack" || value === "storage";
/** 世界页远程只读清单，不触发 QQ 家园面板的休息结算。 */
const webHomeStorageCatalog = async (qqUserId, scope, category, page = 1, keyword = "") => {
	if (!validScope(scope) || !validCategory(category)) throw new Error("储物筛选无效。");
	if (!Number.isSafeInteger(page) || page < 1 || page > 1e4) throw new Error("页码无效。");
	const term = keyword.trim();
	if (term.length > 80) throw new Error("搜索关键词过长。");
	const overview = await homeOverview(qqUserId);
	if (!overview.home) throw new Error("你还没有小屋。");
	const pool = await getPool();
	const homeId = overview.home.id;
	const categoryType = itemType(category);
	const characterId = scope === "backpack" ? await craftCharacterId(pool, qqUserId) : 0;
	const [stackedResult, instanceResult] = await Promise.all([scope === "storage" ? pool.execute(`SELECT i.id,i.code,i.codex_id,i.name,i.item_category,i.weight,i.description,
          hs.quantity,hs.trade_bound_quantity,hs.personal_bound_quantity
          FROM player_home_storage_items hs JOIN item_definitions i ON i.id=hs.item_id
          WHERE hs.home_id=? AND hs.quantity>0 AND i.item_type=? AND i.stackable=1 ORDER BY i.name,i.id`, [homeId, categoryType]) : pool.execute(`SELECT i.id,i.code,i.codex_id,i.name,i.item_category,i.weight,i.description,
          pi.quantity,pi.trade_bound_quantity,pi.personal_bound_quantity,
          CASE WHEN JSON_EXTRACT(i.effect_json,'$.personalOnly')=true THEN 1 ELSE 0 END AS personal_only
          FROM player_inventory pi JOIN item_definitions i ON i.id=pi.item_id
          WHERE pi.character_id=? AND pi.quantity>0 AND i.item_type=? AND i.stackable=1 ORDER BY i.name,i.id`, [characterId, categoryType]), scope === "storage" ? pool.execute(`SELECT ii.id,i.code,i.codex_id,i.name,i.item_category,i.weight,i.description,
          ii.quality,ii.durability,ii.durability_max
          FROM player_home_storage_instances hs JOIN player_item_instances ii ON ii.id=hs.instance_id
          JOIN item_definitions i ON i.id=ii.item_id WHERE hs.home_id=? AND i.item_type=?
          ORDER BY hs.stored_at DESC,ii.id`, [homeId, categoryType]) : Promise.resolve([[]])]);
	const stacked = stackedResult[0].filter((item) => scope === "storage" || !Number(item.personal_only)).map((item) => {
		const quantity = Number(item.quantity), trade = Number(item.trade_bound_quantity), personal = Number(item.personal_bound_quantity);
		return {
			kind: "stacked",
			id: Number(item.id),
			code: item.code,
			codexId: item.codex_id,
			name: item.name,
			itemCategory: item.item_category,
			description: item.description,
			quantity,
			weight: Number(item.weight),
			binding: {
				unbound: quantity - trade - personal,
				trade,
				personal
			},
			transferable: true
		};
	});
	const instances = instanceResult[0].map((item) => ({
		kind: "instance",
		id: Number(item.id),
		code: item.code,
		codexId: item.codex_id,
		name: item.name,
		itemCategory: item.item_category,
		description: item.description,
		quantity: 1,
		weight: Number(item.weight),
		quality: Number(item.quality),
		durability: Number(item.durability),
		durabilityMax: Number(item.durability_max),
		transferable: false
	}));
	const matching = [...stacked, ...instances].filter((item) => !term || item.name.includes(term) || item.itemCategory.includes(term) || item.code.includes(term));
	const pages = Math.max(1, Math.ceil(matching.length / pageSize));
	const currentPage = Math.min(page, pages);
	return {
		scope,
		category,
		keyword: term,
		page: currentPage,
		pages,
		count: matching.length,
		pageSize,
		capacityKg: overview.home.storage.capacityKg,
		usedKg: overview.home.storage.usedKg,
		locationRequired: false,
		depositAvailable: overview.home.storage.capacityKg > 0,
		items: matching.slice((currentPage - 1) * pageSize, currentPage * pageSize)
	};
};
const transferInTransaction = (connection, qqUserId, side, itemId, quantity, preview) => side === "deposit" ? depositHomeStorageInTransaction(connection, qqUserId, itemId, quantity, preview) : withdrawHomeStorageInTransaction(connection, qqUserId, itemId, quantity, preview);
const previewWebHomeStorageTransfer = (qqUserId, side, itemId, quantity) => withTransaction(async (connection) => {
	if (!Number.isSafeInteger(itemId) || itemId < 1 || !Number.isSafeInteger(quantity) || quantity < 1) throw new Error("物品编号和数量必须为正整数。");
	const characterId = await craftCharacterId(connection, qqUserId, true);
	const quote = await transferInTransaction(connection, qqUserId, side, itemId, quantity, true);
	const idempotencyKey = randomUUID();
	return {
		token: await createCraftRequest(connection, characterId, requestKind(side), {
			side,
			itemId,
			quantity,
			quote,
			idempotencyKey
		}, quoteMinutes),
		idempotencyKey,
		expiresAt: new Date(Date.now() + quoteMinutes * 6e4).toISOString(),
		quote
	};
});
const confirmWebHomeStorageTransfer = (qqUserId, side, token, idempotencyKey) => withTransaction(async (connection) => {
	if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error("确认凭据无效，请重新获取储物报价。");
	const characterId = await craftCharacterId(connection, qqUserId, true);
	const request = await craftRequestFor(connection, characterId, requestKind(side), token);
	if (request.snapshot.idempotencyKey !== idempotencyKey || request.snapshot.side !== side) throw new Error("确认凭据不匹配，请重新获取储物报价。");
	if (request.result) return request.result;
	const snapshot = request.snapshot;
	const fresh = await transferInTransaction(connection, qqUserId, side, snapshot.itemId, snapshot.quantity, true);
	if (JSON.stringify(fresh) !== JSON.stringify(snapshot.quote)) throw new Error("储物数量、绑定或容量已变化，请重新获取报价。");
	const result = await transferInTransaction(connection, qqUserId, side, snapshot.itemId, snapshot.quantity, false);
	await completeCraftRequest(connection, characterId, token, result);
	return result;
});

//#endregion
export { confirmWebHomeStorageTransfer, previewWebHomeStorageTransfer, webHomeStorageCatalog };