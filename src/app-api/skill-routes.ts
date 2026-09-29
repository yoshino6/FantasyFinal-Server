import type koaRouter from 'koa-router';
import type { AppSession } from '../game/app-channel.service';
import { appSessionQqUser } from '../game/app-channel.service';
import {
  APPRAISAL_DIRECTIONS, confirmSkillAction, previewSkillAction, SKILL_ACTIONS,
  SKILL_SPECIALIZATIONS, skillDetailView, skillPage, type SkillActionInput
} from './skill.service';

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
const errorResponse = (ctx: Context, error: unknown, apiError: Dependencies['apiError']) => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (/^(?:ER_|ECONN|PROTOCOL_)/.test(code)) {
    apiError(ctx, 503, '技能服务暂时不可用，请稍后重试。');
    ctx.body = { ...ctx.body, code: 'skill_unavailable' };
    return;
  }
  const message = error instanceof Error ? error.message : '技能服务暂时不可用。';
  const conflict = /已变化|已取消|已过期|过期|已失效/.test(message);
  apiError(ctx, conflict ? 409 : 400, message);
  ctx.body = { ...ctx.body, code: conflict ? 'stale_skill_quote' : 'skill_request_failed' };
};

/** H5 角色技能专用接口；QQ 仍沿用原有技能指令。 */
export const registerSkillApiRoutes = (router: koaRouter, apiPrefix: string, dependencies: Dependencies) => {
  const path = (suffix: string) => `${apiPrefix}${suffix}`;
  const { requireSession, parseBody, apiError } = dependencies;

  router.get(path('/skills'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const view = String(ctx.query.view ?? 'learned');
      if (view !== 'learned' && view !== 'available') throw new Error('不存在该技能列表。');
      const keyword = String(ctx.query.keyword ?? '').trim();
      if (keyword.length > 80) throw new Error('搜索词最多 80 个字符。');
      ctx.body = { ok: true, ...await skillPage(await appSessionQqUser(session), view,
        integer(ctx.query.page ?? 1, '页码', 10000), keyword), serverTime: new Date().toISOString() };
    } catch (error) { errorResponse(ctx, error, apiError); }
  });

  router.get(path('/skills/:id'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      ctx.body = { ok: true, ...await skillDetailView(await appSessionQqUser(session), integer(ctx.params.id, '技能编号')),
        serverTime: new Date().toISOString() };
    } catch (error) { errorResponse(ctx, error, apiError); }
  });

  router.post(path('/skills/actions/preview'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const body = await parseBody(ctx);
      const action = String(body.action ?? '');
      if (!SKILL_ACTIONS.includes(action as SkillActionInput['action'])) throw new Error('不支持该技能操作。');
      const skillId = integer(body.skillId, '技能编号');
      const specialization = body.specialization == null ? undefined : String(body.specialization);
      const direction = body.direction == null ? undefined : String(body.direction);
      if (action === 'specialization' && !SKILL_SPECIALIZATIONS.includes(specialization as typeof SKILL_SPECIALIZATIONS[number])) throw new Error('请选择有效的专精方向。');
      if (action === 'appraisal' && !APPRAISAL_DIRECTIONS.includes(direction as typeof APPRAISAL_DIRECTIONS[number])) throw new Error('请选择鉴识方向。');
      const input: SkillActionInput = { action: action as SkillActionInput['action'], skillId,
        ...(action === 'specialization' ? { specialization: specialization as typeof SKILL_SPECIALIZATIONS[number] } : {}),
        ...(action === 'appraisal' ? { direction: direction as typeof APPRAISAL_DIRECTIONS[number] } : {}) };
      ctx.body = { ok: true, ...await previewSkillAction(await appSessionQqUser(session), input), serverTime: new Date().toISOString() };
    } catch (error) { errorResponse(ctx, error, apiError); }
  });

  router.post(path('/skills/actions/confirm'), async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const body = await parseBody(ctx);
      const result = await confirmSkillAction(await appSessionQqUser(session), String(body.token ?? ''), String(body.idempotencyKey ?? ''));
      ctx.body = { ok: true, result, refresh: ['summary', 'skills', 'battle'], serverTime: new Date().toISOString() };
    } catch (error) { errorResponse(ctx, error, apiError); }
  });
};
