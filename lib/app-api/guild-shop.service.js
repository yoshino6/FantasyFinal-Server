import { requireGuildService } from "../game/guild-context.js";
import { getPool, withTransaction } from "../database/pool.js";
import { completeCraftRequest, craftCharacterId, craftRequestFor, createCraftRequest } from "../game/alchemy-journal.service.js";
import { addNpcAffinityFor } from "../game/adventure.service.js";
import { buyShopItemInTransaction, sellCatalog, sellShopItemInTransaction, shopCatalog, shopItemDetail } from "../game/guild-shop.service.js";
import { randomUUID } from "node:crypto";

//#region src/app-api/guild-shop.service.ts
const requestKind = (side) => side === "buy" ? "web_guild_shop_buy" : "web_guild_shop_sell";
const quoteMinutes = 2;
const validCredential = (value) => /^[0-9a-f-]{36}$/i.test(value);
const requireGuildShopTarget = async (connection, qqUserId, targetId, lock = false) => {
	const characterId = await craftCharacterId(connection, qqUserId, lock);
	const context = await requireGuildService(connection, characterId);
	if (context.hub.guild !== targetId) throw new Error("请在当前公会入口打开商店。");
	return {
		characterId,
		target: {
			id: context.hub.guild,
			regionCode: context.code,
			guildName: context.hub.guildName,
			locationRequired: true
		}
	};
};
const guildShopShelf = async (qqUserId, targetId, page, keyword) => {
	const { target } = await requireGuildShopTarget(await getPool(), qqUserId, targetId);
	return {
		target,
		...await shopCatalog(qqUserId, page, keyword)
	};
};
const guildShopItem = async (qqUserId, targetId, itemId) => {
	const { target } = await requireGuildShopTarget(await getPool(), qqUserId, targetId);
	return {
		target,
		...await shopItemDetail(qqUserId, itemId)
	};
};
const guildShopSellable = async (qqUserId, targetId, page, keyword) => {
	const { target } = await requireGuildShopTarget(await getPool(), qqUserId, targetId);
	return {
		target,
		...await sellCatalog(qqUserId, page, keyword)
	};
};
const quoteAction = (connection, qqUserId, side, itemId, quantity) => side === "buy" ? buyShopItemInTransaction(connection, qqUserId, itemId, quantity, true) : sellShopItemInTransaction(connection, qqUserId, itemId, quantity, true);
const settleAction = (connection, qqUserId, side, itemId, quantity) => side === "buy" ? buyShopItemInTransaction(connection, qqUserId, itemId, quantity, false) : sellShopItemInTransaction(connection, qqUserId, itemId, quantity, false);
const previewGuildShopTrade = (qqUserId, targetId, side, itemId, quantity) => withTransaction(async (connection) => {
	const { characterId, target } = await requireGuildShopTarget(connection, qqUserId, targetId, true);
	const quote = await quoteAction(connection, qqUserId, side, itemId, quantity);
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
const confirmGuildShopTrade = (qqUserId, targetId, side, token, idempotencyKey) => withTransaction(async (connection) => {
	if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error("确认凭据无效，请重新获取商店报价。");
	const characterId = await craftCharacterId(connection, qqUserId, true);
	const request = await craftRequestFor(connection, characterId, requestKind(side), token);
	if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error("确认凭据不匹配，请重新获取商店报价。");
	if (request.snapshot.targetId !== targetId || request.snapshot.side !== side) throw new Error("商店目标与报价不一致。");
	if (request.result) return request.result;
	await requireGuildShopTarget(connection, qqUserId, targetId, true);
	const snapshot = request.snapshot;
	const fresh = await quoteAction(connection, qqUserId, side, snapshot.itemId, snapshot.quantity);
	if (JSON.stringify(fresh) !== JSON.stringify(snapshot.quote)) throw new Error("商品库存、余额或折扣已变化，请重新获取报价。");
	const result = await settleAction(connection, qqUserId, side, snapshot.itemId, snapshot.quantity);
	const affinity = await addNpcAffinityFor(connection, characterId, targetId, side);
	const settled = {
		...result,
		affinity
	};
	await completeCraftRequest(connection, characterId, token, settled);
	return settled;
});

//#endregion
export { confirmGuildShopTrade, guildShopItem, guildShopSellable, guildShopShelf, previewGuildShopTrade, requireGuildShopTarget };