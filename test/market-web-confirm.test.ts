import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('web market confirmation replays one settled order and rejects a mismatched cancellation path', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/market.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const requests = new Map<string, { owner: number; kind: string; snapshot: any; result: any }>();
  let nextId = 0;
  let ordersCreated = 0;
  let ordersCancelled = 0;
  let storyStage = 6;
  let reference = 20;
  let estimatedFeeCopper = 1;
  const uuid = () => `00000000-0000-0000-0000-${String(++nextId).padStart(12, '0')}`;
  const connection = {
    execute: async (sql: string) => {
      if (sql.includes('player_main_quest_progress')) return [[{ stage: storyStage }]];
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const market = {
    marketCharacterFor: async () => ({ id: 1 }),
    marketEligibilityReason: () => null,
    marketFeeProfile: async () => ({}),
    marketOrderQuoteInTransaction: async () => ({ reference, price: 20, quantity: 1, estimatedFeeCopper }),
    createMarketOrderInTransaction: async () => ({ orderId: ++ordersCreated, status: 'filled' }),
    marketCancelQuoteInTransaction: async () => ({ orderId: 7, price: 20, quantity: 1, feeCopper: 1 }),
    cancelMarketOrderInTransaction: async () => ({ orderId: 7, quantity: ++ordersCancelled })
  };
  const craft = {
    craftCharacterId: async () => 1,
    createCraftRequest: async (_connection: unknown, owner: number, kind: string, snapshot: any) => {
      const token = uuid();
      requests.set(token, { owner, kind, snapshot, result: null });
      return token;
    },
    craftRequestFor: async (_connection: unknown, owner: number, kind: string, token: string) => {
      const request = requests.get(token);
      if (!request || request.owner !== owner || request.kind !== kind) throw new Error('Invalid request');
      return request;
    },
    completeCraftRequest: async (_connection: unknown, _owner: number, token: string, result: any) => {
      requests.get(token)!.result = result;
    }
  };
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: uuid },
    '../database/pool': { getPool: async () => connection, withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work(connection) },
    '../game/alchemy-journal.service': craft,
    '../game/market.service': market
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const service = loaded.exports;

  storyStage = 5;
  await assert.rejects(service.previewRemoteMarketOrder('player', 'buy', 3, 20, 1), /谢礼之约/);
  assert.equal(requests.size, 0);
  storyStage = 6;
  const preview = await service.previewRemoteMarketOrder('player', 'buy', 3, 20, 1);
  await assert.rejects(service.confirmRemoteMarketOrder('player', preview.token, uuid()), /凭据不匹配/);
  assert.equal(ordersCreated, 0);
  reference = 21;
  await assert.rejects(service.confirmRemoteMarketOrder('player', preview.token, preview.idempotencyKey), /参考价或手续费已变化/);
  assert.equal(ordersCreated, 0);
  reference = 20;
  estimatedFeeCopper = 2;
  await assert.rejects(service.confirmRemoteMarketOrder('player', preview.token, preview.idempotencyKey), /参考价或手续费已变化/);
  assert.equal(ordersCreated, 0);
  estimatedFeeCopper = 1;
  const first = await service.confirmRemoteMarketOrder('player', preview.token, preview.idempotencyKey);
  const replay = await service.confirmRemoteMarketOrder('player', preview.token, preview.idempotencyKey);
  assert.deepEqual(replay, first);
  assert.equal(ordersCreated, 1);

  const cancellation = await service.previewRemoteMarketCancel('player', 7);
  await assert.rejects(service.confirmRemoteMarketCancel('player', 8, cancellation.token, cancellation.idempotencyKey), /编号与报价不一致/);
  assert.equal(ordersCancelled, 0);
  const cancelled = await service.confirmRemoteMarketCancel('player', 7, cancellation.token, cancellation.idempotencyKey);
  assert.deepEqual(await service.confirmRemoteMarketCancel('player', 7, cancellation.token, cancellation.idempotencyKey), cancelled);
  assert.equal(ordersCancelled, 1);
});
