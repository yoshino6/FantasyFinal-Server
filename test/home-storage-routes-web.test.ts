import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('storage routes require a session, validate input and use dedicated quotes for both directions', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/home-routes.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const gets = new Map<string, (context: any) => Promise<void>>();
  const posts = new Map<string, (context: any) => Promise<void>>();
  const calls: unknown[][] = [];
  const modules: Record<string, unknown> = {
    '../game/app-channel.service': { appSessionQqUser: async () => 'owner' },
    '../game/home.service': { homeOverview: async () => ({ home: null }), homePurchaseSite: async () => ({}) },
    './home-purchase.service': { previewHomePurchase: async () => ({}), confirmHomePurchase: async () => ({}) },
    './home-storage.service': {
      webHomeStorageCatalog: async (...args: unknown[]) => { calls.push(['list', ...args]); return { items: [], capacityKg: 0, depositAvailable: false }; },
      previewWebHomeStorageTransfer: async (...args: unknown[]) => { calls.push(['preview', ...args]); return { token: 'preview-token', quote: { quantity: args[3] } }; },
      confirmWebHomeStorageTransfer: async (...args: unknown[]) => { calls.push(['confirm', ...args]); return { side: args[1], quantity: 2 }; }
    }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  loaded.exports.registerHomeApiRoutes({
    get: (path: string, handler: (context: any) => Promise<void>) => { gets.set(path, handler); },
    post: (path: string, handler: (context: any) => Promise<void>) => { posts.set(path, handler); }
  }, '/api/web/v1', {
    requireSession: async (context: any) => context.authenticated ? { playerId: 1 } : null,
    parseBody: async (context: any) => context.requestBody ?? {},
    apiError: (context: any, status: number, message: string) => { context.status = status; context.body = { ok: false, message }; }
  });

  const base = '/api/web/v1/home/storage';
  await gets.get(base)!({ authenticated: false, query: {} } as any);
  assert.equal(calls.length, 0);
  const list = { authenticated: true, query: { scope: 'storage', category: '材料', page: '2', keyword: '木' } } as any;
  await gets.get(base)!(list);
  assert.deepEqual(calls[0], ['list', 'owner', 'storage', '材料', 2, '木']);
  assert.deepEqual([list.body.ok, list.body.depositAvailable], [true, false]);
  const invalidList = { authenticated: true, query: { scope: 'other' } } as any;
  await gets.get(base)!(invalidList);
  assert.equal(invalidList.status, 400);
  assert.equal(calls.length, 1);

  for (const side of ['deposit', 'withdraw']) {
    const preview = { authenticated: true, requestBody: { itemId: 3, quantity: 2 } } as any;
    await posts.get(`${base}/${side}/preview`)!(preview);
    assert.equal(preview.body.quote.quantity, 2);
    assert.deepEqual(calls.at(-1), ['preview', 'owner', side, 3, 2]);
    const confirm = { authenticated: true, requestBody: { token: 'token', idempotencyKey: 'key' } } as any;
    await posts.get(`${base}/${side}/confirm`)!(confirm);
    assert.deepEqual(calls.at(-1), ['confirm', 'owner', side, 'token', 'key']);
    assert.deepEqual(confirm.body.refresh, ['home', 'inventory', 'summary']);
  }
  const count = calls.length;
  await posts.get(`${base}/withdraw/preview`)!({ authenticated: false, requestBody: { itemId: 3, quantity: 2 } } as any);
  const invalidQuantity = { authenticated: true, requestBody: { itemId: 3, quantity: 0 } } as any;
  await posts.get(`${base}/deposit/preview`)!(invalidQuantity);
  assert.equal(invalidQuantity.status, 400);
  assert.equal(calls.length, count);
});
