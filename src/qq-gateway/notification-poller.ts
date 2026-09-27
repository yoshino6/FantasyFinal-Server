import type { CoreClient } from './core-client';
import type { NotificationLease } from './contracts';

export type NotificationSender = (notification: NotificationLease) => Promise<'sent' | 'failed' | 'uncertain'>;

export class NotificationPoller {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(private readonly client: CoreClient, private readonly sender: NotificationSender, private readonly intervalMs = 5000) {}
  start() { if (!this.timer) { void this.poll(); this.timer = setInterval(() => void this.poll(), this.intervalMs); } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private async poll() {
    if (this.running) return; this.running = true;
    try {
      const { notifications } = await this.client.claimNotifications();
      for (const notification of notifications ?? []) {
        try { await this.client.ackNotification(notification.id, await this.sender(notification)); }
        catch (error) { await this.client.ackNotification(notification.id, 'uncertain', error instanceof Error ? error.message : String(error)).catch(() => undefined); }
      }
    } catch { /* Core 暂不可用时等待下一轮，不在 Gateway 本地执行游戏逻辑。 */ }
    finally { this.running = false; }
  }
}
