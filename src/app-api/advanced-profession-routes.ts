import type koaRouter from 'koa-router';
import type { AppSession } from '../game/app-channel.service';
import { appSessionQqUser } from '../game/app-channel.service';
import { appQuickPanel } from './app-command.service';
import { advancedProfessionDetail, advancedProfessionStatus, confirmAdvancedProfessionAction,
  previewAdvancedProfessionAction, type AdvancedQuestAction } from './advanced-profession.service';
import { startWebAdvancedProfessionTrial } from './advanced-profession-trial.service';

type Context = any;
type Dependencies = {
  requireSession: (ctx: Context) => Promise<AppSession | null>;
  parseBody: (ctx: Context) => Promise<Record<string, unknown>>;
  apiError: (ctx: Context, status: number, message: string) => void;
};
const professionCode = (value: unknown) => {
  const code = String(value ?? '');
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(code)) throw new Error('二转职业编号无效。');
  return code;
};
const actionName = (value: unknown): AdvancedQuestAction => {
  if (value === 'accept' || value === 'switch_quest' || value === 'submit_story' || value === 'submit_proof') return value;
  throw new Error('二转操作无效。');
};
const failure = (ctx: Context, error: unknown, apiError: Dependencies['apiError']) => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (/^(?:ER_|ECONN|PROTOCOL_)/.test(code)) {
    apiError(ctx, 503, '二转试炼暂时不可用，请稍后重试。');
    ctx.body = { ...ctx.body, code: 'advanced_profession_unavailable' };
    return;
  }
  const message = error instanceof Error ? error.message : '二转试炼暂时不可用。';
  const conflict = /已变化|已失效|已过期|过期|已取消|已完成/.test(message);
  apiError(ctx, conflict ? 409 : 400, message);
  ctx.body = { ...ctx.body, code: conflict ? 'stale_advanced_profession_quote' : 'advanced_profession_request_failed' };
};

export const registerAdvancedProfessionApiRoutes = (router: koaRouter, apiPrefix: string, dependencies: Dependencies) => {
  const path = (suffix: string) => `${apiPrefix}/advanced-professions${suffix}`;
  const { requireSession, parseBody, apiError } = dependencies;
  router.get(path(''), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try { ctx.body = { ok: true, ...await advancedProfessionStatus(await appSessionQqUser(session)), serverTime: new Date().toISOString() }; }
    catch (error) { failure(ctx, error, apiError); }
  });
  router.get(path('/:code'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try { ctx.body = { ok: true, ...await advancedProfessionDetail(await appSessionQqUser(session), professionCode(ctx.params.code)), serverTime: new Date().toISOString() }; }
    catch (error) { failure(ctx, error, apiError); }
  });
  router.post(path('/:code/preview'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const body = await parseBody(ctx);
      ctx.body = { ok: true, ...await previewAdvancedProfessionAction(await appSessionQqUser(session),
        professionCode(ctx.params.code), actionName(body.action)), serverTime: new Date().toISOString() };
    } catch (error) { failure(ctx, error, apiError); }
  });
  router.post(path('/:code/trial/start'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const body = await parseBody(ctx);
      const result = await startWebAdvancedProfessionTrial(await appSessionQqUser(session),
        professionCode(ctx.params.code), String(body.idempotencyKey ?? ''));
      // 战斗已经提交，面板回读失败仍返回成功；客户端可用同一 key 重试或 GET /panel。
      const current = await appQuickPanel(session).catch(() => null);
      const panel = current?.battle?.sessionId === result.sessionId ? current : null;
      ctx.body = { ok: true, ...result, panel, serverTime: new Date().toISOString() };
    } catch (error) { failure(ctx, error, apiError); }
  });
  router.post(path('/confirm'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const body = await parseBody(ctx);
      const result = await confirmAdvancedProfessionAction(await appSessionQqUser(session),
        String(body.token ?? ''), String(body.idempotencyKey ?? ''));
      ctx.body = { ok: true, result, refresh: ['advanced-professions', 'character', 'inventory', 'map'], serverTime: new Date().toISOString() };
    } catch (error) { failure(ctx, error, apiError); }
  });
};
