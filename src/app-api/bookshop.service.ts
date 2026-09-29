import { randomUUID } from 'node:crypto';
import { getPool, withTransaction } from '../database/pool';
import { craftCharacterId, createCraftRequest, craftRequestFor, completeCraftRequest } from '../game/alchemy-journal.service';
import { addNpcAffinityFor } from '../game/adventure.service';
import { BOOKSHOP_TARGET_ID, bookshopCatalog, bookshopItemDetail, bookshopSellCatalog,
  buyBookshopItemInTransaction, requireBookshopTarget, sellBookshopItemInTransaction } from '../game/bookshop.service';

type Side = 'buy' | 'sell';
type Snapshot = { targetId: string; side: Side; itemId: number; quantity: number; quote: Record<string, unknown>; idempotencyKey: string };
const requestKind = (side: Side) => side === 'buy' ? 'web_bookshop_buy' : 'web_bookshop_sell';
const quoteMinutes = 2;
const validCredential = (value: string) => /^[0-9a-f-]{36}$/i.test(value);

export const bookshopShelf = async (qqUserId: string, targetId: string, page: number, keyword: string) => {
  const { target } = await requireBookshopTarget(await getPool(), qqUserId, targetId);
  return { target, ...await bookshopCatalog(qqUserId, page, keyword) };
};
export const bookshopItem = async (qqUserId: string, targetId: string, itemId: number) => {
  const { target } = await requireBookshopTarget(await getPool(), qqUserId, targetId);
  return { target, ...await bookshopItemDetail(qqUserId, itemId) };
};
export const bookshopSellable = async (qqUserId: string, targetId: string, page: number, keyword: string) => {
  const { target } = await requireBookshopTarget(await getPool(), qqUserId, targetId);
  return { target, ...await bookshopSellCatalog(qqUserId, page, keyword) };
};

const trade = (connection: Parameters<typeof buyBookshopItemInTransaction>[0], qqUserId: string,
  side: Side, itemId: number, quantity: number, preview: boolean) =>
  side === 'buy' ? buyBookshopItemInTransaction(connection, qqUserId, itemId, quantity, preview)
    : sellBookshopItemInTransaction(connection, qqUserId, itemId, quantity, preview);

export const previewBookshopTrade = (qqUserId: string, targetId: string, side: Side, itemId: number, quantity: number) =>
  withTransaction(async connection => {
    const { characterId, target } = await requireBookshopTarget(connection, qqUserId, targetId, true);
    const quote = await trade(connection, qqUserId, side, itemId, quantity, true);
    const idempotencyKey = randomUUID();
    const token = await createCraftRequest(connection, characterId, requestKind(side),
      { targetId, side, itemId, quantity, quote, idempotencyKey } satisfies Snapshot, quoteMinutes);
    return { token, idempotencyKey, expiresAt: new Date(Date.now() + quoteMinutes * 60_000).toISOString(), target, quote };
  });

export const confirmBookshopTrade = (qqUserId: string, targetId: string, side: Side, token: string, idempotencyKey: string) =>
  withTransaction(async connection => {
    if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error('确认凭据无效，请重新获取书屋报价。');
    const characterId = await craftCharacterId(connection, qqUserId, true);
    const request = await craftRequestFor<Snapshot>(connection, characterId, requestKind(side), token);
    if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error('确认凭据不匹配，请重新获取书屋报价。');
    if (request.snapshot.targetId !== targetId || request.snapshot.side !== side) throw new Error('书屋目标与报价不一致。');
    if (request.result) return request.result;
    await requireBookshopTarget(connection, qqUserId, targetId, true);
    const snapshot = request.snapshot;
    const fresh = await trade(connection, qqUserId, side, snapshot.itemId, snapshot.quantity, true);
    if (JSON.stringify(fresh) !== JSON.stringify(snapshot.quote)) throw new Error('书屋库存、背包或余额已变化，请重新获取报价。');
    const result = await trade(connection, qqUserId, side, snapshot.itemId, snapshot.quantity, false);
    const affinity = await addNpcAffinityFor(connection, characterId, BOOKSHOP_TARGET_ID, side);
    const settled = { ...result, affinity };
    await completeCraftRequest(connection, characterId, token, settled);
    return settled;
  });
