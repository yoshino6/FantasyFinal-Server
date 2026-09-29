import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('bookshop routes require a session and pass the current map target to quote and confirm', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/bookshop-routes.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const gets = new Map<string, (context: any) => Promise<void>>();
  const posts = new Map<string, (context: any) => Promise<void>>();
  const calls: unknown[][] = [];
  const modules: Record<string, unknown> = {
    '../game/app-channel.service': { appSessionQqUser: async () => 'player' },
    './bookshop.service': {
      bookshopShelf: async (...args: unknown[]) => { calls.push(['shelf', ...args]); return { items: [], page: 1, totalPages: 1 }; },
      bookshopItem: async (...args: unknown[]) => { calls.push(['item', ...args]); return { item: { id: 3 } }; },
      bookshopSellable: async (...args: unknown[]) => { calls.push(['sellable', ...args]); return { items: [] }; },
      previewBookshopTrade: async (...args: unknown[]) => { calls.push(['preview', ...args]); return { token: 't' }; },
      confirmBookshopTrade: async (...args: unknown[]) => { calls.push(['confirm', ...args]); return { price: 4 }; }
    }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  loaded.exports.registerBookshopApiRoutes({
    get: (path: string, handler: (context: any) => Promise<void>) => { gets.set(path, handler); },
    post: (path: string, handler: (context: any) => Promise<void>) => { posts.set(path, handler); }
  }, '/api/web/v1', {
    requireSession: async (context: any) => context.authenticated ? { playerId: 1 } : null,
    parseBody: async (context: any) => context.requestBody ?? {},
    apiError: (context: any, status: number, message: string) => { context.status = status; context.body = { ok: false, message }; }
  });
  const shelfPath = '/api/web/v1/places/:targetId/bookshop';
  await gets.get(shelfPath)!({ authenticated: false } as any);
  assert.equal(calls.length, 0);
  const shelf = { authenticated: true, params: { targetId: 'bookshop' }, query: { page: '1', keyword: '古书' } } as any;
  await gets.get(shelfPath)!(shelf);
  assert.deepEqual(calls[0], ['shelf', 'player', 'bookshop', 1, '古书']);
  const detail = { authenticated: true, params: { targetId: 'bookshop', id: '3' } } as any;
  await gets.get(`${shelfPath}/items/:id`)!(detail);
  assert.deepEqual(calls[1], ['item', 'player', 'bookshop', 3]);
  const sale = { authenticated: true, params: { targetId: 'bookshop' }, requestBody: { itemId: 5, quantity: 2 } } as any;
  await posts.get(`${shelfPath}/sell/preview`)!(sale);
  assert.deepEqual(calls[2], ['preview', 'player', 'bookshop', 'sell', 5, 2]);
  const confirm = { authenticated: true, params: { targetId: 'bookshop' }, requestBody: { token: 't', idempotencyKey: 'k' } } as any;
  await posts.get(`${shelfPath}/sell/confirm`)!(confirm);
  assert.deepEqual(calls[3], ['confirm', 'player', 'bookshop', 'sell', 't', 'k']);
  assert.deepEqual(confirm.body.refresh, ['summary', 'inventory', 'map', 'bookshop']);
  const invalid = { authenticated: true, params: { targetId: '../other' }, requestBody: { itemId: 3 } } as any;
  await posts.get(`${shelfPath}/buy/preview`)!(invalid);
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 4);
});
