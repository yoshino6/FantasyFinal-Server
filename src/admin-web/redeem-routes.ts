import type koaRouter from 'koa-router';
import type { WebSession } from '../game/admin-web.service';
import { createRedeemCampaign, editRedeemCampaign, exportRedeemCodes, generateRedeemCodes, getRedeemCampaign,
  listRedeemCampaigns, listRedeemClaims, listRedeemCodes, RedeemAdminError, setRedeemCampaignStatus, updateRedeemCode } from '../game/redeem-admin.service';

type Context = any;
type Dependencies = { auth: (ctx: Context, write?: boolean) => Promise<WebSession | null>;
  parseBody: (ctx: Context) => Promise<Record<string, unknown>>; apiError: (ctx: Context, status: number, message: string) => void };
export const registerRedeemAdminRoutes = (router: koaRouter, apiPrefix: string, { auth, parseBody, apiError }: Dependencies) => {
  const handle = async (ctx: Context, write: boolean, work: (actor: WebSession, body: Record<string, unknown>) => Promise<unknown>) => {
    const actor = await auth(ctx, write); if (!actor) return;
    let body = {};
    try { if (write) body = await parseBody(ctx); }
    catch { apiError(ctx, 400, '请求格式无效或内容过大。'); return; }
    try { ctx.set('Cache-Control', 'no-store'); ctx.type = 'application/json'; ctx.body = await work(actor, body); }
    catch (error) { apiError(ctx, error instanceof RedeemAdminError ? error.status : 503,
      error instanceof RedeemAdminError ? error.message : '兑换管理暂时不可用，请稍后重试。'); }
  };
  const path = (suffix: string) => `${apiPrefix}/redeem${suffix}`;
  router.get(path('/campaigns'), ctx => handle(ctx, false, actor => listRedeemCampaigns(actor, ctx.query ?? {})));
  router.post(path('/campaigns'), ctx => handle(ctx, true, (actor, body) => createRedeemCampaign(actor, body)));
  router.get(path('/campaigns/:id'), ctx => handle(ctx, false, actor => getRedeemCampaign(actor, ctx.params.id)));
  router.patch(path('/campaigns/:id'), ctx => handle(ctx, true, (actor, body) => editRedeemCampaign(actor, ctx.params.id, body)));
  router.post(path('/campaigns/:id/status'), ctx => handle(ctx, true, (actor, body) => setRedeemCampaignStatus(actor, ctx.params.id, body)));
  router.get(path('/campaigns/:id/codes'), ctx => handle(ctx, false, actor => listRedeemCodes(actor, ctx.params.id, ctx.query ?? {})));
  router.post(path('/campaigns/:id/codes'), ctx => handle(ctx, true, (actor, body) => generateRedeemCodes(actor, ctx.params.id, body)));
  router.post(path('/campaigns/:id/codes/export'), ctx => handle(ctx, true, (actor, body) => exportRedeemCodes(actor, ctx.params.id, body)));
  router.get(path('/campaigns/:id/claims'), ctx => handle(ctx, false, actor => listRedeemClaims(actor, ctx.params.id, ctx.query ?? {})));
  router.patch(path('/codes/:id'), ctx => handle(ctx, true, (actor, body) => updateRedeemCode(actor, ctx.params.id, body)));
  router.delete(path('/codes/:id'), ctx => handle(ctx, true, (actor, body) => updateRedeemCode(actor, ctx.params.id, body, true)));
};
