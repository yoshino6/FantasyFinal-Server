import { BAINA_RESIDENCE_CODE } from "../game/home.constants.js";
import { previewHomePurchaseInTransaction, purchaseHomeInTransaction } from "../game/home.service.js";
import { withTransaction } from "../database/pool.js";
import { completeCraftRequest, craftCharacterId, craftRequestFor, createCraftRequest } from "../game/alchemy-journal.service.js";
import { randomUUID } from "node:crypto";

//#region src/app-api/home-purchase.service.ts
const requestKind = "web_home_purchase";
const quoteMinutes = 2;
const validCredential = (value) => /^[0-9a-f-]{36}$/i.test(value);
const previewHomePurchase = (qqUserId) => withTransaction(async (connection) => {
	const quote = await previewHomePurchaseInTransaction(connection, qqUserId);
	const characterId = await craftCharacterId(connection, qqUserId, true);
	const idempotencyKey = randomUUID();
	return {
		token: await createCraftRequest(connection, characterId, requestKind, {
			quote,
			idempotencyKey
		}, quoteMinutes),
		idempotencyKey,
		expiresAt: new Date(Date.now() + quoteMinutes * 6e4).toISOString(),
		target: {
			id: BAINA_RESIDENCE_CODE,
			name: "百纳居",
			locationRequired: true
		},
		quote
	};
});
const confirmHomePurchase = (qqUserId, token, idempotencyKey) => withTransaction(async (connection) => {
	if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error("确认凭据无效，请重新获取购房报价。");
	const characterId = await craftCharacterId(connection, qqUserId, true);
	const request = await craftRequestFor(connection, characterId, requestKind, token);
	if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error("确认凭据不匹配，请重新获取购房报价。");
	if (request.result) return request.result;
	const fresh = await previewHomePurchaseInTransaction(connection, qqUserId);
	if (JSON.stringify(fresh) !== JSON.stringify(request.snapshot.quote)) throw new Error("购房余额或角色状态已变化，请重新获取报价。");
	const result = await purchaseHomeInTransaction(connection, qqUserId);
	await completeCraftRequest(connection, characterId, token, result);
	return result;
});

//#endregion
export { confirmHomePurchase, previewHomePurchase };