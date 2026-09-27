export type ActorContext = {
  provider: 'qq' | 'app';
  subject: string;
  displayName?: string;
};

export type ConversationContext = {
  scope: 'private' | 'group' | 'channel';
  id: string;
  botId?: string;
};

export type CoreCommandRequest = {
  requestId: string;
  actor: ActorContext;
  conversation?: ConversationContext;
  command: string;
  source: 'message' | 'interaction' | 'system';
  sentAt?: string;
};

export type CoreMessage = {
  kind: 'text' | 'markdown' | 'image';
  text?: string;
  /** 结构化 Alemon Format.value，客户端可按原节点重新构造平台消息。 */
  format?: Array<{ type?: string; value?: unknown; options?: Record<string, unknown> }>;
  /** 没有结构化 Format 时使用的 Markdown 回退正文。 */
  markdown?: string;
  url?: string;
  buttons?: Array<{ label: string; command: string; execution: 'manual' }>;
  mentionActor?: boolean;
};

export type CoreCommandResponse = {
  ok: boolean;
  requestId: string;
  messages: CoreMessage[];
  stateVersion?: string;
  retryable?: boolean;
  error?: { code: string; message: string };
};

export const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const isNonEmptyString = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export const parseCoreCommandRequest = (value: unknown): CoreCommandRequest => {
  if (!isRecord(value)) throw new Error('请求体必须是 JSON 对象');
  const requestId = String(value.requestId ?? '').trim();
  const command = String(value.command ?? '').trim();
  const actor = value.actor;
  if (!isNonEmptyString(requestId, 256)) throw new Error('requestId 无效');
  if (!isNonEmptyString(command, 4096)) throw new Error('command 无效');
  if (!isRecord(actor) || !['qq', 'app'].includes(String(actor.provider)) || !isNonEmptyString(actor.subject, 256)) throw new Error('actor 无效');
  const source = String(value.source ?? 'message');
  if (!['message', 'interaction', 'system'].includes(source)) throw new Error('source 无效');
  let conversation: ConversationContext | undefined;
  if (value.conversation !== undefined) {
    const raw = value.conversation;
    if (!isRecord(raw) || !['private', 'group', 'channel'].includes(String(raw.scope)) || !isNonEmptyString(raw.id, 256)) throw new Error('conversation 无效');
    conversation = { scope: raw.scope as ConversationContext['scope'], id: raw.id, ...(isNonEmptyString(raw.botId, 256) ? { botId: raw.botId } : {}) };
  }
  return {
    requestId,
    actor: { provider: actor.provider as ActorContext['provider'], subject: actor.subject, ...(isNonEmptyString(actor.displayName, 256) ? { displayName: actor.displayName } : {}) },
    ...(conversation ? { conversation } : {}),
    command,
    source: source as CoreCommandRequest['source'],
    ...(isNonEmptyString(value.sentAt, 128) ? { sentAt: value.sentAt } : {})
  };
};
