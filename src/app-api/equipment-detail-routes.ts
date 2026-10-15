import type koaRouter from 'koa-router';
import type { AppSession } from '../game/app-channel.service';
import { appSessionQqUser } from '../game/app-channel.service';
import { readEquippedDetail } from './equipment-detail.service';

type Context = any;
type Dependencies = {
  requireSession: (ctx: Context) => Promise<AppSession | null>;
  apiError: (ctx: Context, status: number, message: string) => void;
};
export const registerEquipmentDetailApiRoutes = (router: koaRouter, apiPrefix: string, { requireSession, apiError }: Dependencies) => {
  router.get(`${apiPrefix}/equipment/:slot/detail`, async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      ctx.type = 'application/json';
      ctx.body = { ok: true, ...await readEquippedDetail(await appSessionQqUser(session), ctx.params.slot) };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      apiError(ctx, /^(ER_|ECONN|PROTOCOL_)/.test(code) ? 503 : 400, error instanceof Error ? error.message : '读取装备详情失败。');
    }
  });
};
