import { getPool } from "../../database/pool.js";
import { formatToAppMessage, formatValueToAppMessage, formatValueToMarkdown } from "../../app-api/app-format.js";
import { acknowledgeNotification, claimNotifications, enqueueNotification, ensureNotificationOutbox, notificationOutboxHealth } from "../notification/outbox.service.js";
import { executeCoreGameCommand } from "../../core-command-bridge.js";
import { reservePassiveWarrantNotice, takePvpDefeatNotice, townPassiveWantedAlert } from "../../game/pvp.service.js";
import { messageFormat } from "../../game/message.js";
import { executeAppCommand } from "../../app-api/app-command.service.js";
import { getCoreApiConfig } from "../../config/core-api.js";
import { parseCoreCommandRequest } from "../../contracts/core-api.js";
import { rememberGroupChannel } from "../../game/group-channel.service.js";
import { warrantNoticeFormat } from "../../response/warrant-notice.js";
import { logger } from "alemonjs";
import koaRouter from "koa-router";
import Koa from "koa";

//#region src/core/api/server.ts
const idempotency = /* @__PURE__ */ new Map();
const TTL = 6e5;
const cleanCache = () => {
	const now = Date.now();
	for (const [key, item] of idempotency) if (item.expiresAt <= now) idempotency.delete(key);
	if (idempotency.size > 1e4) idempotency.delete(idempotency.keys().next().value);
};
const bearer = (ctx) => {
	const value = String(ctx.get("authorization") ?? "");
	return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
};
const jsonBody = async (ctx, maxBytes) => {
	const chunks = [];
	let size = 0;
	for await (const chunk of ctx.req) {
		const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += part.length;
		if (size > maxBytes) throw Object.assign(/* @__PURE__ */ new Error("请求体过大"), { status: 413 });
		chunks.push(part);
	}
	if (!chunks.length) throw Object.assign(/* @__PURE__ */ new Error("缺少 JSON 请求体"), { status: 400 });
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw Object.assign(/* @__PURE__ */ new Error("JSON 请求体无效"), { status: 400 });
	}
};
const toCoreMessages = (result) => {
	const text = String(result?.text ?? "");
	const buttons = Array.isArray(result?.buttons) ? result.buttons.map((button) => ({
		label: String(button.label),
		command: String(button.command),
		execution: "manual"
	})) : [];
	const format = Array.isArray(result?.format) ? result.format : void 0;
	const markdown = typeof result?.markdown === "string" ? result.markdown : format ? formatValueToMarkdown(format) : text || (buttons.length ? "请选择一个操作：" : "");
	return [{
		kind: format || markdown ? "markdown" : "text",
		text,
		...markdown ? { markdown } : {},
		...format ? { format } : {},
		...buttons.length ? { buttons } : {}
	}];
};
const toCapturedCoreMessages = (formats) => formats.map((formatValue) => {
	const message = formatValueToAppMessage(formatValue);
	return {
		kind: "markdown",
		text: message.text,
		...message.markdown ? { markdown: message.markdown } : {},
		...message.format ? { format: message.format } : {},
		...message.buttons.length ? { buttons: message.buttons.map((button) => ({
			...button,
			execution: "manual"
		})) } : {}
	};
});
const errorResponse = (requestId, code, message, retryable = false) => ({
	ok: false,
	requestId,
	messages: [],
	retryable,
	error: {
		code,
		message
	}
});
const ready = async () => {
	const pool = await getPool();
	await pool.query("SELECT 1");
	await ensureNotificationOutbox(pool);
	return true;
};
const notificationMessage = (format) => {
	const message = formatToAppMessage(format);
	return {
		kind: "markdown",
		text: message.text,
		...message.markdown ? { markdown: message.markdown } : {},
		...message.format ? { format: message.format } : {},
		buttons: message.buttons.map((button) => ({
			...button,
			execution: "manual"
		}))
	};
};
/**
* 旧 QQ 中间件会在业务命令前处理的两类被动通知，现在由 Core 领取并写入
* outbox；Gateway 只负责发送，避免通知链绕过跨进程边界。
*/
const enqueueQqCommandNotices = async (request) => {
	if (request.actor.provider !== "qq" || !request.conversation?.botId) return;
	const { actor, conversation } = request;
	const scope = conversation.scope;
	try {
		const notice = await takePvpDefeatNotice(actor.subject);
		if (notice) {
			const defeatedAt = new Date(notice.defeatedAt).toLocaleString("zh-CN", {
				timeZone: "Asia/Shanghai",
				hour12: false
			});
			await enqueueNotification({
				dedupeKey: `pvp-defeat:${actor.subject}:${new Date(notice.defeatedAt).toISOString()}`,
				provider: "qq",
				botId: conversation.botId,
				scope,
				targetId: conversation.id,
				actorId: actor.subject,
				messages: [notificationMessage(messageFormat("战败通知", `${notice.notice}\n受击时间：${defeatedAt}\n\n战败保护将在你的下一次大型操作结束后解除，最长持续 1 小时。`))]
			});
		}
	} catch (error) {
		logger.warn({
			err: error,
			actorId: actor.subject
		}, "战败通知进入 Core outbox 失败");
	}
	if (scope !== "group") return;
	try {
		const wanted = await townPassiveWantedAlert(actor.subject);
		if (wanted && await reservePassiveWarrantNotice(wanted.warrantId, conversation.id, actor.subject)) await enqueueNotification({
			dedupeKey: `warrant-passive:${wanted.warrantId}:${conversation.id}:${actor.subject}:${Math.floor(Date.now() / 6e4)}`,
			provider: "qq",
			botId: conversation.botId,
			scope: "group",
			targetId: conversation.id,
			actorId: actor.subject,
			messages: [notificationMessage(warrantNoticeFormat(wanted, { passive: true }))]
		});
	} catch (error) {
		logger.warn({
			err: error,
			groupId: conversation.id,
			actorId: actor.subject
		}, "被动通缉提示进入 Core outbox 失败");
	}
};
const startCoreApiServer = async () => {
	const config = getCoreApiConfig();
	if (!config.enabled) return;
	const state = globalThis;
	if (state.__fantasyFinalCoreApiServer?.listening) return;
	const app = new Koa();
	app.proxy = false;
	app.use(async (ctx, next) => {
		try {
			await next();
		} catch (error) {
			const status = Number(error?.status) || 500;
			ctx.status = status;
			ctx.type = "application/json";
			ctx.body = {
				ok: false,
				error: status === 500 ? "CORE_INTERNAL_ERROR" : String(error.message)
			};
			if (status >= 500) logger.error({ err: error }, "Core API 请求失败");
		}
	});
	const router = new koaRouter();
	const requireService = (ctx) => {
		if (config.serviceToken && bearer(ctx) === config.serviceToken) return true;
		ctx.status = 401;
		ctx.type = "application/json";
		ctx.body = errorResponse(String(ctx.get("x-request-id") || ""), "AUTH_REQUIRED", "Core service token 无效。");
		return false;
	};
	const registerHealthRoutes = (healthPath, readyPath) => {
		router.get(healthPath, (ctx) => {
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				service: "fantasyfinal-core",
				time: (/* @__PURE__ */ new Date()).toISOString()
			};
		});
		router.get(readyPath, async (ctx) => {
			try {
				await ready();
				ctx.type = "application/json";
				ctx.body = {
					ok: true,
					database: "ready"
				};
			} catch (error) {
				ctx.status = 503;
				ctx.type = "application/json";
				ctx.body = {
					ok: false,
					database: "unavailable"
				};
				logger.warn({ err: error }, "Core 尚未就绪");
			}
		});
	};
	const registerCoreRoutes = (prefix, healthPath, readyPath) => {
		const path = (suffix) => `${prefix}${suffix}`;
		if (healthPath && readyPath) registerHealthRoutes(path(healthPath), path(readyPath));
		router.post(path("/commands"), async (ctx) => {
			if (!requireService(ctx)) return;
			let body;
			try {
				body = parseCoreCommandRequest(await jsonBody(ctx, config.maxBodyBytes));
			} catch (error) {
				ctx.status = 400;
				ctx.type = "application/json";
				ctx.body = errorResponse("", "REQUEST_INVALID", error instanceof Error ? error.message : "请求无效。");
				return;
			}
			const headerId = String(ctx.get("x-request-id") || "").trim();
			if (body.actor.provider !== "qq") {
				ctx.status = 400;
				ctx.type = "application/json";
				ctx.body = errorResponse(body.requestId, "ACTOR_PROVIDER_INVALID", "该接口只接受 QQ Gateway 身份。");
				return;
			}
			if (headerId && headerId !== body.requestId) {
				ctx.status = 400;
				ctx.body = errorResponse(body.requestId, "REQUEST_ID_MISMATCH", "请求 ID 不一致。");
				return;
			}
			cleanCache();
			const cacheKey = `${body.actor.provider}:${body.actor.subject}:${body.requestId}`;
			const cached = idempotency.get(cacheKey);
			if (cached && cached.expiresAt > Date.now()) {
				ctx.type = "application/json";
				ctx.body = cached.response;
				return;
			}
			let response;
			try {
				await enqueueQqCommandNotices(body);
				const legacy = await executeCoreGameCommand(body);
				const messages = legacy.matched ? toCapturedCoreMessages(legacy.formats) : toCoreMessages(await executeAppCommand({
					qqUserId: body.actor.subject,
					command: body.command
				}));
				response = {
					ok: true,
					requestId: body.requestId,
					messages,
					stateVersion: (/* @__PURE__ */ new Date()).toISOString()
				};
			} catch (error) {
				response = errorResponse(body.requestId, "COMMAND_INVALID", error instanceof Error ? error.message : "命令执行失败。");
			}
			idempotency.set(cacheKey, {
				expiresAt: Date.now() + TTL,
				response
			});
			ctx.type = "application/json";
			ctx.body = response;
		});
		router.post(path("/conversations/heartbeat"), async (ctx) => {
			if (!requireService(ctx)) return;
			const body = await jsonBody(ctx, config.maxBodyBytes);
			const scope = String(body.scope ?? "");
			const id = String(body.id ?? "").trim();
			const botId = String(body.botId ?? "").trim();
			if (scope !== "group" || !id || !botId) {
				ctx.status = 400;
				ctx.body = errorResponse("", "CONVERSATION_INVALID", "群会话信息无效。");
				return;
			}
			await rememberGroupChannel(id, botId);
			ctx.type = "application/json";
			ctx.body = { ok: true };
		});
		router.post(path("/notifications/claim"), async (ctx) => {
			if (!requireService(ctx)) return;
			const rawLimit = Number(ctx.query.limit ?? 20);
			const notifications = await claimNotifications("qq-gateway", Number.isFinite(rawLimit) ? rawLimit : 20);
			ctx.type = "application/json";
			ctx.body = { notifications: notifications.map((item) => ({
				id: String(item.id),
				scope: item.scope,
				targetId: item.targetId,
				botId: item.botId,
				payload: item.messages,
				leaseUntil: item.leaseUntil
			})) };
		});
		router.post(path("/notifications/:id/ack"), async (ctx) => {
			if (!requireService(ctx)) return;
			const id = Number(ctx.params.id);
			if (!Number.isInteger(id) || id <= 0) {
				ctx.status = 400;
				ctx.body = errorResponse("", "NOTIFICATION_INVALID", "通知编号无效。");
				return;
			}
			const body = await jsonBody(ctx, config.maxBodyBytes);
			const status = String(body.status ?? "");
			if (![
				"sent",
				"failed",
				"uncertain"
			].includes(status)) {
				ctx.status = 400;
				ctx.body = errorResponse("", "NOTIFICATION_STATUS_INVALID", "通知状态无效。");
				return;
			}
			await acknowledgeNotification(id, status, String(body.error ?? ""));
			ctx.type = "application/json";
			ctx.body = { ok: true };
		});
		router.get(path("/notifications/health"), async (ctx) => {
			if (!requireService(ctx)) return;
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				counts: await notificationOutboxHealth()
			};
		});
	};
	registerHealthRoutes("/healthz", "/readyz");
	registerCoreRoutes("/internal/v1/qq");
	registerCoreRoutes("/api/qqbot/v1", "/health", "/ready");
	app.use(router.routes());
	app.use(router.allowedMethods());
	const server = app.listen(config.port, config.listenHost);
	await new Promise((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
	state.__fantasyFinalCoreApiServer = server;
	logger.info(`Core API 已启动：http://${config.listenHost}:${config.port}`);
};

//#endregion
export { startCoreApiServer };