export type ActorContext = {
  provider: 'qq';
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
  sentAt: string;
};

export type CoreMessage = {
  kind: 'text' | 'markdown' | 'image';
  text?: string;
  format?: Array<{ type?: string; value?: unknown; options?: Record<string, unknown> }>;
  markdown?: string;
  url?: string;
  buttons?: Array<{ label: string; command: string; execution?: 'manual' }>;
  mentionActor?: boolean;
};

export type CoreCommandResponse = {
  ok: boolean;
  requestId: string;
  messages: CoreMessage[];
  retryable?: boolean;
  error?: { code: string; message: string };
};

export type NotificationLease = {
  id: string;
  scope: 'private' | 'group' | 'channel';
  targetId: string;
  botId?: string;
  payload: CoreMessage[];
  leaseUntil?: string;
};
