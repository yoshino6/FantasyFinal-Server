import { randomUUID } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import { withTransaction } from '../database/pool';
import { craftCharacterId, createCraftRequest, craftRequestFor, completeCraftRequest } from '../game/alchemy-journal.service';
import {
  bankTransferInTransaction, depositProducts, openBankDepositInTransaction,
  settleBankDepositInTransaction, type DepositProduct
} from '../game/finance.service';

export const BANK_TARGET_ID = 'silver_bell_bank';
export const BANK_ACTIONS = ['deposit', 'withdraw', 'term_open', 'settle', 'early_settle'] as const;
export type BankAction = typeof BANK_ACTIONS[number];
export type BankActionInput = { action: BankAction; amount?: number; productCode?: DepositProduct; depositId?: number };
const requestKind = 'web_bank_action';
const quoteMinutes = 2;
const validCredential = (value: string) => /^[0-9a-f-]{36}$/i.test(value);

const actionResult = async (connection: PoolConnection, qqUserId: string, input: BankActionInput, preview: boolean) => {
  switch (input.action) {
    case 'deposit': return bankTransferInTransaction(connection, qqUserId, Number(input.amount), 'in', preview);
    case 'withdraw': return bankTransferInTransaction(connection, qqUserId, Number(input.amount), 'out', preview);
    case 'term_open':
      if (!input.productCode || !(input.productCode in depositProducts)) throw new Error('未知存单期限。');
      return openBankDepositInTransaction(connection, qqUserId, input.productCode, Number(input.amount), preview);
    case 'settle': return settleBankDepositInTransaction(connection, qqUserId, Number(input.depositId), false, preview);
    case 'early_settle': return settleBankDepositInTransaction(connection, qqUserId, Number(input.depositId), true, preview);
    default: throw new Error('不支持该钱庄操作。');
  }
};

/** The maturity timestamp starts when a term is actually opened, so compare its financial terms instead. */
export const bankQuoteFingerprint = (quote: Record<string, unknown>) => {
  const { due, id, ...stable } = quote;
  return JSON.stringify(stable);
};

type Snapshot = BankActionInput & { quote: Record<string, unknown>; idempotencyKey: string };

export const previewBankAction = (qqUserId: string, input: BankActionInput) => withTransaction(async connection => {
  const characterId = await craftCharacterId(connection, qqUserId, true);
  const quote = await actionResult(connection, qqUserId, input, true);
  const idempotencyKey = randomUUID();
  const token = await createCraftRequest(connection, characterId, requestKind,
    { ...input, quote, idempotencyKey } satisfies Snapshot, quoteMinutes);
  return { token, idempotencyKey, expiresAt: new Date(Date.now() + quoteMinutes * 60_000).toISOString(), quote };
});

export const confirmBankAction = (qqUserId: string, token: string, idempotencyKey: string) => withTransaction(async connection => {
  if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error('确认凭据无效，请重新获取钱庄报价。');
  const characterId = await craftCharacterId(connection, qqUserId, true);
  const request = await craftRequestFor<Snapshot>(connection, characterId, requestKind, token);
  if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error('确认凭据不匹配，请重新获取钱庄报价。');
  if (request.result) return request.result;
  const fresh = await actionResult(connection, qqUserId, request.snapshot, true);
  if (bankQuoteFingerprint(fresh) !== bankQuoteFingerprint(request.snapshot.quote)) {
    throw new Error('钱庄余额或存单状态已变化，请重新获取报价。');
  }
  const result = await actionResult(connection, qqUserId, request.snapshot, false);
  await completeCraftRequest(connection, characterId, token, result);
  return result;
});
