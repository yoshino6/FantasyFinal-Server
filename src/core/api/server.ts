import type { Server } from 'node:http';
import Koa, { type Context } from 'koa';
import koaRouter from 'koa-router';
import { logger } from 'alemonjs';
import { getPool } from '../../database/pool';
import { executeAppCommand } from '../../app-api/app-command.service';
import { getCoreApiConfig } from '../../config/core-api';
import { parseCoreCommandRequest, type CoreCommandResponse, type CoreMessage } from '../../contracts/core-api';
import { acknowledgeNotification, claimNotifications, enqueueNotification, ensureNotificationOutbox, notificationOutboxHealth } from '../notification/outbox.service';
import { rememberGroupChannel } from '../../game/group-channel.service';
import { reservePassiveWarrantNotice, takePvpDefeatNotice, townPassiveWantedAlert } from '../../game/pvp.service';
import { messageFormat } from '../../game/message';
import { warrantNoticeFormat } from '../../response/warrant-notice';
import { formatToAppMessage, formatValueToAppMessage, formatValueToMarkdown } from '../../app-api/app-format';
import { executeCoreGameCommand } from '../../core-command-bridge';

type CoreApiGlobal = typeof globalThis & { __fantasyFinalCoreApiServer?: Server };
type CachedResult = { expiresAt: number; response: CoreCommandResponse };
const idempotency = new Map<string, CachedResult>();
const TTL = 10 * 60_000;
const cleanCache = () => { const now = Date.now(); for (const [key, item] of idempotency) if (item.expiresAt <= now) idempotency.delete(key); if (idempotency.size > 10_000) idempotency.delete(idempotency.keys().next().value as string); };
const bearer = (ctx: Context) => { const value = String(ctx.get('authorization') ?? ''); return value.startsWith('Bearer ') ? value.slice(7).trim() : ''; };
const jsonBody = async (ctx: Context, maxBytes: number): Promise<unknown> => {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of ctx.req) { const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += part.length; if (size > maxBytes) throw Object.assign(new Error('请求体过大'), { status: 413 }); chunks.push(part); }
  if (!chunks.length) throw Object.assign(new Error('缺少 JSON 请求体'), { status: 400 });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('JSON 请求体无效'), { status: 400 }); }
};
const toCoreMessages = (result: any): CoreMessage[] => {
  const text = String(result?.text ?? '');
  const buttons = Array.isArray(result?.buttons)
    ? result.buttons.map((button: any) => ({ label: String(button.label), command: String(button.command), execution: 'manual' as const }))
    : [];
  const format = Array.isArray(result?.format) ? result.format : undefined;
  const markdown = typeof result?.markdown === 'string'
    ? result.markdown
    : format
      ? formatValueToMarkdown(format)
      : text || (buttons.length ? '请选择一个操作：' : '');
  return [{
    kind: format || markdown ? 'markdown' : 'text',
    text,
    ...(markdown ? { markdown } : {}),
    ...(format ? { format } : {}),
    ...(buttons.length ? { buttons } : {})
  }];
};
const toCapturedCoreMessages = (formats: unknown[][]): CoreMessage[] => formats.map(formatValue => {
  const message = formatValueToAppMessage(formatValue);
  return {
    kind: 'markdown' as const,
    text: message.text,
    ...(message.markdown ? { markdown: message.markdown } : {}),
    ...(message.format ? { format: message.format } : {}),
    ...(message.buttons.length ? { buttons: message.buttons.map(button => ({ ...button, execution: 'manual' as const })) } : {})
  };
});
const errorResponse = (requestId: string, code: string, message: string, retryable = false): CoreCommandResponse => ({ ok: false, requestId, messages: [], retryable, error: { code, message } });
const ready = async () => { const pool = await getPool(); await pool.query('SELECT 1'); await ensureNotificationOutbox(pool); return true; };
const notificationMessage = (format: any) => {
  const message = formatToAppMessage(format);
  return {
    kind: 'markdown' as const,
    text: message.text,
    ...(message.markdown ? { markdown: message.markdown } : {}),
    ...(message.format ? { format: message.format } : {}),
    buttons: message.buttons.map(button => ({ ...button, execution: 'manual' as const }))
  };
};

/**
 * 旧 QQ 中间件会在业务命令前处理的两类被动通知，现在由 Core 领取并写入
 * outbox；Gateway 只负责发送，避免通知链绕过跨进程边界。
 */
