import { getPool, withTransaction } from "../database/pool.js";
import { completeCraftRequest, craftCharacterId, craftRequestFor, createCraftRequest } from "../game/alchemy-journal.service.js";
import { addNpcAffinityFor } from "../game/adventure.service.js";
import { BOOKSHOP_TARGET_ID, bookshopCatalog, bookshopItemDetail, bookshopSellCatalog, buyBookshopItemInTransaction, requireBookshopTarget, sellBookshopItemInTransaction } from "../game/bookshop.service.js";
import { randomUUID } from "node:crypto";

//#region src/app-api/bookshop.service.ts
const requestKind = (side) => side === "buy" ? "web_bookshop_buy" : "web_bookshop_sell";
const quoteMinutes = 2;
const validCredential = (value) => /^[0-9a-f-]{36}$/i.test(value);
const bookshopShelf = async (qqUserId, targetId, page, keyword) => {
	const { target } = await requireBookshopTarget(await getPool(), qqUserId, targetId);
	return {
		target,
		...await bookshopCatalog(qqUserId, page, keyword)
	};
};
const bookshopItem = async (qqUserId, targetId, itemId) => {
	const { target } = await requireBookshopTarget(await getPool(), qqUserId, targetId);
	return {
		target,
		...await bookshopItemDetail(qqUserId, itemId)
	};
};
const bookshopSellable = async (qqUserId, targetId, page, keyword) => {
	const { target } = await requireBookshopTarget(await getPool(), qqUserId, targetId);
	return {
		target,
		...await bookshopSellCatalog(qqUserId, page, keyword)
	};
};
const trade = (connection, qqUserId, side, itemId, quantity, preview) => side === "buy" ? buyBookshopItemInTransaction(connection, qqUserId, itemId, quantity, preview) : sellBookshopItemInTransaction(connection, qqUserId, itemId, quantity, preview);
const previewBookshopTrade = (qqUserId, targetId, side, itemId, quantity) => withTransaction(async (connection) => {
	const { characterId, target } = await requireBookshopTarget(connection, qqUserId, targetId, true);
	const quote = await trade(connection, qqUserId, side, itemId, quantity, true);
	const idempotencyKey = randomUUID();
	return {
		token: await createCraftRequest(connection, characterId, requestKind(side), {
			targetId,
			side,
			itemId,
			quantity,
			quote,
			idempotencyKey
		}, quoteMinutes),
		idempotencyKey,
		expiresAt: new Date(Date.now() + quoteMinutes * 6e4).toISOString(),
		target,
		quote
	};
});
const confirmBookshopTrade = (qqUserId, targetId, side, token, idempotencyKey) => withTransaction(async (connection) => {
	if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error("确认凭据无效，请重新获取书屋报价。");
	const characterId = await craftCharacterId(connection, qqUserId, true);
	const request = await craftRequestFor(connection, characterId, requestKind(side), token);
	if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error("确认凭据不匹配，请重新获取书屋报价。");
	if (request.snapshot.targetId !== targetId || request.snapshot.side !== side) throw new Error("书屋目标与报价不一致。");
	if (request.result) return request.result;
	await requireBookshopTarget(connection, qqUserId, targetId, true);
	const snapshot = request.snapshot;
	const fresh = await trade(connection, qqUserId, side, snapshot.itemId, snapshot.quantity, true);
	if (JSON.stringify(fresh) !== JSON.stringify(snapshot.quote)) throw new Error("书屋库存、背包或余额已变化，请重新获取报价。");
	const result = await trade(connection, qqUserId, side, snapshot.itemId, snapshot.quantity, false);
	const affinity = await addNpcAffinityFor(connection, characterId, BOOKSHOP_TARGET_ID, side);
	const settled = {
		...result,
		affinity
	};
	await completeCraftRequest(connection, characterId, token, settled);
	return settled;
});

//#endregion
export { bookshopItem, bookshopSellable, bookshopShelf, confirmBookshopTrade, previewBookshopTrade };