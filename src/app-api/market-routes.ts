import type koaRouter from 'koa-router';
import type { AppSession } from '../game/app-channel.service';
import { appSessionQqUser } from '../game/app-channel.service';
import { getPool } from '../database/pool';
import { MARKET_SORTS, MARKET_TYPES, marketCatalog, marketItemDetail, marketMyListings, marketOrderPage, marketSellable, marketTradables, marketTradePage } from '../game/market.service';
import {
  confirmRemoteMarketCancel, confirmRemoteMarketOrder, previewRemoteMarketCancel,
  previewRemoteMarketOrder, remoteMarketAccessStatus, requireRemoteMarketAccess
} from './market.service';

type Context = any;
type Dependencies = {
  requireSession: (ctx: Context) => Promise<AppSession | null>;
  parseBody: (ctx: Context) => Promise<Record<string, unknown>>;
  apiError: (ctx: Context, status: number, message: string) => void;
};

const integer = (value: unknown, label: string, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${label}必须是 1 至 ${max} 之间的整数。`);
  return parsed;
};
const keyword = (value: unknown) => {
  const parsed = String(value ?? '').trim();
  if (parsed.length > 80) throw new Error('搜索词最多 80 个字符。');
  return parsed;
};
const failure = (ctx: Context, error: unknown, apiError: Dependencies['apiError']) => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (/^(?:ER_|ECONN|PROTOCOL_)/.test(code)) {
    apiError(ctx, 503, '联市暂时不可用，请稍后重试。');
    ctx.body = { ...ctx.body, code: 'market_unavailable' };
    return;
  }
  const message = error instanceof Error ? error.message : '联市暂时不可用。';
  const conflict = /已变化|已取消|已过期|过期|已完成|已经失效/.test(message);
  apiError(ctx, conflict ? 409 : 400, message);
  ctx.body = { ...ctx.body, code: conflict ? 'stale_market_quote' : 'market_request_failed' };
};

/** 只注册到 /api/web/v1；QQ 命令仍由原 response/market.ts 处理。 */
export const registerMarketApiRoutes = (router: koaRouter, apiPrefix: string, dependencies: Dependencies) => {
  const path = (suffix: string) => `${apiPrefix}${suffix}`;
  const { requireSession, parseBody, apiError } = dependencies;

  router.get(path('/market/access'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const access = await remoteMarketAccessStatus(await appSessionQqUser(session));
      ctx.body = { ok: true, ...access, types: MARKET_TYPES, sorts: MARKET_SORTS, serverTime: new Date().toISOString() };
    } catch (error) { failure(ctx, error, apiError); }
  });

  router.get(path('/market/catalog'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const user = await appSessionQqUser(session);
      await requireRemoteMarketAccess(await getPool(), user);
      const page = integer(ctx.query.page ?? 1, '页码', 100000);
      const type = String(ctx.query.type ?? '全部');
      if (!MARKET_TYPES.includes(type as typeof MARKET_TYPES[number])) throw new Error('不存在该物品分类。');
      const sort = String(ctx.query.sort ?? 'price_asc');
      if (!MARKET_SORTS.includes(sort as typeof MARKET_SORTS[number])) throw new Error('不存在该排序方式。');
      const catalog = await marketCatalog(user, page, type, keyword(ctx.query.keyword), sort);
      ctx.body = { ok: true, ...catalog, serverTime: new Date().toISOString() };
    } catch (error) { failure(ctx, error, apiError); }
  });

  router.get(path('/market/tradables'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const user = await appSessionQqUser(session);
      await requireRemoteMarketAccess(await getPool(), user);
      const page = integer(ctx.query.page ?? 1, '页码', 100000);
      const type = String(ctx.query.type ?? '全部');
      if (!MARKET_TYPES.includes(type as typeof MARKET_TYPES[number])) throw new Error('不存在该物品分类。');
      ctx.body = { ok: true, ...await marketTradables(user, page, type, keyword(ctx.query.keyword)), serverTime: new Date().toISOString() };
    } catch (error) { failure(ctx, error, apiError); }
  });

  router.get(path('/market/items/:id'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const user = await appSessionQqUser(session);
      await requireRemoteMarketAccess(await getPool(), user);
      const item = await marketItemDetail(user, integer(ctx.params.id, '物品编号'));
      ctx.body = { ok: true, item, serverTime: new Date().toISOString() };
    } catch (error) { failure(ctx, error, apiError); }
  });

  router.get(path('/market/sellable'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const user = await appSessionQqUser(session);
      await requireRemoteMarketAccess(await getPool(), user);
      const sellable = await marketSellable(user, integer(ctx.query.page ?? 1, '页码', 100000), keyword(ctx.query.keyword));
      ctx.body = { ok: true, ...sellable, serverTime: new Date().toISOString() };
    } catch (error) { failure(ctx, error, apiError); }
  });

  router.get(path('/market/listings'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const user = await appSessionQqUser(session);
      await requireRemoteMarketAccess(await getPool(), user);
      ctx.body = { ok: true, listings: await marketMyListings(user), serverTime: new Date().toISOString() };
    } catch (error) { failure(ctx, error, apiError); }
  });

  router.get(path('/market/orders'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const user = await appSessionQqUser(session);
      await requireRemoteMarketAccess(await getPool(), user);
      ctx.body = { ok: true, ...await marketOrderPage(user, integer(ctx.query.page ?? 1, '页码', 100000)), serverTime: new Date().toISOString() };
    } catch (error) { failure(ctx, error, apiError); }
  });

  router.get(path('/market/trades'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const user = await appSessionQqUser(session);
      await requireRemoteMarketAccess(await getPool(), user);
      ctx.body = { ok: true, ...await marketTradePage(user, integer(ctx.query.page ?? 1, '页码', 100000)), serverTime: new Date().toISOString() };
    } catch (error) { failure(ctx, error, apiError); }
  });

  router.post(path('/market/orders/preview'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const body = await parseBody(ctx);
      const side = body.side;
      if (side !== 'sell' && side !== 'buy') throw new Error('请选择寄售或求购。');
      const preview = await previewRemoteMarketOrder(await appSessionQqUser(session), side,
        integer(body.itemId, '物品编号'), integer(body.price, '单价', 99999999), integer(body.quantity, '数量', 999));
      ctx.body = { ok: true, ...preview, serverTime: new Date().toISOString() };
    } catch (error) { failure(ctx, error, apiError); }
  });

  router.post(path('/market/orders/confirm'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const body = await parseBody(ctx);
      const result = await confirmRemoteMarketOrder(await appSessionQqUser(session), String(body.token ?? ''), String(body.idempotencyKey ?? ''));
      ctx.body = { ok: true, result, refresh: ['summary', 'inventory', 'market'], serverTime: new Date().toISOString() };
    } catch (error) { failure(ctx, error, apiError); }
  });

  router.post(path('/market/orders/:id/cancel/preview'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const preview = await previewRemoteMarketCancel(await appSessionQqUser(session), integer(ctx.params.id, '订单编号'));
      ctx.body = { ok: true, ...preview, serverTime: new Date().toISOString() };
    } catch (error) { failure(ctx, error, apiError); }
  });

  router.post(path('/market/orders/:id/cancel/confirm'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const body = await parseBody(ctx);
      const result = await confirmRemoteMarketCancel(await appSessionQqUser(session), integer(ctx.params.id, '订单编号'), String(body.token ?? ''), String(body.idempotencyKey ?? ''));
      ctx.body = { ok: true, result, refresh: ['summary', 'inventory', 'market'], serverTime: new Date().toISOString() };
    } catch (error) { failure(ctx, error, apiError); }
  });
};
