import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('guild shop routes require a web session and pass the map target to the service', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/guild-shop-routes.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const gets = new Map<string, (context: any) => Promise<void>>();
  const posts = new Map<string, (context: any) => Promise<void>>();
  const calls: unknown[][] = [];
  const modules: Record<string, unknown> = {
    '../game/app-channel.service': { appSessionQqUser: async () => 'player' },
    './guild-shop.service': {
      guildShopShelf: async (...args: unknown[]) => { calls.push(['shelf', ...args]); return { items: [], page: 1, totalPages: 1 }; },
      guildShopItem: async (...args: unknown[]) => { calls.push(['item', ...args]); return { item: { id: 3 } }; },
      guildShopSellable: async (...args: unknown[]) => { calls.push(['sellable', ...args]); return { items: [] }; },
      previewGuildShopTrade: async (...args: unknown[]) => { calls.push(['preview', ...args]); return { token: 't' }; },
      confirmGuildShopTrade: async (...args: unknown[]) => { calls.push(['confirm', ...args]); return { price: 4 }; }
    }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  loaded.exports.registerGuildShopApiRoutes({
    get: (path: string, handler: (context: any) => Promise<void>) => { gets.set(path, handler); },
    post: (path: string, handler: (context: any) => Promise<void>) => { posts.set(path, handler); }
  }, '/api/web/v1', {
    requireSession: async (context: any) => context.authenticated ? { playerId: 1 } : null,
    parseBody: async (context: any) => context.requestBody ?? {},
    apiError: (context: any, status: number, message: string) => { context.status = status; context.body = { ok: false, message }; }
  });
  const shelfPath = '/api/web/v1/places/:targetId/guild-shop';
  await gets.get(shelfPath)!({ authenticated: false } as any);
  assert.equal(calls.length, 0);
  const shelf = { authenticated: true, params: { targetId: 'guild_counter' }, query: { page: '1', keyword: '药剂' } } as any;
  await gets.get(shelfPath)!(shelf);
  assert.deepEqual(calls[0], ['shelf', 'player', 'guild_counter', 1, '药剂']);
  assert.equal(shelf.body.ok, true);
  const buy = { authenticated: true, params: { targetId: 'guild_counter' }, requestBody: { itemId: 3, quantity: 2 } } as any;
  await posts.get(`${shelfPath}/buy/preview`)!(buy);
  assert.deepEqual(calls[1], ['preview', 'player', 'guild_counter', 'buy', 3, 2]);
  const invalid = { authenticated: true, params: { targetId: '../other' }, requestBody: { itemId: 3 } } as any;
  await posts.get(`${shelfPath}/buy/preview`)!(invalid);
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 2);
});
