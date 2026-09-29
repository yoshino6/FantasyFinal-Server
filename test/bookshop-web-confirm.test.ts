import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('web bookshop confirms buy and sell once, with location and fresh quote checks', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/bookshop.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const requests = new Map<string, { owner: number; kind: string; snapshot: any; result: any }>();
  let sequence = 0;
  let atShop = true;
  let teammateCombat = false;
  let stock = 4;
  let copper = 100;
  let inventory = 3;
  let trades = 0;
  let affinityAwards = 0;
  const uuid = () => `00000000-0000-0000-0000-${String(++sequence).padStart(12, '0')}`;
  const core = {
    BOOKSHOP_TARGET_ID: 'bookshop',
    requireBookshopTarget: async (_connection: unknown, _user: string, target: string) => {
      if (target !== 'bookshop') throw new Error('书屋目标无效。');
      if (!atShop) throw new Error('你已经离开该目标坐标，无法继续互动。');
      if (teammateCombat) throw new Error('战斗中无法在百味书屋买卖。');
      return { characterId: 7, target: { id: 'bookshop', name: '百味书屋', locationRequired: true } };
    },
    buyBookshopItemInTransaction: async (_connection: unknown, _user: string, itemId: number, quantity: number, preview: boolean) => {
      if (!atShop) throw new Error('你已经离开该目标坐标，无法继续互动。');
      if (teammateCombat) throw new Error('战斗中无法在百味书屋买卖。');
      if (stock < quantity) throw new Error('库存不足。');
      const quote = { itemId, name: '古书', quantity, unitPrice: 20, price: 20 * quantity,
        stockBefore: stock, stockAfter: stock - quantity, copperBefore: copper, copperAfter: copper - 20 * quantity };
      if (!preview) { stock -= quantity; copper -= 20 * quantity; inventory += quantity; trades++; }
      return quote;
    },
    sellBookshopItemInTransaction: async (_connection: unknown, _user: string, itemId: number, quantity: number, preview: boolean) => {
      if (!atShop) throw new Error('你已经离开该目标坐标，无法继续互动。');
      if (teammateCombat) throw new Error('战斗中无法在百味书屋买卖。');
      if (inventory < quantity) throw new Error('背包数量不足。');
      const quote = { itemId, name: '古书', quantity, unitPrice: 12, price: 12 * quantity,
        ownedBefore: inventory, ownedAfter: inventory - quantity, copperBefore: copper, copperAfter: copper + 12 * quantity };
      if (!preview) { inventory -= quantity; copper += 12 * quantity; trades++; }
      return quote;
    },
    bookshopCatalog: async () => ({ items: [] }), bookshopItemDetail: async () => ({}), bookshopSellCatalog: async () => ({ items: [] })
  };
  const craft = {
    craftCharacterId: async () => 7,
    createCraftRequest: async (_connection: unknown, owner: number, kind: string, snapshot: any) => {
      const token = uuid(); requests.set(token, { owner, kind, snapshot, result: null }); return token;
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
    '../database/pool': { getPool: async () => ({}), withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work({}) },
    '../game/alchemy-journal.service': craft,
    '../game/adventure.service': { addNpcAffinityFor: async () => { affinityAwards++; return { affinity: 5 }; } },
    '../game/bookshop.service': core
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const service = loaded.exports;

  await assert.rejects(service.previewBookshopTrade('player', 'other', 'buy', 3, 1), /书屋目标无效/);
  assert.equal(requests.size, 0);
  const buy = await service.previewBookshopTrade('player', 'bookshop', 'buy', 3, 2);
  assert.deepEqual([buy.quote.price, buy.quote.stockAfter, trades], [40, 2, 0]);
  atShop = false;
  await assert.rejects(service.confirmBookshopTrade('player', 'bookshop', 'buy', buy.token, buy.idempotencyKey), /离开该目标坐标/);
  atShop = true;
  teammateCombat = true;
  await assert.rejects(service.confirmBookshopTrade('player', 'bookshop', 'buy', buy.token, buy.idempotencyKey), /战斗中/);
  teammateCombat = false;
  stock = 3;
  await assert.rejects(service.confirmBookshopTrade('player', 'bookshop', 'buy', buy.token, buy.idempotencyKey), /已变化/);
  stock = 4;
  const bought = await service.confirmBookshopTrade('player', 'bookshop', 'buy', buy.token, buy.idempotencyKey);
  assert.deepEqual(await service.confirmBookshopTrade('player', 'bookshop', 'buy', buy.token, buy.idempotencyKey), bought);
  assert.deepEqual([stock, copper, inventory, trades, affinityAwards], [2, 60, 5, 1, 1]);
  const sale = await service.previewBookshopTrade('player', 'bookshop', 'sell', 3, 2);
  await service.confirmBookshopTrade('player', 'bookshop', 'sell', sale.token, sale.idempotencyKey);
  assert.deepEqual([copper, inventory, trades, affinityAwards], [84, 3, 2, 2]);
});
