import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { getPool, withTransaction } from '../database/pool';
import { craftCharacterId, createCraftRequest, craftRequestFor, completeCraftRequest } from '../game/alchemy-journal.service';
import { requireGuildService } from '../game/guild-context';
import { buyShopItemInTransaction, sellShopItemInTransaction, shopCatalog, shopItemDetail, sellCatalog } from '../game/guild-shop.service';
import { addNpcAffinityFor } from '../game/adventure.service';

type Side = 'buy' | 'sell';
type Snapshot = { targetId: string; side: Side; itemId: number; quantity: number; quote: Record<string, unknown>; idempotencyKey: string };
const requestKind = (side: Side) => side === 'buy' ? 'web_guild_shop_buy' : 'web_guild_shop_sell';
const quoteMinutes = 2;
const validCredential = (value: string) => /^[0-9a-f-]{36}$/i.test(value);

export const requireGuildShopTarget = async (connection: Pool | PoolConnection, qqUserId: string, targetId: string, lock = false) => {
  const characterId = await craftCharacterId(connection, qqUserId, lock);
  const context = await requireGuildService(connection, characterId);
  if (context.hub.guild !== targetId) throw new Error('请在当前公会入口打开商店。');
  return { characterId, target: { id: context.hub.guild, regionCode: context.code,
    guildName: context.hub.guildName, locationRequired: true } };
};

export const guildShopShelf = async (qqUserId: string, targetId: string, page: number, keyword: string) => {
  const { target } = await requireGuildShopTarget(await getPool(), qqUserId, targetId);
  return { target, ...await shopCatalog(qqUserId, page, keyword) };
};
export const guildShopItem = async (qqUserId: string, targetId: string, itemId: number) => {
  const { target } = await requireGuildShopTarget(await getPool(), qqUserId, targetId);
  return { target, ...await shopItemDetail(qqUserId, itemId) };
};
export const guildShopSellable = async (qqUserId: string, targetId: string, page: number, keyword: string) => {
  const { target } = await requireGuildShopTarget(await getPool(), qqUserId, targetId);
  return { target, ...await sellCatalog(qqUserId, page, keyword) };
};

const quoteAction = (connection: PoolConnection, qqUserId: string, side: Side, itemId: number, quantity: number) =>
  side === 'buy' ? buyShopItemInTransaction(connection, qqUserId, itemId, quantity, true)
    : sellShopItemInTransaction(connection, qqUserId, itemId, quantity, true);
const settleAction = (connection: PoolConnection, qqUserId: string, side: Side, itemId: number, quantity: number) =>
  side === 'buy' ? buyShopItemInTransaction(connection, qqUserId, itemId, quantity, false)
    : sellShopItemInTransaction(connection, qqUserId, itemId, quantity, false);

export const previewGuildShopTrade = (qqUserId: string, targetId: string, side: Side, itemId: number, quantity: number) =>
  withTransaction(async connection => {
    const { characterId, target } = await requireGuildShopTarget(connection, qqUserId, targetId, true);
    const quote = await quoteAction(connection, qqUserId, side, itemId, quantity);
    const idempotencyKey = randomUUID();
    const token = await createCraftRequest(connection, characterId, requestKind(side),
      { targetId, side, itemId, quantity, quote, idempotencyKey } satisfies Snapshot, quoteMinutes);
    return { token, idempotencyKey, expiresAt: new Date(Date.now() + quoteMinutes * 60_000).toISOString(), target, quote };
  });

export const confirmGuildShopTrade = (qqUserId: string, targetId: string, side: Side, token: string, idempotencyKey: string) =>
  withTransaction(async connection => {
    if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error('确认凭据无效，请重新获取商店报价。');
    const characterId = await craftCharacterId(connection, qqUserId, true);
    const request = await craftRequestFor<Snapshot>(connection, characterId, requestKind(side), token);
    if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error('确认凭据不匹配，请重新获取商店报价。');
    if (request.snapshot.targetId !== targetId || request.snapshot.side !== side) throw new Error('商店目标与报价不一致。');
    if (request.result) return request.result;
    await requireGuildShopTarget(connection, qqUserId, targetId, true);
    const snapshot = request.snapshot;
    const fresh = await quoteAction(connection, qqUserId, side, snapshot.itemId, snapshot.quantity);
    if (JSON.stringify(fresh) !== JSON.stringify(snapshot.quote)) throw new Error('商品库存、余额或折扣已变化，请重新获取报价。');
    const result = await settleAction(connection, qqUserId, side, snapshot.itemId, snapshot.quantity);
    const affinity = await addNpcAffinityFor(connection, characterId, targetId, side);
    const settled = { ...result, affinity };
    await completeCraftRequest(connection, characterId, token, settled);
    return settled;
  });
