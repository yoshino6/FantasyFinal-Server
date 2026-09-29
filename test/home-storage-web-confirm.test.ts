import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('web storage quotes recheck binding and capacity, confirm once, and replay the result', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/home-storage.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const requests = new Map<string, { owner: number; kind: string; snapshot: any; result: any }>();
  let sequence = 0;
  let capacity = 10;
  let backpack = 5;
  let stored = 2;
  let personal = 1;
  let transfers = 0;
  const connection = {};
  const uuid = () => `00000000-0000-0000-0000-${String(++sequence).padStart(12, '0')}`;
  const quote = (_connection: unknown, _user: string, itemId: number, quantity: number, preview: boolean, side: 'deposit' | 'withdraw') => {
    assert.equal(itemId, 3);
    const available = side === 'deposit' ? backpack : stored;
    if (side === 'deposit' && capacity === 0) throw new Error('尚未摆放储物箱，暂时没有可用仓储空间。');
    if (available < quantity) throw new Error('数量不足。');
    const result = { side, itemId, quantity, ownedBefore: available, capacity, personal,
      usedWeightBefore: stored, usedWeightAfter: stored + (side === 'deposit' ? quantity : -quantity) };
    if (!preview) {
      assert.equal(_connection, connection);
      if (side === 'deposit') { backpack -= quantity; stored += quantity; }
      else { stored -= quantity; backpack += quantity; }
      transfers++;
    }
    return result;
  };
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: uuid },
    '../database/pool': { getPool: async () => ({}), withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work(connection) },
    '../game/alchemy-journal.service': {
      craftCharacterId: async (_connection: unknown, user: string) => user === 'owner' ? 7 : 8,
      createCraftRequest: async (_connection: unknown, owner: number, kind: string, snapshot: any) => {
        const token = uuid(); requests.set(token, { owner, kind, snapshot, result: null }); return token;
      },
      craftRequestFor: async (_connection: unknown, owner: number, kind: string, token: string) => {
        const request = requests.get(token);
        if (!request || request.owner !== owner || request.kind !== kind) throw new Error('确认不属于你。');
        return request;
      },
      completeCraftRequest: async (_connection: unknown, _owner: number, token: string, result: any) => { requests.get(token)!.result = result; }
    },
    '../game/home.service': {
      depositHomeStorageInTransaction: async (...args: [unknown, string, number, number, boolean]) => quote(...args, 'deposit'),
      withdrawHomeStorageInTransaction: async (...args: [unknown, string, number, number, boolean]) => quote(...args, 'withdraw'),
      homeOverview: async () => ({ home: { id: 11, storage: { capacityKg: capacity, usedKg: stored } } })
    }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const service = loaded.exports;

  const deposit = await service.previewWebHomeStorageTransfer('owner', 'deposit', 3, 2);
  assert.deepEqual([deposit.quote.ownedBefore, backpack, stored, transfers], [5, 5, 2, 0]);
  await assert.rejects(service.confirmWebHomeStorageTransfer('other', 'deposit', deposit.token, deposit.idempotencyKey), /不属于你/);
  await assert.rejects(service.confirmWebHomeStorageTransfer('owner', 'withdraw', deposit.token, deposit.idempotencyKey), /不属于你/);
  personal = 2;
  await assert.rejects(service.confirmWebHomeStorageTransfer('owner', 'deposit', deposit.token, deposit.idempotencyKey), /已变化/);
  personal = 1;
  capacity = 0;
  await assert.rejects(service.confirmWebHomeStorageTransfer('owner', 'deposit', deposit.token, deposit.idempotencyKey), /储物箱/);
  capacity = 10;
  const settled = await service.confirmWebHomeStorageTransfer('owner', 'deposit', deposit.token, deposit.idempotencyKey);
  assert.deepEqual(await service.confirmWebHomeStorageTransfer('owner', 'deposit', deposit.token, deposit.idempotencyKey), settled);
  assert.deepEqual([backpack, stored, transfers], [3, 4, 1]);

  capacity = 0;
  const withdraw = await service.previewWebHomeStorageTransfer('owner', 'withdraw', 3, 3);
  assert.equal(withdraw.quote.capacity, 0);
  const recovered = await service.confirmWebHomeStorageTransfer('owner', 'withdraw', withdraw.token, withdraw.idempotencyKey);
  assert.deepEqual([recovered.side, backpack, stored, transfers], ['withdraw', 6, 1, 2]);
  assert.deepEqual(await service.confirmWebHomeStorageTransfer('owner', 'withdraw', withdraw.token, withdraw.idempotencyKey), recovered);
  assert.equal(transfers, 2);
});
