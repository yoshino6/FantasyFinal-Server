import { randomUUID } from 'node:crypto';
import { getPool, withTransaction } from '../database/pool';
import { craftCharacterId, createCraftRequest, craftRequestFor, completeCraftRequest } from '../game/alchemy-journal.service';
import { homeShopOfferDetail, listHomeShop, requireHomeShopTarget, tradeHomeOfferInTransaction } from '../game/home.service';

type Snapshot = { targetId: string; offerId: number; quantity: number; quote: Record<string, unknown>; idempotencyKey: string };
const requestKind = 'web_home_shop_trade';
const quoteMinutes = 2;
const validCredential = (value: string) => /^[0-9a-f-]{36}$/i.test(value);

export const homeShopShelf = async (qqUserId: string, targetId: string) => {
  const { target } = await requireHomeShopTarget(await getPool(), qqUserId, targetId);
  return { target, ...await listHomeShop(qqUserId) };
};
export const homeShopOffer = async (qqUserId: string, targetId: string, offerId: number) => {
  const { target } = await requireHomeShopTarget(await getPool(), qqUserId, targetId);
  return { target, ...await homeShopOfferDetail(qqUserId, offerId) };
};
export const previewHomeShopTrade = (qqUserId: string, targetId: string, offerId: number, quantity: number) =>
  withTransaction(async connection => {
    const { characterId, target } = await requireHomeShopTarget(connection, qqUserId, targetId, true);
    const quote = await tradeHomeOfferInTransaction(connection, qqUserId, offerId, quantity, true);
    const idempotencyKey = randomUUID();
    const token = await createCraftRequest(connection, characterId, requestKind,
      { targetId, offerId, quantity, quote, idempotencyKey } satisfies Snapshot, quoteMinutes);
    return { token, idempotencyKey, expiresAt: new Date(Date.now() + quoteMinutes * 60_000).toISOString(), target, quote };
  });
export const confirmHomeShopTrade = (qqUserId: string, targetId: string, token: string, idempotencyKey: string) =>
  withTransaction(async connection => {
    if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error('确认凭据无效，请重新获取百纳居报价。');
    const characterId = await craftCharacterId(connection, qqUserId, true);
    const request = await craftRequestFor<Snapshot>(connection, characterId, requestKind, token);
    if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error('确认凭据不匹配，请重新获取百纳居报价。');
    if (request.snapshot.targetId !== targetId) throw new Error('百纳居目标与报价不一致。');
    if (request.result) return request.result;
    await requireHomeShopTarget(connection, qqUserId, targetId, true);
    const snapshot = request.snapshot;
    const fresh = await tradeHomeOfferInTransaction(connection, qqUserId, snapshot.offerId, snapshot.quantity, true);
    if (JSON.stringify(fresh) !== JSON.stringify(snapshot.quote)) throw new Error('建材报价、背包或余额已变化，请重新获取报价。');
    const result = await tradeHomeOfferInTransaction(connection, qqUserId, snapshot.offerId, snapshot.quantity, false);
    await completeCraftRequest(connection, characterId, token, result);
    return result;
  });
