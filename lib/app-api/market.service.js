import { getPool, withTransaction } from "../database/pool.js";
import { completeCraftRequest, craftCharacterId, craftRequestFor, createCraftRequest } from "../game/alchemy-journal.service.js";
import { cancelMarketOrderInTransaction, createMarketOrderInTransaction, marketCancelQuoteInTransaction, marketCharacterFor as characterFor, marketEligibilityReason, marketFeeProfile, marketOrderQuoteInTransaction } from "../game/market.service.js";
import { randomUUID } from "node:crypto";

//#region src/app-api/market.service.ts
const storyMessage = "先完成梨子喵的谢礼之约，万叶联会才会向你开放。";
const marketRemoteStoryReason = (stage) => !Number.isFinite(stage) || stage < 6 ? storyMessage : null;
const orderRequestKind = "web_market_order";
const cancelRequestKind = "web_market_cancel";
const quoteMinutes = 2;
const validCredential = (value) => /^[0-9a-f-]{36}$/i.test(value);
/** H5 世界页可远程交易；资格与剧情由服务端校验，QQ 的现场入口保持原样。 */
const requireRemoteMarketAccess = async (connection, qqUserId, lock = false) => {
	const character = await characterFor(connection, qqUserId, lock);
	const [rows] = await connection.execute(`SELECT stage FROM player_main_quest_progress
    WHERE character_id=? AND quest_code='girl_gratitude' LIMIT 1${lock ? " FOR UPDATE" : ""}`, [character.id]);
	const reason = marketRemoteStoryReason(Number(rows[0]?.stage ?? 0));
	if (reason) throw new Error(reason);
	return character;
};
const remoteMarketAccessStatus = async (qqUserId) => {
	const pool = await getPool();
	const [rows] = await pool.execute(`SELECT c.id,c.level,c.adventurer_registered,c.created_at
    FROM characters c JOIN players p ON p.id=c.player_id WHERE p.qq_user_id=? LIMIT 1`, [qqUserId]);
	const character = rows[0];
	const [stages] = character ? await pool.execute(`SELECT stage FROM player_main_quest_progress
    WHERE character_id=? AND quest_code='girl_gratitude' LIMIT 1`, [character.id]) : [[]];
	const storyStage = Number(stages[0]?.stage ?? 0);
	const reason = marketEligibilityReason(character) ?? marketRemoteStoryReason(storyStage);
	return {
		canTrade: !reason,
		reason,
		locationRequired: false,
		storyStage,
		...reason ? {} : { feeProfile: await marketFeeProfile(qqUserId) }
	};
};
const previewRemoteMarketOrder = (qqUserId, side, itemId, price, quantity) => withTransaction(async (connection) => {
	const character = await requireRemoteMarketAccess(connection, qqUserId, true);
	const quote = await marketOrderQuoteInTransaction(connection, qqUserId, itemId, price, quantity, side);
	const idempotencyKey = randomUUID();
	const snapshot = {
		side,
		itemId,
		price,
		quantity,
		reference: quote.reference,
		estimatedFeeCopper: quote.estimatedFeeCopper,
		idempotencyKey
	};
	return {
		token: await createCraftRequest(connection, Number(character.id), orderRequestKind, snapshot, quoteMinutes),
		idempotencyKey,
		expiresAt: new Date(Date.now() + quoteMinutes * 6e4).toISOString(),
		quote
	};
});
const confirmRemoteMarketOrder = (qqUserId, token, idempotencyKey) => withTransaction(async (connection) => {
	if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error("确认凭据无效，请重新获取报价。");
	const characterId = await craftCharacterId(connection, qqUserId, true);
	const request = await craftRequestFor(connection, characterId, orderRequestKind, token);
	if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error("确认凭据不匹配，请重新获取报价。");
	if (request.result) return request.result;
	await requireRemoteMarketAccess(connection, qqUserId, true);
	const snapshot = request.snapshot;
	const fresh = await marketOrderQuoteInTransaction(connection, qqUserId, snapshot.itemId, snapshot.price, snapshot.quantity, snapshot.side);
	if (fresh.reference !== snapshot.reference || fresh.estimatedFeeCopper > snapshot.estimatedFeeCopper) throw new Error("市场参考价或手续费已变化，请重新获取报价。");
	const result = await createMarketOrderInTransaction(connection, qqUserId, snapshot.itemId, snapshot.price, snapshot.quantity, snapshot.side);
	await completeCraftRequest(connection, characterId, token, result);
	return result;
});
const previewRemoteMarketCancel = (qqUserId, orderId) => withTransaction(async (connection) => {
	const character = await requireRemoteMarketAccess(connection, qqUserId, true);
	const quote = await marketCancelQuoteInTransaction(connection, qqUserId, orderId);
	const idempotencyKey = randomUUID();
	const snapshot = {
		orderId,
		price: quote.price,
		quantity: quote.quantity,
		feeCopper: quote.feeCopper,
		idempotencyKey
	};
	return {
		token: await createCraftRequest(connection, Number(character.id), cancelRequestKind, snapshot, quoteMinutes),
		idempotencyKey,
		expiresAt: new Date(Date.now() + quoteMinutes * 6e4).toISOString(),
		quote
	};
});
const confirmRemoteMarketCancel = (qqUserId, orderId, token, idempotencyKey) => withTransaction(async (connection) => {
	if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error("确认凭据无效，请重新获取撤单预览。");
	const characterId = await craftCharacterId(connection, qqUserId, true);
	const request = await craftRequestFor(connection, characterId, cancelRequestKind, token);
	if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error("确认凭据不匹配，请重新获取撤单预览。");
	if (request.snapshot.orderId !== orderId) throw new Error("撤单编号与报价不一致。");
	if (request.result) return request.result;
	await requireRemoteMarketAccess(connection, qqUserId, true);
	const snapshot = request.snapshot;
	const fresh = await marketCancelQuoteInTransaction(connection, qqUserId, snapshot.orderId);
	if (fresh.price !== snapshot.price || fresh.quantity !== snapshot.quantity || fresh.feeCopper > snapshot.feeCopper) throw new Error("订单或撤单费用已变化，请重新获取撤单预览。");
	const result = await cancelMarketOrderInTransaction(connection, qqUserId, snapshot.orderId);
	await completeCraftRequest(connection, characterId, token, result);
	return result;
});

//#endregion
export { confirmRemoteMarketCancel, confirmRemoteMarketOrder, marketRemoteStoryReason, previewRemoteMarketCancel, previewRemoteMarketOrder, remoteMarketAccessStatus, requireRemoteMarketAccess };