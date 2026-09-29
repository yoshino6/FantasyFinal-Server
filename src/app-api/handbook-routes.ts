import type koaRouter from 'koa-router';
import type { AppSession } from '../game/app-channel.service';
import {
  addHandbookWarrantReward,
  handbookAchievementDetail,
  handbookAchievementRewards,
  handbookAchievements,
  handbookCodex,
  handbookCodexDetail,
  handbookPursuitRecords,
  handbookWarrantDetail,
  handbookWarrantPosts,
  handbookWarrantRewardItems,
  handbookWarrants,
  openHandbookAchievementBox,
  previewHandbookWarrantReward
} from './handbook.service';

type Context = any;
type RegisterOptions = {
  apiPath: (path: string) => string;
  requireSession: (ctx: Context) => Promise<AppSession | null>;
  parseBody: (ctx: Context) => Promise<Record<string, unknown>>;
  apiError: (ctx: Context, status: number, message: string) => void;
};

export const registerHandbookRoutes = (router: koaRouter, { apiPath, requireSession, parseBody, apiError }: RegisterOptions) => {
  const get = (path: string, fallback: string, action: (session: AppSession, ctx: Context) => Promise<unknown>) => {
    router.get(apiPath(path), async (ctx: Context) => {
      const session = await requireSession(ctx);
      if (!session) return;
      try {
        ctx.type = 'application/json';
        ctx.body = { ok: true, data: await action(session, ctx) };
      } catch (error) {
        apiError(ctx, 400, error instanceof Error ? error.message : fallback);
      }
    });
  };
  const post = (path: string, fallback: string, action: (session: AppSession, ctx: Context, body: Record<string, unknown>) => Promise<unknown>) => {
    router.post(apiPath(path), async (ctx: Context) => {
      const session = await requireSession(ctx);
      if (!session) return;
      try {
        const body = await parseBody(ctx);
        ctx.type = 'application/json';
        ctx.body = { ok: true, data: await action(session, ctx, body) };
      } catch (error) {
        apiError(ctx, 400, error instanceof Error ? error.message : fallback);
      }
    });
  };

  get('/handbook/achievements', '读取足迹失败。', (session, ctx) => handbookAchievements(session, ctx.query));
  get('/handbook/achievements/rewards', '读取足迹奖励失败。', session => handbookAchievementRewards(session));
  post('/handbook/achievements/rewards/:boxKey/open', '打开道具匣失败。',
    (session, ctx, body) => openHandbookAchievementBox(session, ctx.params.boxKey, body));
  get('/handbook/achievements/:id', '读取成就详情失败。', (session, ctx) => handbookAchievementDetail(session, ctx.params.id));

  get('/handbook/codex', '读取图鉴失败。', (session, ctx) => handbookCodex(session, ctx.query));
  get('/handbook/codex/:kind/:id', '读取图鉴详情失败。',
    (session, ctx) => handbookCodexDetail(session, ctx.params.kind, ctx.params.id));

  get('/handbook/warrants', '读取通缉榜失败。', (session, ctx) => handbookWarrants(session, ctx.query));
  get('/handbook/warrants/posts', '读取我的上赏失败。', (session, ctx) => handbookWarrantPosts(session, ctx.query?.page));
  get('/handbook/warrants/pursuits', '读取追缉记录失败。', (session, ctx) => handbookPursuitRecords(session, ctx.query?.page));
  get('/handbook/warrants/reward-items', '读取可上赏物品失败。', (session, ctx) => handbookWarrantRewardItems(session, ctx.query?.page));
  post('/handbook/warrants/:id/reward-preview', '上赏预览失败。',
    (session, ctx, body) => previewHandbookWarrantReward(session, ctx.params.id, body));
  post('/handbook/warrants/:id/rewards', '追加赏金失败。',
    (session, ctx, body) => addHandbookWarrantReward(session, ctx.params.id, body));
  get('/handbook/warrants/:id', '读取通缉详情失败。',
    (session, ctx) => handbookWarrantDetail(session, ctx.params.id));
};
