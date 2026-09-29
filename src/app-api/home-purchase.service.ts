import { randomUUID } from 'node:crypto';
import { withTransaction } from '../database/pool';
import { craftCharacterId, createCraftRequest, craftRequestFor, completeCraftRequest } from '../game/alchemy-journal.service';
import { BAINA_RESIDENCE_CODE } from '../game/home.constants';
import { previewHomePurchaseInTransaction, purchaseHomeInTransaction } from '../game/home.service';

type Snapshot = { quote: Record<string, unknown>; idempotencyKey: string };
const requestKind = 'web_home_purchase';
const quoteMinutes = 2;
const validCredential = (value: string) => /^[0-9a-f-]{36}$/i.test(value);

export const previewHomePurchase = (qqUserId: string) => withTransaction(async connection => {
  const quote = await previewHomePurchaseInTransaction(connection, qqUserId);
  const characterId = await craftCharacterId(connection, qqUserId, true);
  const idempotencyKey = randomUUID();
  const token = await createCraftRequest(connection, characterId, requestKind,
    { quote, idempotencyKey } satisfies Snapshot, quoteMinutes);
  return { token, idempotencyKey, expiresAt: new Date(Date.now() + quoteMinutes * 60_000).toISOString(),
    target: { id: BAINA_RESIDENCE_CODE, name: '百纳居', locationRequired: true }, quote };
});

export const confirmHomePurchase = (qqUserId: string, token: string, idempotencyKey: string) => withTransaction(async connection => {
  if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error('确认凭据无效，请重新获取购房报价。');
  const characterId = await craftCharacterId(connection, qqUserId, true);
  const request = await craftRequestFor<Snapshot>(connection, characterId, requestKind, token);
  if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error('确认凭据不匹配，请重新获取购房报价。');
  if (request.result) return request.result;
  const fresh = await previewHomePurchaseInTransaction(connection, qqUserId);
  if (JSON.stringify(fresh) !== JSON.stringify(request.snapshot.quote)) throw new Error('购房余额或角色状态已变化，请重新获取报价。');
  const result = await purchaseHomeInTransaction(connection, qqUserId);
  await completeCraftRequest(connection, characterId, token, result);
  return result;
});
