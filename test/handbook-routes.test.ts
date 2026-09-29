import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHandbookRoutes } from '../src/app-api/handbook-routes';
import { handbookAchievements, handbookCodex, handbookWarrants, previewHandbookWarrantReward } from '../src/app-api/handbook.service';
import type { AppSession } from '../src/game/app-channel.service';
import { consumeBinding } from '../src/game/inventory-binding';

const session = { playerId: 1, characterId: 1 } as AppSession;

test('手册路由只通过会话门禁，并优先匹配静态子资源', async () => {
  const routes: Array<{ method: string; path: string; handler: (ctx: any) => Promise<void> }> = [];
  const router = {
    get: (path: string, handler: (ctx: any) => Promise<void>) => { routes.push({ method: 'GET', path, handler }); },
    post: (path: string, handler: (ctx: any) => Promise<void>) => { routes.push({ method: 'POST', path, handler }); }
  };
  registerHandbookRoutes(router as any, {
    apiPath: path => `/api/web/v1${path}`,
    requireSession: async ctx => { ctx.status = 401; return null; },
    parseBody: async () => { throw new Error('未授权请求不应解析请求体'); },
    apiError: () => { throw new Error('未授权请求不应执行资源处理'); }
  });
  const paths = routes.map(route => route.path);
  assert.ok(paths.indexOf('/api/web/v1/handbook/achievements/rewards') < paths.indexOf('/api/web/v1/handbook/achievements/:id'));
  assert.ok(paths.indexOf('/api/web/v1/handbook/warrants/posts') < paths.indexOf('/api/web/v1/handbook/warrants/:id'));
  assert.ok(paths.indexOf('/api/web/v1/handbook/warrants/pursuits') < paths.indexOf('/api/web/v1/handbook/warrants/:id'));
  assert.ok(paths.indexOf('/api/web/v1/handbook/warrants/reward-items') < paths.indexOf('/api/web/v1/handbook/warrants/:id'));
  assert.equal(new Set(routes.map(route => `${route.method} ${route.path}`)).size, routes.length);
  for (const route of routes) {
    const ctx: any = { query: {}, params: {} };
    await route.handler(ctx);
    assert.equal(ctx.status, 401);
    assert.equal(ctx.body, undefined);
  }
});

test('无效筛选和上赏内容在访问数据库前被拒绝', async () => {
  await assert.rejects(handbookAchievements(session, { category: '不存在' }), /未知成就分类/);
  await assert.rejects(handbookCodex(session, { kind: '未知' }), /未知图鉴分类/);
  await assert.rejects(handbookWarrants(session, { filter: '附近所有人' }), /通缉筛选无效/);
  await assert.rejects(previewHandbookWarrantReward(session, 1, { kind: 'copper', amount: 0 }), /铜币数量无效/);
  await assert.rejects(previewHandbookWarrantReward(session, 1, { kind: 'item', itemId: 1, quantity: -1 }), /物品数量无效/);
});

test('物品上赏使用的未绑定扣除规则不会动用绑定库存', () => {
  const stock = { unbound: 2, trade: 3, personal: 4 };
  assert.deepEqual(consumeBinding(stock, 2, true), { unbound: 2, trade: 0, personal: 0 });
  assert.throws(() => consumeBinding(stock, 3, true), /未绑定数量不足/);
});
