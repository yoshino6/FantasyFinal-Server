import { homeShopOfferDetail, listHomeShop, requireHomeShopTarget, tradeHomeOfferInTransaction } from "../game/home.service.js";
import { getPool, withTransaction } from "../database/pool.js";
import { completeCraftRequest, craftCharacterId, craftRequestFor, createCraftRequest } from "../game/alchemy-journal.service.js";
import { randomUUID } from "node:crypto";

//#region src/app-api/home-shop.service.ts
const requestKind = "web_home_shop_trade";
const quoteMinutes = 2;
const validCredential = (value) => /^[0-9a-f-]{36}$/i.test(value);
const homeShopShelf = async (qqUserId, targetId) => {
	const { target } = await requireHomeShopTarget(await getPool(), qqUserId, targetId);
	return {
		target,
		...await listHomeShop(qqUserId)
	};
};
const homeShopOffer = async (qqUserId, targetId, offerId) => {
	const { target } = await requireHomeShopTarget(await getPool(), qqUserId, targetId);
	return {
		target,
		...await homeShopOfferDetail(qqUserId, offerId)
	};
};
const previewHomeShopTrade = (qqUserId, targetId, offerId, quantity) => withTransaction(async (connection) => {
	const { characterId, target } = await requireHomeShopTarget(connection, qqUserId, targetId, true);
	const quote = await tradeHomeOfferInTransaction(connection, qqUserId, offerId, quantity, true);
	const idempotencyKey = randomUUID();
	return {
		token: await createCraftRequest(connection, characterId, requestKind, {
			targetId,
			offerId,
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
const confirmHomeShopTrade = (qqUserId, targetId, token, idempotencyKey) => withTransaction(async (connection) => {
	if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error("确认凭据无效，请重新获取百纳居报价。");
	const characterId = await craftCharacterId(connection, qqUserId, true);
	const request = await craftRequestFor(connection, characterId, requestKind, token);
	if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error("确认凭据不匹配，请重新获取百纳居报价。");
	if (request.snapshot.targetId !== targetId) throw new Error("百纳居目标与报价不一致。");
	if (request.result) return request.result;
	await requireHomeShopTarget(connection, qqUserId, targetId, true);
	const snapshot = request.snapshot;
	const fresh = await tradeHomeOfferInTransaction(connection, qqUserId, snapshot.offerId, snapshot.quantity, true);
	if (JSON.stringify(fresh) !== JSON.stringify(snapshot.quote)) throw new Error("建材报价、背包或余额已变化，请重新获取报价。");
	const result = await tradeHomeOfferInTransaction(connection, qqUserId, snapshot.offerId, snapshot.quantity, false);
	await completeCraftRequest(connection, characterId, token, result);
	return result;
});

//#endregion
export { confirmHomeShopTrade, homeShopOffer, homeShopShelf, previewHomeShopTrade };