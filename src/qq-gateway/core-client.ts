import type { CoreCommandRequest, CoreCommandResponse, NotificationLease } from './contracts';

export class CoreApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) {
    super(message);
    this.name = 'CoreApiError';
  }
}

export type CoreClientOptions = { baseUrl: string; serviceToken: string; timeoutMs?: number };

export class CoreClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: CoreClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.serviceToken;
    this.timeoutMs = options.timeoutMs ?? 8000;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', ...(init.headers ?? {}) }
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = body?.error ?? {};
        throw new CoreApiError(String(error.code ?? `HTTP_${response.status}`), String(error.message ?? '游戏核心暂时无法处理请求。'), response.status >= 500);
      }
      return body as T;
    } catch (error) {
      if (error instanceof CoreApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') throw new CoreApiError('CORE_TIMEOUT', '游戏核心响应超时，请稍后再试。', true);
      throw new CoreApiError('CORE_UNAVAILABLE', '游戏核心暂时不可用，请稍后再试。', true);
    } finally { clearTimeout(timer); }
  }

  health() { return this.request<{ ok: boolean }>('/api/qqbot/v1/health'); }

  heartbeat(conversation: { scope: 'group'; id: string; botId: string }) {
    return this.request<{ ok: boolean }>('/api/qqbot/v1/conversations/heartbeat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(conversation)
    });
  }

  command(request: CoreCommandRequest) {
    return this.request<CoreCommandResponse>('/api/qqbot/v1/commands', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': request.requestId }, body: JSON.stringify(request)
    });
  }

  claimNotifications(limit = 20) {
    return this.request<{ notifications: NotificationLease[] }>(`/api/qqbot/v1/notifications/claim?limit=${Math.max(1, Math.min(limit, 100))}`, { method: 'POST' });
  }

  ackNotification(id: string, status: 'sent' | 'failed' | 'uncertain', error?: string) {
    return this.request<{ ok: boolean }>(`/api/qqbot/v1/notifications/${encodeURIComponent(id)}/ack`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status, error })
    });
  }
}
