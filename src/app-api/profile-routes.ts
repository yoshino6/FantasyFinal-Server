import type koaRouter from 'koa-router';
import type { AppSession } from '../game/app-channel.service';
import { AVATAR_REQUEST_LIMIT, AvatarInputError, readPlayerIdentityChanges, uploadPlayerAvatar } from './profile.service';

type Context = any;
type Dependencies = {
  requireSession: (ctx: Context) => Promise<AppSession | null>;
  parseBody: (ctx: Context, maxBytes?: number) => Promise<Record<string, unknown>>;
  apiError: (ctx: Context, status: number, message: string) => void;
};

export const registerProfileApiRoutes = (router: koaRouter, apiPrefix: string, { requireSession, parseBody, apiError }: Dependencies) => {
  router.get(`${apiPrefix}/profile/identity-changes`, async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const identity = await readPlayerIdentityChanges(session.playerId);
      if (!identity) { apiError(ctx, 400, '请先完成角色注册。'); return; }
      ctx.type = 'application/json';
      ctx.body = { ok: true, ...identity };
    } catch (error) {
      apiError(ctx, error instanceof AvatarInputError ? 400 : 503,
        error instanceof AvatarInputError ? error.message : '读取改名改性条件失败，请稍后重试。');
    }
  });

  router.post(`${apiPrefix}/profile/avatar`, async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    let body: Record<string, unknown>;
    try { body = await parseBody(ctx, AVATAR_REQUEST_LIMIT); }
    catch (error) { apiError(ctx, 400, error instanceof Error ? error.message : '请求格式无效。'); return; }
    try {
      const avatar = await uploadPlayerAvatar(session.playerId, body.imageData);
      ctx.type = 'application/json';
      ctx.body = { ok: true, ...avatar };
    } catch (error) {
      apiError(ctx, error instanceof AvatarInputError ? 400 : 503,
        error instanceof AvatarInputError ? error.message : '头像上传暂时不可用，请稍后重试。');
    }
  });
};
