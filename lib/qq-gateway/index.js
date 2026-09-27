import { CoreApiError, CoreClient } from "./core-client.js";
import { renderCoreError, renderCoreMessages } from "./renderer.js";
import { NotificationPoller } from "./notification-poller.js";
import { MessageDirect, ResultCode, Router, defineChildren, getConfigValue, logger, useEvent, useMessage } from "alemonjs";
import { randomUUID } from "node:crypto";

//#region src/qq-gateway/index.ts
const gatewayConfig = getConfigValue().FantasyFinal?.coreApi ?? {};
const core = new CoreClient({
	baseUrl: process.env.FANTASYFINAL_CORE_URL ?? "http://127.0.0.1:17200",
	serviceToken: process.env.FANTASYFINAL_CORE_TOKEN ?? process.env.FANTASYFINAL_CORE_SERVICE_TOKEN ?? String(gatewayConfig.serviceToken ?? ""),
	timeoutMs: Number(process.env.FANTASYFINAL_CORE_TIMEOUT_MS ?? 8e3)
});
const notificationSender = async (notification) => {
	try {
		const format = renderCoreMessages(notification.payload);
		const scope = notification.scope === "private" ? "c2c" : notification.scope;
		const results = await MessageDirect.create().sendToTarget({
			target: {
				scope,
				targetId: notification.targetId,
				BotId: notification.botId
			},
			format
		});
		return results.length && results.every((result) => result.code === ResultCode.Ok) ? "sent" : "failed";
	} catch (error) {
		logger.warn({
			err: error,
			notificationId: notification.id
		}, "[qq-gateway] 主动通知发送失败");
		return "uncertain";
	}
};
new NotificationPoller(core, notificationSender).start();
const textOf = (event) => String(event?.MessageText ?? event?.message?.content ?? event?.current?.MessageText ?? event?.current?.Message ?? event?.current?.Content ?? event?.content ?? "").trim();
const requestIdOf = (event) => String(event?.MessageId ?? event?.message?.id ?? event?.current?.MessageId ?? event?.current?.message_id ?? randomUUID());
const conversationOf = (event) => {
	const current = event?.current ?? {};
	const id = String(current.ChannelId ?? current.GroupId ?? current.ChannelID ?? current.guild_id ?? current.UserId ?? "").trim();
	if (!id) return void 0;
	return {
		scope: current.IsPrivate ? "private" : "group",
		id,
		botId: current.BotId ? String(current.BotId) : void 0
	};
};
/** Gateway 唯一事件入口：不 import src/game、src/database、mysql2，也不执行本地游戏逻辑。 */
const router = Router.create({ events: [
	"message.create",
	"private.message.create",
	"interaction.create",
	"private.interaction.create"
] });
const gatewayHandler = async () => {
	const [event] = useEvent();
	const [message] = useMessage();
	const current = event?.current ?? event ?? {};
	if (current.IsBot || current.is_bot) return;
	const command = textOf(event);
	if (!command) return;
	const subject = String(current.UserId ?? current.user_id ?? event?.UserId ?? event?.user_id ?? "").trim();
	if (!subject) return;
	const request = {
		requestId: requestIdOf(event),
		actor: {
			provider: "qq",
			subject,
			displayName: current.UserName ? String(current.UserName) : void 0
		},
		conversation: conversationOf(event),
		command,
		source: event?.interaction ? "interaction" : "message",
		sentAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	try {
		if (request.conversation?.scope === "group" && request.conversation.botId) await core.heartbeat({
			scope: "group",
			id: request.conversation.id,
			botId: request.conversation.botId
		});
		const response = await core.command(request);
		if (!response.ok) throw new CoreApiError(response.error?.code ?? "CORE_ERROR", response.error?.message ?? "游戏核心暂时无法处理请求。", response.retryable);
		if (response.messages?.length) await message.send({ format: renderCoreMessages(response.messages) });
	} catch (error) {
		logger.warn(`[qq-gateway] command failed: ${error instanceof Error ? error.message : String(error)}`);
		await message.send({ format: renderCoreError(error) });
	}
};
router.res({}, () => Promise.resolve(gatewayHandler));
var qq_gateway_default = defineChildren({
	register() {
		return { responseRouter: router.define };
	},
	onCreated() {
		logger.info("[qq-gateway] Core API 网关已加载");
	}
});

//#endregion
export { core, qq_gateway_default as default, router };