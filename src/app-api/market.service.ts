import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { getPool, withTransaction } from '../database/pool';
import { craftCharacterId, createCraftRequest, craftRequestFor, completeCraftRequest } from '../game/alchemy-journal.service';
import {
  cancelMarketOrderInTransaction,
  createMarketOrderInTransaction,
  marketCancelQuoteInTransaction,
  marketCharacterFor,
  marketEligibilityReason,
  marketFeeProfile,
  marketOrderQuoteInTransaction
} from '../game/market.service';

const storyMessage = '先完成梨子喵的谢礼之约，万叶联会才会向你开放。';
export const marketRemoteStoryReason = (stage: number) => !Number.isFinite(stage) || stage < 6 ? storyMessage : null;
const orderRequestKind = 'web_market_order';
const cancelRequestKind = 'web_market_cancel';
const quoteMinutes = 2;

type MarketOrderSide = 'sell' | 'buy';
type OrderSnapshot = {
  side: MarketOrderSide;
  itemId: number;
  price: number;
  quantity: number;
  reference: number;
  estimatedFeeCopper: number;
  idempotencyKey: string;
};
type CancelSnapshot = {
  orderId: number;
  price: number;
  quantity: number;
  feeCopper: number;
  idempotencyKey: string;
};

const validCredential = (value: string) => /^[0-9a-f-]{36}$/i.test(value);

/** H5 世界页可远程交易；资格与剧情由服务端校验，QQ 的现场入口保持原样。 */
export const requireRemoteMarketAccess = async (connection: Pool | PoolConnection, qqUserId: string, lock = false) => {
  const character = await marketCharacterFor(connection, qqUserId, lock);
  const [rows] = await connection.execute<(RowDataPacket & { stage: number })[]>(`SELECT stage FROM player_main_quest_progress
    WHERE character_id=? AND quest_code='girl_gratitude' LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [character.id]);
  const reason = marketRemoteStoryReason(Number(rows[0]?.stage ?? 0));
  if (reason) throw new Error(reason);
  return character;
};

export const remoteMarketAccessStatus = async (qqUserId: string) => {
  const pool = await getPool();
  const [rows] = await pool.execute<(RowDataPacket & { id: number; level: number; adventurer_registered: number; created_at: Date })[]>(`SELECT c.id,c.level,c.adventurer_registered,c.created_at
    FROM characters c JOIN players p ON p.id=c.player_id WHERE p.qq_user_id=? LIMIT 1`, [qqUserId]);
  const character = rows[0];
  const [stages] = character ? await pool.execute<(RowDataPacket & { stage: number })[]>(`SELECT stage FROM player_main_quest_progress
    WHERE character_id=? AND quest_code='girl_gratitude' LIMIT 1`, [character.id]) : [[]];
  const storyStage = Number(stages[0]?.stage ?? 0);
  const reason = marketEligibilityReason(character) ?? marketRemoteStoryReason(storyStage);
  return {
    canTrade: !reason,
    reason,
    locationRequired: false,
    storyStage,
    ...(reason ? {} : { feeProfile: await marketFeeProfile(qqUserId) })
  };
};

export const previewRemoteMarketOrder = (qqUserId: string, side: MarketOrderSide, itemId: number, price: number, quantity: number) =>
  withTransaction(async connection => {
    const character = await requireRemoteMarketAccess(connection, qqUserId, true);
    const quote = await marketOrderQuoteInTransaction(connection, qqUserId, itemId, price, quantity, side);
    const idempotencyKey = randomUUID();
    const snapshot: OrderSnapshot = { side, itemId, price, quantity, reference: quote.reference,
      estimatedFeeCopper: quote.estimatedFeeCopper, idempotencyKey };
    const token = await createCraftRequest(connection, Number(character.id), orderRequestKind, snapshot, quoteMinutes);
    return { token, idempotencyKey, expiresAt: new Date(Date.now() + quoteMinutes * 60_000).toISOString(), quote };
  });

export const confirmRemoteMarketOrder = (qqUserId: string, token: string, idempotencyKey: string) =>
  withTransaction(async connection => {
    if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error('确认凭据无效，请重新获取报价。');
    const characterId = await craftCharacterId(connection, qqUserId, true);
    const request = await craftRequestFor<OrderSnapshot>(connection, characterId, orderRequestKind, token);
    if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error('确认凭据不匹配，请重新获取报价。');
    if (request.result) return request.result;
    await requireRemoteMarketAccess(connection, qqUserId, true);
    const snapshot = request.snapshot;
    const fresh = await marketOrderQuoteInTransaction(connection, qqUserId, snapshot.itemId, snapshot.price, snapshot.quantity, snapshot.side);
    if (fresh.reference !== snapshot.reference || fresh.estimatedFeeCopper > snapshot.estimatedFeeCopper) {
      throw new Error('市场参考价或手续费已变化，请重新获取报价。');
    }
    const result = await createMarketOrderInTransaction(connection, qqUserId, snapshot.itemId, snapshot.price, snapshot.quantity, snapshot.side);
    await completeCraftRequest(connection, characterId, token, result);
    return result;
  });

export const previewRemoteMarketCancel = (qqUserId: string, orderId: number) =>
  withTransaction(async connection => {
    const character = await requireRemoteMarketAccess(connection, qqUserId, true);
    const quote = await marketCancelQuoteInTransaction(connection, qqUserId, orderId);
    const idempotencyKey = randomUUID();
    const snapshot: CancelSnapshot = { orderId, price: quote.price, quantity: quote.quantity, feeCopper: quote.feeCopper, idempotencyKey };
    const token = await createCraftRequest(connection, Number(character.id), cancelRequestKind, snapshot, quoteMinutes);
    return { token, idempotencyKey, expiresAt: new Date(Date.now() + quoteMinutes * 60_000).toISOString(), quote };
  });

export const confirmRemoteMarketCancel = (qqUserId: string, orderId: number, token: string, idempotencyKey: string) =>
  withTransaction(async connection => {
    if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error('确认凭据无效，请重新获取撤单预览。');
    const characterId = await craftCharacterId(connection, qqUserId, true);
    const request = await craftRequestFor<CancelSnapshot>(connection, characterId, cancelRequestKind, token);
    if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error('确认凭据不匹配，请重新获取撤单预览。');
    if (request.snapshot.orderId !== orderId) throw new Error('撤单编号与报价不一致。');
    if (request.result) return request.result;
    await requireRemoteMarketAccess(connection, qqUserId, true);
    const snapshot = request.snapshot;
    const fresh = await marketCancelQuoteInTransaction(connection, qqUserId, snapshot.orderId);
    if (fresh.price !== snapshot.price || fresh.quantity !== snapshot.quantity || fresh.feeCopper > snapshot.feeCopper) {
      throw new Error('订单或撤单费用已变化，请重新获取撤单预览。');
    }
    const result = await cancelMarketOrderInTransaction(connection, qqUserId, snapshot.orderId);
    await completeCraftRequest(connection, characterId, token, result);
    return result;
  });
