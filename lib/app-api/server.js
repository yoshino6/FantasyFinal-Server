import { consumeRealtimeTicket, listChatChannels, listChatMessages, sendChatMessage } from "./social.service.js";
import { registerAppApiRoutes } from "./router.js";
import { getAppApiServerConfig } from "../config/app-api-server.js";
import { logger } from "alemonjs";
import koaRouter from "koa-router";
import Koa from "koa";
import { WebSocket, WebSocketServer } from "ws";

//#region src/app-api/server.ts
const closePreviousServer = async () => {
	const state = globalThis;
	const previousServer = state.__fantasyFinalAppApiServer;
	if (!previousServer?.listening) return;
	await new Promise((resolve, reject) => {
		previousServer.close((error) => error ? reject(error) : resolve());
	});
	delete state.__fantasyFinalAppApiServer;
};
const startAppApiServer = async () => {
	const config = getAppApiServerConfig();
	if (!config.enabled) return;
	await closePreviousServer();
	const app = new Koa();
	app.use(async (ctx, next) => {
		ctx.set("Access-Control-Allow-Origin", "*");
		ctx.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
		ctx.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
		if (ctx.method === "OPTIONS") {
			ctx.status = 204;
			return;
		}
		await next();
	});
	const router = new koaRouter();
	registerAppApiRoutes(router);
	registerAppApiRoutes(router, "/api/desktop/v1");
	registerAppApiRoutes(router, "/api/web/v1");
	app.use(router.routes());
	app.use(router.allowedMethods());
	const server = app.listen(config.port, config.listenHost);
	await new Promise((resolve, reject) => {
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		const onError = (error) => {
			server.off("listening", onListening);
			reject(error);
		};
		server.once("listening", onListening);
		server.once("error", onError);
	});
	const realtime = new WebSocketServer({ noServer: true });
	const clients = /* @__PURE__ */ new Set();
	const send = (socket, value) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
	};
	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		if (url.pathname !== "/api/web/v1/realtime") {
			socket.destroy();
			return;
		}
		const session = consumeRealtimeTicket(url.searchParams.get("ticket"));
		if (!session) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}
		realtime.handleUpgrade(request, socket, head, (client) => realtime.emit("connection", client, session));
	});
	realtime.on("connection", (socket, session) => {
		const client = {
			socket,
			session
		};
		clients.add(client);
		listChatChannels(session).then((channels) => send(socket, {
			type: "ready",
			channels
		})).catch((error) => send(socket, {
			type: "error",
			message: error instanceof Error ? error.message : "实时连接初始化失败。"
		}));
		socket.on("message", (data) => {
			(async () => {
				let message;
				try {
					message = JSON.parse(String(data));
				} catch {
					send(socket, {
						type: "error",
						message: "实时消息格式无效。"
					});
					return;
				}
				const channelId = String(message?.channelId ?? "").trim();
				if (message?.type === "subscribe") {
					try {
						await listChatMessages(session, channelId, 1);
						client.channelId = channelId;
						send(socket, {
							type: "subscribed",
							channelId
						});
					} catch (error) {
						send(socket, {
							type: "error",
							message: error instanceof Error ? error.message : "无法订阅该频道。"
						});
					}
					return;
				}
				if (message?.type !== "message" || !channelId || client.channelId !== channelId) {
					send(socket, {
						type: "error",
						message: "请先订阅聊天频道。"
					});
					return;
				}
				try {
					const saved = await sendChatMessage(session, channelId, message.content);
					for (const target of clients) if (target.channelId === channelId) send(target.socket, {
						type: "message",
						message: {
							...saved,
							own: target === client
						}
					});
				} catch (error) {
					send(socket, {
						type: "error",
						message: error instanceof Error ? error.message : "消息发送失败。"
					});
				}
			})();
		});
		socket.on("close", () => clients.delete(client));
		socket.on("error", () => clients.delete(client));
	});
	globalThis.__fantasyFinalAppApiServer = server;
	logger.info(`桌宠 App 网关已启动：http://${config.listenHost}:${config.port}/api/desktop/v1（兼容 /app-api/v1）`);
};

//#endregion
export { startAppApiServer };