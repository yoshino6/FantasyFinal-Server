import type koaRouter from 'koa-router';
import type { AppSession } from '../game/app-channel.service';
import { RedeemCodeError, redeemWebCode } from './redeem-code.service';

type Context = any;
type Dependencies = {
  requireSession: (ctx: Context) => Promise<AppSession | null>;
  parseBody: (ctx: Context) => Promise<Record<string, unknown>>;
  apiError: (ctx: Context, status: number, message: string) => void;
};

export const createRedeemAttemptLimiter = (now: () => number = Date.now) => {
  const attempts = new Map<number, { expiresAt: number; count: number }>();
  return (playerId: number) => {
    const time = now(); let entry = attempts.get(playerId);
    if (!entry || entry.expiresAt <= time) { entry = { expiresAt: time + 60_000, count: 0 }; attempts.delete(playerId); attempts.set(playerId, entry); }
    if (attempts.size > 10_000) attempts.delete(attempts.keys().next().value!);
    if (entry.count >= 10) return false;
    entry.count++; return true;
  };
};
const allowAttempt = createRedeemAttemptLimiter();

export const registerRedeemCodeRoutes = (router: koaRouter, apiPrefix: string, { requireSession, parseBody, apiError }: Dependencies) => {
  router.post(`${apiPrefix}/redeem-code`, async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    if (!allowAttempt(session.playerId)) { apiError(ctx, 429, '兑换尝试过于频繁，请一分钟后重试。'); return; }
    let body: Record<string, unknown>;
    try { body = await parseBody(ctx); }
    catch (error) { apiError(ctx, 400, error instanceof Error ? error.message : '请求格式无效。'); return; }
    try {
      const result = await redeemWebCode(session.playerId, body.code);
      ctx.type = 'application/json';
      ctx.body = { ok: true, ...result };
    } catch (error) {
      apiError(ctx, error instanceof RedeemCodeError ? 400 : 503,
        error instanceof RedeemCodeError ? error.message : '兑换暂时不可用，请稍后重试。');
    }
  });
};
