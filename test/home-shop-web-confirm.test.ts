import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('web 百纳居 quote rechecks the site and inventory, then completes one trade', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/home-shop.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const requests = new Map<string, { owner: number; kind: string; snapshot: any; result: any }>();
  let sequence = 0;
  let atShop = true;
  let teammateCombat = false;
  let material = 3;
  let personalMaterial = 1;
  let gained = 0;
  let trades = 0;
  const uuid = () => `00000000-0000-0000-0000-${String(++sequence).padStart(12, '0')}`;
  const core = {
    requireHomeShopTarget: async (_connection: unknown, _user: string, targetId: string) => {
      if (targetId !== 'baina_residence') throw new Error('百纳居目标无效。');
      if (!atShop) throw new Error('请先前往百纳镇的百纳居。');
      if (teammateCombat) throw new Error('战斗中无法在百纳居买卖。');
      return { characterId: 7, target: { id: targetId, name: '百纳居', locationRequired: true } };
    },
    tradeHomeOfferInTransaction: async (_connection: unknown, _user: string, offerId: number, quantity: number, preview: boolean) => {
      if (!atShop) throw new Error('请先前往百纳镇的百纳居。');
      if (teammateCombat) throw new Error('战斗中无法在百纳居买卖。');
      if (material < quantity) throw new Error('兑换材料不足。');
      const quote = { offerId, code: 'exchange_living_wood', name: '木材', quantity: quantity * 10,
        tradeCount: quantity, inputQuantity: quantity, inputOwnedBefore: material, inputOwnedAfter: material - quantity,
        inputBindingUsed: { personal: Math.min(personalMaterial, quantity), unbound: quantity - Math.min(personalMaterial, quantity), trade: 0 } };
      if (!preview) { material -= quantity; gained += quantity * 10; trades++; }
      return quote;
    },
    listHomeShop: async () => ({ offers: [] }), homeShopOfferDetail: async () => ({ offer: {} })
  };
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: uuid },
    '../database/pool': { getPool: async () => ({}), withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work({}) },
    '../game/alchemy-journal.service': {
      craftCharacterId: async () => 7,
      createCraftRequest: async (_connection: unknown, owner: number, kind: string, snapshot: any) => {
        const token = uuid(); requests.set(token, { owner, kind, snapshot, result: null }); return token;
      },
      craftRequestFor: async (_connection: unknown, owner: number, kind: string, token: string) => {
        const request = requests.get(token);
        if (!request || request.owner !== owner || request.kind !== kind) throw new Error('Invalid request');
        return request;
      },
      completeCraftRequest: async (_connection: unknown, _owner: number, token: string, result: any) => { requests.get(token)!.result = result; }
    },
    '../game/home.service': core
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const service = loaded.exports;

  await assert.rejects(service.previewHomeShopTrade('player', 'wrong', 2, 2), /目标无效/);
  assert.equal(requests.size, 0);
  const preview = await service.previewHomeShopTrade('player', 'baina_residence', 2, 2);
  assert.deepEqual([preview.quote.quantity, material, gained], [20, 3, 0]);
  atShop = false;
  await assert.rejects(service.confirmHomeShopTrade('player', 'baina_residence', preview.token, preview.idempotencyKey), /百纳居/);
  atShop = true;
  teammateCombat = true;
  await assert.rejects(service.confirmHomeShopTrade('player', 'baina_residence', preview.token, preview.idempotencyKey), /战斗中/);
  teammateCombat = false;
  material = 4;
  await assert.rejects(service.confirmHomeShopTrade('player', 'baina_residence', preview.token, preview.idempotencyKey), /已变化/);
  material = 3;
  personalMaterial = 2;
  await assert.rejects(service.confirmHomeShopTrade('player', 'baina_residence', preview.token, preview.idempotencyKey), /已变化/);
  personalMaterial = 1;
  const settled = await service.confirmHomeShopTrade('player', 'baina_residence', preview.token, preview.idempotencyKey);
  assert.deepEqual(await service.confirmHomeShopTrade('player', 'baina_residence', preview.token, preview.idempotencyKey), settled);
  assert.deepEqual([material, gained, trades], [1, 20, 1]);
});
