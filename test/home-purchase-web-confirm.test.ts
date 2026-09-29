import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('web home purchase confirms an unchanged onsite quote once and replays the same house', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/home-purchase.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const requests = new Map<string, { owner: number; kind: string; snapshot: any; result: any }>();
  let sequence = 0;
  let atSite = true;
  let copper = 600;
  let owned = false;
  let purchases = 0;
  const connection = {};
  const uuid = () => `00000000-0000-0000-0000-${String(++sequence).padStart(12, '0')}`;
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: uuid },
    '../database/pool': { withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work(connection) },
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
      completeCraftRequest: async (sameConnection: unknown, _owner: number, token: string, result: any) => {
        assert.equal(sameConnection, connection);
        requests.get(token)!.result = result;
      }
    },
    '../game/home.constants': { BAINA_RESIDENCE_CODE: 'baina_residence' },
    '../game/home.service': {
      previewHomePurchaseInTransaction: async () => {
        if (!atSite) throw new Error('请先前往百纳镇的百纳居。');
        if (owned) throw new Error('你已经拥有一间小屋。');
        if (copper < 500) throw new Error('铜币不足，需要 500 铜币。');
        return { siteCode: 'baina_residence', name: '冒险者的小屋', price: 500,
          copperBefore: copper, copperAfter: copper - 500, plotAssignedOnConfirm: true };
      },
      purchaseHomeInTransaction: async (sameConnection: unknown) => {
        assert.equal(sameConnection, connection);
        if (!atSite || owned || copper < 500) throw new Error('购房条件不再满足。');
        copper -= 500; owned = true; purchases++;
        return { plot: { x: 4, y: -170, z: 0 }, copper: 500, homeId: 11, name: '冒险者的小屋' };
      }
    }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const service = loaded.exports;

  const preview = await service.previewHomePurchase('player');
  assert.deepEqual([preview.quote.price, preview.quote.plotAssignedOnConfirm, owned, copper], [500, true, false, 600]);
  atSite = false;
  await assert.rejects(service.confirmHomePurchase('player', preview.token, preview.idempotencyKey), /百纳居/);
  atSite = true;
  copper = 550;
  await assert.rejects(service.confirmHomePurchase('player', preview.token, preview.idempotencyKey), /已变化/);
  copper = 600;
  const result = await service.confirmHomePurchase('player', preview.token, preview.idempotencyKey);
  assert.deepEqual(await service.confirmHomePurchase('player', preview.token, preview.idempotencyKey), result);
  assert.deepEqual([result.homeId, copper, owned, purchases], [11, 100, true, 1]);
});
