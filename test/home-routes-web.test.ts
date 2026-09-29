import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('home read routes require the web session and reject an unopened floor', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/home-routes.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const handlers = new Map<string, (context: any) => Promise<void>>();
  const posts = new Map<string, (context: any) => Promise<void>>();
  let reads = 0;
  let purchases = 0;
  const modules: Record<string, unknown> = {
    '../game/app-channel.service': { appSessionQqUser: async () => 'player' },
    '../game/home.service': { homePurchaseSite: async () => ({ target: { id: 'baina_residence', x: 7, y: -166, z: 0 } }), homeOverview: async () => {
      reads++;
      return { owned: true, home: { id: 8, name: '我的小屋', level: 1, floorCount: 1,
        location: { regionId: 2, x: 4, y: 5, z: 0 }, inHome: false,
        floors: [{ number: 1, room: { columns: 12, rows: 10 }, furniture: [] }] } };
    } },
    './home-purchase.service': {
      previewHomePurchase: async () => { purchases++; return { token: 'quote' }; },
      confirmHomePurchase: async () => { purchases++; return { homeId: 9 }; }
    },
    './home-storage.service': {
      webHomeStorageCatalog: async () => ({ items: [] }),
      previewWebHomeStorageTransfer: async () => ({ token: 'storage-quote' }),
      confirmWebHomeStorageTransfer: async () => ({ quantity: 1 })
    }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  loaded.exports.registerHomeApiRoutes({
    get: (path: string, handler: (context: any) => Promise<void>) => { handlers.set(path, handler); },
    post: (path: string, handler: (context: any) => Promise<void>) => { posts.set(path, handler); }
  }, '/api/web/v1', {
    requireSession: async (context: any) => context.authenticated ? { playerId: 1 } : null,
    parseBody: async (context: any) => context.requestBody ?? {},
    apiError: (context: any, status: number, message: string) => { context.status = status; context.body = { ok: false, message }; }
  });
  const overview = handlers.get('/api/web/v1/home')!;
  const floor = handlers.get('/api/web/v1/home/floors/:number')!;
  const anonymous = { authenticated: false } as any;
  await overview(anonymous);
  assert.equal(reads, 0);
  const summary = { authenticated: true } as any;
  await overview(summary);
  assert.equal(summary.body.home.name, '我的小屋');
  assert.equal(reads, 1);
  const unopened = { authenticated: true, params: { number: '2' } } as any;
  await floor(unopened);
  assert.equal(unopened.status, 400);
  assert.match(unopened.body.message, /尚未扩建/);
  const open = { authenticated: true, params: { number: '1' } } as any;
  await floor(open);
  assert.equal(open.body.floor.number, 1);
  const anonymousPurchase = { authenticated: false } as any;
  await posts.get('/api/web/v1/home/purchase/preview')!(anonymousPurchase);
  assert.equal(purchases, 0);
  const site = { authenticated: true } as any;
  await handlers.get('/api/web/v1/home/purchase-site')!(site);
  assert.deepEqual([site.body.target.id, site.body.target.x, site.body.target.y], ['baina_residence', 7, -166]);
  const preview = { authenticated: true } as any;
  await posts.get('/api/web/v1/home/purchase/preview')!(preview);
  assert.equal(preview.body.token, 'quote');
  const confirm = { authenticated: true, requestBody: { token: 'quote', idempotencyKey: 'request' } } as any;
  await posts.get('/api/web/v1/home/purchase/confirm')!(confirm);
  assert.deepEqual(confirm.body.refresh, ['summary', 'inventory', 'map', 'home']);
  assert.equal(purchases, 2);
});
