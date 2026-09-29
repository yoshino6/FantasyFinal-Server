import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('百纳居 routes require a session and validate the offer and quantity', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/home-shop-routes.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const gets = new Map<string, (context: any) => Promise<void>>();
  const posts = new Map<string, (context: any) => Promise<void>>();
  const calls: unknown[][] = [];
  const modules: Record<string, unknown> = {
    '../game/app-channel.service': { appSessionQqUser: async () => 'player' },
    './home-shop.service': {
      homeShopShelf: async (...args: unknown[]) => { calls.push(['shelf', ...args]); return { offers: [] }; },
      homeShopOffer: async (...args: unknown[]) => { calls.push(['offer', ...args]); return { offer: { id: 2 } }; },
      previewHomeShopTrade: async (...args: unknown[]) => { calls.push(['preview', ...args]); return { token: 't' }; },
      confirmHomeShopTrade: async (...args: unknown[]) => { calls.push(['confirm', ...args]); return { quantity: 20 }; }
    }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  loaded.exports.registerHomeShopApiRoutes({
    get: (path: string, handler: (context: any) => Promise<void>) => { gets.set(path, handler); },
    post: (path: string, handler: (context: any) => Promise<void>) => { posts.set(path, handler); }
  }, '/api/web/v1', {
    requireSession: async (context: any) => context.authenticated ? { playerId: 1 } : null,
    parseBody: async (context: any) => context.requestBody ?? {},
    apiError: (context: any, status: number, message: string) => { context.status = status; context.body = { ok: false, message }; }
  });
  const shelfPath = '/api/web/v1/places/:targetId/home-shop';
  await gets.get(shelfPath)!({ authenticated: false } as any);
  assert.equal(calls.length, 0);
  const shelf = { authenticated: true, params: { targetId: 'baina_residence' } } as any;
  await gets.get(shelfPath)!(shelf);
  assert.deepEqual(calls[0], ['shelf', 'player', 'baina_residence']);
  const detail = { authenticated: true, params: { targetId: 'baina_residence', id: '2' } } as any;
  await gets.get(`${shelfPath}/offers/:id`)!(detail);
  assert.deepEqual(calls[1], ['offer', 'player', 'baina_residence', 2]);
  const preview = { authenticated: true, params: { targetId: 'baina_residence' }, requestBody: { offerId: 2, quantity: 2 } } as any;
  await posts.get(`${shelfPath}/trade/preview`)!(preview);
  assert.deepEqual(calls[2], ['preview', 'player', 'baina_residence', 2, 2]);
  const confirm = { authenticated: true, params: { targetId: 'baina_residence' }, requestBody: { token: 't', idempotencyKey: 'k' } } as any;
  await posts.get(`${shelfPath}/trade/confirm`)!(confirm);
  assert.deepEqual(calls[3], ['confirm', 'player', 'baina_residence', 't', 'k']);
  assert.deepEqual(confirm.body.refresh, ['summary', 'inventory', 'map', 'homeShop']);
  const invalid = { authenticated: true, params: { targetId: '../other' }, requestBody: { offerId: 2 } } as any;
  await posts.get(`${shelfPath}/trade/preview`)!(invalid);
  assert.equal(invalid.status, 400);
  const invalidAmount = { authenticated: true, params: { targetId: 'baina_residence' }, requestBody: { offerId: 2, quantity: 1000 } } as any;
  await posts.get(`${shelfPath}/trade/preview`)!(invalidAmount);
  assert.equal(invalidAmount.status, 400);
  assert.equal(calls.length, 4);
});
