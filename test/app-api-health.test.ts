import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

// Use the same real-router/dependency-boundary harness as building-core-window-routes.
// An optional compiled artifact lets the offline release check run the same route.
const routerPath = process.env.FF_HEALTH_ROUTER_STAGE ?? fileURLToPath(new URL('../src/app-api/router.ts', import.meta.url));
const compiled = transformSync(readFileSync(routerPath, 'utf8'), { loader: routerPath.endsWith('.ts') ? 'ts' : 'js', format: 'cjs', target: 'es2022' }).code;
const registrars: Record<string, string> = {
  './handbook-routes': 'registerHandbookRoutes',
  './bank-routes': 'registerBankApiRoutes', './home-routes': 'registerHomeApiRoutes',
  './guild-shop-routes': 'registerGuildShopApiRoutes', './bookshop-routes': 'registerBookshopApiRoutes',
  './home-shop-routes': 'registerHomeShopApiRoutes', './evolution-routes': 'registerEvolutionApiRoutes',
  './advanced-profession-routes': 'registerAdvancedProfessionApiRoutes', './market-routes': 'registerMarketApiRoutes',
  './skill-routes': 'registerSkillApiRoutes', './equipment-detail-routes': 'registerEquipmentDetailApiRoutes',
};

for (const prefix of ['/app-api/v1', '/api/desktop/v1', '/api/web/v1']) {
  test(`${prefix}/health exposes exploration protocols without accounts or game I/O`, async () => {
    const calls: string[] = [], loaded = { exports: {} as Record<string, any> };
    new Function('require', 'module', 'exports', compiled)((name: string) => {
      const normalized = name.replace(/\.js$/, ''), registrar = registrars[normalized];
      if (registrar) return { [registrar]: () => {} };
      return new Proxy({}, { get: (_target, property) => {
        calls.push(`${name}.${String(property)}`);
        assert.fail(`Health must not access game/config/session dependencies: ${calls.at(-1)}`);
      } });
    }, loaded, loaded.exports);
    const routes = new Map<string, (context: any) => Promise<void>>();
    const router = Object.fromEntries(['get', 'post', 'delete', 'put', 'patch'].map(method => [method, (path: string, handler: any) => routes.set(`${method} ${path}`, handler)]));
    loaded.exports.registerAppApiRoutes(router, prefix);
    const handler = routes.get(`get ${prefix}/health`);
    assert.ok(handler, 'the production router registers the public health path');
    const context: any = {};
    for (const key of ['req', 'get', 'session', 'request']) Object.defineProperty(context, key, { get: () => assert.fail(`Health must not read ${key}`) });
    await handler(context);
    assert.equal(context.type, 'application/json');
    assert.equal(context.body.ok, true);
    assert.equal(context.body.service, 'fantasy-final-game-core');
    assert.deepEqual(context.body.protocols, { explorationEnvironment: 1, explorationSurface: 1 });
    assert.deepEqual(context.body.environmentGenerators, [1, 2]);
    assert.equal(new Date(context.body.time).toISOString(), context.body.time);
    assert.deepEqual(calls, []);
    assert.deepEqual(Object.keys(context.body).sort(), ['environmentGenerators', 'ok', 'protocols', 'service', 'time']);
  });
}
