import { MessageDirect, ResultCode, Router, defineChildren, getConfigValue, logger, useEvent, useMessage } from 'alemonjs';
import { randomUUID } from 'node:crypto';
import { CoreApiError, CoreClient } from './core-client';
import type { ConversationContext, CoreCommandRequest } from './contracts';
import { renderCoreError, renderCoreMessages } from './renderer';
import { NotificationPoller } from './notification-poller';
import type { NotificationLease } from './contracts';

const gatewayConfig = getConfigValue<{ FantasyFinal?: { coreApi?: { serviceToken?: string } } }>().FantasyFinal?.coreApi ?? {};
const core = new CoreClient({
  baseUrl: process.env.FANTASYFINAL_CORE_URL ?? 'http://127.0.0.1:17200',
  serviceToken: process.env.FANTASYFINAL_CORE_TOKEN ?? process.env.FANTASYFINAL_CORE_SERVICE_TOKEN ?? String(gatewayConfig.serviceToken ?? ''),
  timeoutMs: Number(process.env.FANTASYFINAL_CORE_TIMEOUT_MS ?? 8000)
});

const notificationSender = async (notification: NotificationLease): Promise<'sent' | 'failed' | 'uncertain'> => {
  try {
    const format = renderCoreMessages(notification.payload);
    const scope = notification.scope === 'private' ? 'c2c' : notification.scope;
    const results = await MessageDirect.create().sendToTarget({
      target: { scope, targetId: notification.targetId, BotId: notification.botId },
      format
    });
    return results.length && results.every(result => result.code === ResultCode.Ok) ? 'sent' : 'failed';
  } catch (error) {
    logger.warn({ err: error, notificationId: notification.id }, '[qq-gateway] 主动通知发送失败');
    return 'uncertain';
  }
};

const notificationPoller = new NotificationPoller(core, notificationSender);
notificationPoller.start();

const textOf = (event: any) => String(
  event?.MessageText
    ?? event?.message?.content
    ?? event?.current?.MessageText
    ?? event?.current?.Message
    ?? event?.current?.Content
    ?? event?.content
    ?? ''
).trim();
const requestIdOf = (event: any) => String(
  event?.MessageId
    ?? event?.message?.id
    ?? event?.current?.MessageId
    ?? event?.current?.message_id
    ?? randomUUID()
);
const conversationOf = (event: any): ConversationContext | undefined => {
  const current = event?.current ?? {};
  const id = String(current.ChannelId ?? current.GroupId ?? current.ChannelID ?? current.guild_id ?? current.UserId ?? '').trim();
  if (!id) return undefined;
  // QQ 群事件不一定同时带 GroupId；现有项目以 IsPrivate + ChannelId
  // 识别群会话，因此不能仅凭 guild_id 判断，否则群命令会被当成私聊。
  const scope = current.IsPrivate ? 'private' : 'group';
  return { scope, id, botId: current.BotId ? String(current.BotId) : undefined };
};

/** Gateway 唯一事件入口：不 import src/game、src/database、mysql2，也不执行本地游戏逻辑。 */
export const router = Router.create({ events: ['message.create', 'private.message.create', 'interaction.create', 'private.interaction.create'] });
const gatewayHandler = async () => {
  const [event] = useEvent();
  const [message] = useMessage();
  const current = (event as any)?.current ?? event ?? {};
  if (current.IsBot || current.is_bot) return;
  const command = textOf(event);
  if (!command) return;
  const subject = String(current.UserId ?? current.user_id ?? (event as any)?.UserId ?? (event as any)?.user_id ?? '').trim();
  if (!subject) return;
  const request: CoreCommandRequest = {
    requestId: requestIdOf(event),
    actor: { provider: 'qq', subject, displayName: current.UserName ? String(current.UserName) : undefined },
    conversation: conversationOf(event), command, source: (event as any)?.interaction ? 'interaction' : 'message', sentAt: new Date().toISOString()
  };
  try {
    if (request.conversation?.scope === 'group' && request.conversation.botId) {
      await core.heartbeat({ scope: 'group', id: request.conversation.id, botId: request.conversation.botId });
    }
    const response = await core.command(request);
    if (!response.ok) throw new CoreApiError(response.error?.code ?? 'CORE_ERROR', response.error?.message ?? '游戏核心暂时无法处理请求。', response.retryable);
    if (response.messages?.length) await message.send({ format: renderCoreMessages(response.messages) });
  } catch (error) {
    logger.warn(`[qq-gateway] command failed: ${error instanceof Error ? error.message : String(error)}`);
    await message.send({ format: renderCoreError(error) });
  }
};
router.res({}, () => Promise.resolve(gatewayHandler));

export { core };

export default defineChildren({
  register() {
    return { responseRouter: router.define };
  },
  onCreated() {
    logger.info('[qq-gateway] Core API 网关已加载');
  }
});