const enqueueQqCommandNotices = async (request: ReturnType<typeof parseCoreCommandRequest>) => {
  if (request.actor.provider !== 'qq' || !request.conversation?.botId) return;
  const { actor, conversation } = request;
  const scope = conversation.scope;
  try {
    const notice = await takePvpDefeatNotice(actor.subject);
    if (notice) {
      const defeatedAt = new Date(notice.defeatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
      await enqueueNotification({
        dedupeKey: `pvp-defeat:${actor.subject}:${new Date(notice.defeatedAt).toISOString()}`,
        provider: 'qq', botId: conversation.botId, scope, targetId: conversation.id,
        actorId: actor.subject,
        messages: [notificationMessage(messageFormat('战败通知', `${notice.notice}\n受击时间：${defeatedAt}\n\n战败保护将在你的下一次大型操作结束后解除，最长持续 1 小时。`))]
      });
    }
  } catch (error) {
    logger.warn({ err: error, actorId: actor.subject }, '战败通知进入 Core outbox 失败');
  }
  if (scope !== 'group') return;
  try {
    const wanted = await townPassiveWantedAlert(actor.subject);
    if (wanted && await reservePassiveWarrantNotice(wanted.warrantId, conversation.id, actor.subject)) {
      await enqueueNotification({
        dedupeKey: `warrant-passive:${wanted.warrantId}:${conversation.id}:${actor.subject}:${Math.floor(Date.now() / 60_000)}`,
        provider: 'qq', botId: conversation.botId, scope: 'group', targetId: conversation.id, actorId: actor.subject,
        messages: [notificationMessage(warrantNoticeFormat(wanted, { passive: true }))]
      });
    }
  } catch (error) {
    logger.warn({ err: error, groupId: conversation.id, actorId: actor.subject }, '被动通缉提示进入 Core outbox 失败');
  }
};

export const startCoreApiServer = async () => {
  const config = getCoreApiConfig(); if (!config.enabled) return;
  const state = globalThis as CoreApiGlobal; if (state.__fantasyFinalCoreApiServer?.listening) return;
  const app = new Koa(); app.proxy = false;
  app.use(async (ctx, next) => { try { await next(); } catch (error) { const status = Number((error as any)?.status) || 500; ctx.status = status; ctx.type = 'application/json'; ctx.body = { ok: false, error: status === 500 ? 'CORE_INTERNAL_ERROR' : String((error as Error).message) }; if (status >= 500) logger.error({ err: error }, 'Core API 请求失败'); } });
  const router = new koaRouter();
  const requireService = (ctx: Context) => {
    if (config.serviceToken && bearer(ctx) === config.serviceToken) return true;
    ctx.status = 401;
    ctx.type = 'application/json';
    ctx.body = errorResponse(String(ctx.get('x-request-id') || ''), 'AUTH_REQUIRED', 'Core service token 无效。');
    return false;
  };
  const registerHealthRoutes = (healthPath: string, readyPath: string) => {
    router.get(healthPath, ctx => { ctx.type = 'application/json'; ctx.body = { ok: true, service: 'fantasyfinal-core', time: new Date().toISOString() }; });
    router.get(readyPath, async ctx => { try { await ready(); ctx.type = 'application/json'; ctx.body = { ok: true, database: 'ready' }; } catch (error) { ctx.status = 503; ctx.type = 'application/json'; ctx.body = { ok: false, database: 'unavailable' }; logger.warn({ err: error }, 'Core 尚未就绪'); } });
  };
  const registerCoreRoutes = (prefix: string, healthPath?: string, readyPath?: string) => {
    const path = (suffix: string) => `${prefix}${suffix}`;
    if (healthPath && readyPath) {
      registerHealthRoutes(path(healthPath), path(readyPath));
    }
    router.post(path('/commands'), async ctx => {
      if (!requireService(ctx)) return;
      let body: ReturnType<typeof parseCoreCommandRequest>;
      try { body = parseCoreCommandRequest(await jsonBody(ctx, config.maxBodyBytes)); }
      catch (error) { ctx.status = 400; ctx.type = 'application/json'; ctx.body = errorResponse('', 'REQUEST_INVALID', error instanceof Error ? error.message : '请求无效。'); return; }
      const headerId = String(ctx.get('x-request-id') || '').trim();
      if (body.actor.provider !== 'qq') { ctx.status = 400; ctx.type = 'application/json'; ctx.body = errorResponse(body.requestId, 'ACTOR_PROVIDER_INVALID', '该接口只接受 QQ Gateway 身份。'); return; }
      if (headerId && headerId !== body.requestId) { ctx.status = 400; ctx.body = errorResponse(body.requestId, 'REQUEST_ID_MISMATCH', '请求 ID 不一致。'); return; }
      cleanCache(); const cacheKey = `${body.actor.provider}:${body.actor.subject}:${body.requestId}`; const cached = idempotency.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) { ctx.type = 'application/json'; ctx.body = cached.response; return; }
      let response: CoreCommandResponse;
      try {
        await enqueueQqCommandNotices(body);
        const legacy = await executeCoreGameCommand(body);
        // 已注册命令完全复用原版 response handler；只有未注册的桌宠兼容命令才走旧的 App facade。
        const messages = legacy.matched
          ? toCapturedCoreMessages(legacy.formats)
          : toCoreMessages(await executeAppCommand({ qqUserId: body.actor.subject, command: body.command }));
        response = { ok: true, requestId: body.requestId, messages, stateVersion: new Date().toISOString() };
      }
      catch (error) { response = errorResponse(body.requestId, 'COMMAND_INVALID', error instanceof Error ? error.message : '命令执行失败。'); }
      idempotency.set(cacheKey, { expiresAt: Date.now() + TTL, response }); ctx.type = 'application/json'; ctx.body = response;
    });
    router.post(path('/conversations/heartbeat'), async ctx => {
      if (!requireService(ctx)) return;
      const body = await jsonBody(ctx, config.maxBodyBytes) as Record<string, unknown>;
      const scope = String(body.scope ?? '');
      const id = String(body.id ?? '').trim();
      const botId = String(body.botId ?? '').trim();
      if (scope !== 'group' || !id || !botId) { ctx.status = 400; ctx.body = errorResponse('', 'CONVERSATION_INVALID', '群会话信息无效。'); return; }
      await rememberGroupChannel(id, botId);
      ctx.type = 'application/json'; ctx.body = { ok: true };
    });
    router.post(path('/notifications/claim'), async ctx => {
      if (!requireService(ctx)) return;
      const rawLimit = Number(ctx.query.limit ?? 20);
      const notifications = await claimNotifications('qq-gateway', Number.isFinite(rawLimit) ? rawLimit : 20);
      ctx.type = 'application/json';
      ctx.body = { notifications: notifications.map(item => ({
        id: String(item.id), scope: item.scope, targetId: item.targetId, botId: item.botId, payload: item.messages, leaseUntil: item.leaseUntil
      })) };
    });
    router.post(path('/notifications/:id/ack'), async ctx => {
      if (!requireService(ctx)) return;
      const id = Number(ctx.params.id);
      if (!Number.isInteger(id) || id <= 0) { ctx.status = 400; ctx.body = errorResponse('', 'NOTIFICATION_INVALID', '通知编号无效。'); return; }
      const body = await jsonBody(ctx, config.maxBodyBytes) as Record<string, unknown>;
      const status = String(body.status ?? '');
      if (!['sent', 'failed', 'uncertain'].includes(status)) { ctx.status = 400; ctx.body = errorResponse('', 'NOTIFICATION_STATUS_INVALID', '通知状态无效。'); return; }
      await acknowledgeNotification(id, status as 'sent' | 'failed' | 'uncertain', String(body.error ?? ''));
      ctx.type = 'application/json'; ctx.body = { ok: true };
    });
    router.get(path('/notifications/health'), async ctx => {
      if (!requireService(ctx)) return;
      ctx.type = 'application/json'; ctx.body = { ok: true, counts: await notificationOutboxHealth() };
    });
  };

  // 保留旧 Core 健康地址和旧 QQ 业务前缀；新 QQ Gateway 使用客户端命名空间。
  registerHealthRoutes('/healthz', '/readyz');
  registerCoreRoutes('/internal/v1/qq');
  registerCoreRoutes('/api/qqbot/v1', '/health', '/ready');
  app.use(router.routes()); app.use(router.allowedMethods());
  const server = app.listen(config.port, config.listenHost); await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  state.__fantasyFinalCoreApiServer = server; logger.info(`Core API 已启动：http://${config.listenHost}:${config.port}`);
};

