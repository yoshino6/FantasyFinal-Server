//#region src/qq-gateway/notification-poller.ts
var NotificationPoller = class {
	client;
	sender;
	intervalMs;
	timer;
	running = false;
	constructor(client, sender, intervalMs = 5e3) {
		this.client = client;
		this.sender = sender;
		this.intervalMs = intervalMs;
	}
	start() {
		if (!this.timer) {
			this.poll();
			this.timer = setInterval(() => void this.poll(), this.intervalMs);
		}
	}
	stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = void 0;
	}
	async poll() {
		if (this.running) return;
		this.running = true;
		try {
			const { notifications } = await this.client.claimNotifications();
			for (const notification of notifications ?? []) try {
				await this.client.ackNotification(notification.id, await this.sender(notification));
			} catch (error) {
				await this.client.ackNotification(notification.id, "uncertain", error instanceof Error ? error.message : String(error)).catch(() => void 0);
			}
		} catch {} finally {
			this.running = false;
		}
	}
};

//#endregion
export { NotificationPoller };