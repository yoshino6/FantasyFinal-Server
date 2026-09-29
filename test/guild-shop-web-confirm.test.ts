import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('web guild shop requires the current guild target and confirms each quoted trade once', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/guild-shop.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const requests = new Map<string, { owner: number; kind: string; snapshot: any; result: any }>();
  let nextId = 0;
  let currentTarget = 'guild_counter';
  let stock = 4;
  let contribution = 100;
  let inventory = 5;
  let trades = 0;
  let affinityAwards = 0;
  const uuid = () => `00000000-0000-0000-0000-${String(++nextId).padStart(12, '0')}`;
  const guild = { requireGuildService: async () => {
    if (!currentTarget) throw new Error('请先到当地冒险者公会入口。');
    return { code: 'baina_town', hub: { guild: currentTarget, guildName: '冒险者公会', host: '莫妮卡' } };
  } };
  const core = {
    buyShopItemInTransaction: async (_connection: unknown, _user: string, itemId: number, quantity: number, preview: boolean) => {
      if (!currentTarget) throw new Error('请先到当地冒险者公会入口。');
      if (stock < quantity) throw new Error('库存不足。');
      const quote = { itemId, name: '补给', category: '药剂', quantity, price: 10 * quantity,
        contributionBefore: contribution, contributionAfter: contribution - 10 * quantity,
        stockBefore: stock, stockAfter: stock - quantity, personalBound: false, discountCredit: 0, talentDiscount: 0 };
      if (!preview) { contribution = quote.contributionAfter; stock -= quantity; inventory += quantity; trades++; }
      return quote;
    },
    sellShopItemInTransaction: async (_connection: unknown, _user: string, itemId: number, quantity: number, preview: boolean) => {
      if (!currentTarget) throw new Error('请先到当地冒险者公会入口。');
      if (inventory < quantity) throw new Error('背包数量不足。');
      const quote = { itemId, name: '兽材', category: '材料', quantity, unitPrice: 2, price: 2 * quantity,
        contributionBefore: contribution, contributionAfter: contribution + 2 * quantity,
        ownedBefore: inventory, ownedAfter: inventory - quantity, sellableBefore: inventory, sellableAfter: inventory - quantity };
      if (!preview) { contribution = quote.contributionAfter; inventory -= quantity; trades++; }
      return quote;
    },
    shopCatalog: async () => ({ items: [] }), shopItemDetail: async () => ({}), sellCatalog: async () => ({ items: [] })
  };
  const craft = {
    craftCharacterId: async () => 1,
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
    '../game/guild-context': guild,
    '../game/guild-shop.service': core,
    '../game/adventure.service': { addNpcAffinityFor: async () => { affinityAwards++; return { affinity: 5 }; } }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const service = loaded.exports;

  await assert.rejects(service.previewGuildShopTrade('player', 'wrong_guild', 'buy', 3, 1), /当前公会入口/);
  assert.equal(requests.size, 0);
  const preview = await service.previewGuildShopTrade('player', 'guild_counter', 'buy', 3, 2);
  assert.deepEqual([preview.quote.price, preview.quote.stockAfter], [20, 2]);
  assert.deepEqual([trades, affinityAwards], [0, 0]);
  await assert.rejects(service.confirmGuildShopTrade('player', 'windbranch_guild', 'buy', preview.token, preview.idempotencyKey), /目标与报价不一致/);
  currentTarget = '';
  await assert.rejects(service.confirmGuildShopTrade('player', 'guild_counter', 'buy', preview.token, preview.idempotencyKey), /公会入口/);
  currentTarget = 'guild_counter';
  stock = 3;
  await assert.rejects(service.confirmGuildShopTrade('player', 'guild_counter', 'buy', preview.token, preview.idempotencyKey), /库存、余额或折扣已变化/);
  stock = 4;
  const bought = await service.confirmGuildShopTrade('player', 'guild_counter', 'buy', preview.token, preview.idempotencyKey);
  assert.deepEqual(await service.confirmGuildShopTrade('player', 'guild_counter', 'buy', preview.token, preview.idempotencyKey), bought);
  assert.deepEqual([stock, contribution, inventory, trades, affinityAwards], [2, 80, 7, 1, 1]);
  const sale = await service.previewGuildShopTrade('player', 'guild_counter', 'sell', 9, 2);
  const sold = await service.confirmGuildShopTrade('player', 'guild_counter', 'sell', sale.token, sale.idempotencyKey);
  assert.equal(sold.price, 4);
  assert.deepEqual([contribution, inventory, trades, affinityAwards], [84, 5, 2, 2]);
});
