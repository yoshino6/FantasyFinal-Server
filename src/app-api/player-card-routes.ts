import type koaRouter from 'koa-router';
import type { AppSession } from '../game/app-channel.service';
import {
  PlayerCardError, acceptPlayerFriendRequest, invitePlayerToParty, listPlayerPartyInvitations, readPublicPlayerCard,
  requestPlayerFriend, requirePublicPlayerId, respondPlayerPartyInvitation
} from './player-card.service';

type Context = any;
type Dependencies = {
  requireSession: (ctx: Context) => Promise<AppSession | null>;
  parseBody: (ctx: Context) => Promise<Record<string, unknown>>;
  apiError: (ctx: Context, status: number, message: string) => void;
};

export const registerPlayerCardApiRoutes = (router: koaRouter, apiPrefix: string, { requireSession, parseBody, apiError }: Dependencies) => {
  const run = (work: (session: AppSession, ctx: Context) => Promise<Record<string, unknown>>, readOnly = false) => async (ctx: Context) => {
    const session = await requireSession(ctx); if (!session) return;
    try {
      const result = await work(session, ctx);
      ctx.type = 'application/json'; ctx.body = { ok: true, ...result };
    } catch (error) {
      apiError(ctx, error instanceof PlayerCardError ? error.status : readOnly ? 503 : 400,
        error instanceof PlayerCardError ? error.message : readOnly ? '读取玩家资料失败，请稍后重试。' : safeActionError(error));
    }
  };
  router.get(`${apiPrefix}/social/players/:gameId`, run((session, ctx) => readPublicPlayerCard(session, ctx.params.gameId), true));
  router.post(`${apiPrefix}/social/players/:gameId/friend-request`, run((session, ctx) => requestPlayerFriend(session, ctx.params.gameId)));
  router.post(`${apiPrefix}/social/friend-requests/:requestId/accept`, run((session, ctx) => acceptPlayerFriendRequest(session, ctx.params.requestId)));
  router.post(`${apiPrefix}/social/players/:gameId/party-invitation`, run((session, ctx) => invitePlayerToParty(session, ctx.params.gameId)));
  router.get(`${apiPrefix}/social/party-invitations`, run(async session => ({ items: await listPlayerPartyInvitations(session) }), true));
  router.post(`${apiPrefix}/social/party-invitations/:invitationId/respond`, run(async (session, ctx) => {
    const invitationId = requirePublicPlayerId(ctx.params.invitationId);
    const body = await parseBody(ctx);
    return respondPlayerPartyInvitation(session, invitationId, body.action);
  }));
};

// Existing game services use Chinese Error messages for business failures; hide infrastructure details.
const safeActionError = (error: unknown) => error instanceof Error && /[\u3400-\u9fff]/.test(error.message) && error.message.length <= 160
  && !/SQL|SELECT|INSERT|UPDATE|DELETE|ECONN|ER_/i.test(error.message) ? error.message : '操作失败，请稍后重试。';
