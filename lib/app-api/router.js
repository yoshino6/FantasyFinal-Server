import { getCharacter } from "../game/character.service.js";
import { countUnreadWebNotifications, listWebNotifications, listWebNotificationsAfter, markAllWebNotificationsRead, markWebNotificationsRead } from "./notification.service.js";
import { executeCoreGameCommand, listCoreCommandCatalog } from "../core-command-bridge.js";
import { friendList, friendRequests, oathReleaseRequests, oathRequests, oathStatus } from "../game/social.service.js";
import { appSessionQqUser, changeAppPasswordByPlayerId, createAppUser, loginAppUser, logoutAppSession, sessionForApp, setAppPasswordByPlayerId } from "../game/app-channel.service.js";
import { registerHandbookRoutes } from "./handbook-routes.js";
import { registerBankApiRoutes } from "./bank-routes.js";
import { registerHomeApiRoutes } from "./home-routes.js";
import { registerGuildShopApiRoutes } from "./guild-shop-routes.js";
import { registerBookshopApiRoutes } from "./bookshop-routes.js";
import { registerHomeShopApiRoutes } from "./home-shop-routes.js";
import { registerEvolutionApiRoutes } from "./evolution-routes.js";
import { autoBattleConfig, autoBattleSkills, autoPotionItems, deleteAutoBattleAction, saveAutoBattleAction, setAutoBattleEnabled, setAutoPotionEnabled, setAutoPotionItem, setAutoPotionThreshold, toggleAutoBattleEncounterAction } from "../game/auto-battle.service.js";
import { appQuickPanel, executeAppCommand } from "./app-command.service.js";
import { registerAdvancedProfessionApiRoutes } from "./advanced-profession-routes.js";
import { registerMarketApiRoutes } from "./market-routes.js";
import { registerSkillApiRoutes } from "./skill-routes.js";
import { getAppApiConfig } from "../config/app-api.js";
import { appCommandCatalogFor, appCommandCategories, findAppCommandById, isAppCommandAllowed } from "./command-catalog.js";
import { coreInteractionPresentation, coreWindowCommand } from "./core-interaction-presentation.js";
import { CoreInteractionActionError, executeIssuedCoreInteractionAction, issueCoreInteractionActions } from "./interaction-action.service.js";
import { countUnreadGameMails, gameMailDetail, listGameMails } from "./mail.service.js";
import { claimAllMails, claimMail, deleteMail } from "../game/mail.service.js";
import { acceptPartyApplication, applyPartyRecruitment, createPartyRecruitment, createWebParty, currentWebParty, issueRealtimeTicket, leaveWebParty, listChatChannels, listChatMessages, listPartyApplications, rejectPartyApplication, renameWebParty, searchPartyRecruitments, sendChatMessage } from "./social.service.js";
import { randomUUID } from "node:crypto";

//#region src/app-api/router.ts
const secureRequest = (ctx) => {
	const config = getAppApiConfig();
	if (!config.enabled) return false;
	const remote = String(ctx.req?.socket?.remoteAddress ?? "");
	if ((/* @__PURE__ */ new Set([
		"127.0.0.1",
		"::1",
		"::ffff:127.0.0.1"
	])).has(remote)) return true;
	return config.allowInsecurePublicHttp === true || String(ctx.get("x-forwarded-proto") ?? "").toLowerCase() === "https";
};
const apiError = (ctx, status, message) => {
	ctx.status = status;
	ctx.type = "application/json";
	ctx.body = {
		ok: false,
		message
	};
};
const parseBody = async (ctx) => {
	if (Number(ctx.get("content-length") || 0) > 65536) throw new Error("请求体过大。");
	const chunks = [];
	let size = 0;
	for await (const chunk of ctx.req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > 65536) throw new Error("请求体过大。");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (!text) return {};
	try {
		const result = JSON.parse(text);
		return result && typeof result === "object" && !Array.isArray(result) ? result : {};
	} catch {
		throw new Error("请求格式无效。");
	}
};
const bearer = (ctx) => {
	const header = String(ctx.get("authorization") ?? "");
	const match = /^Bearer\s+(.+)$/i.exec(header);
	return match ? match[1].trim() : "";
};
const requireSession = async (ctx) => {
	if (!secureRequest(ctx)) {
		apiError(ctx, 404, "未找到接口。");
		return null;
	}
	const token = bearer(ctx);
	if (!token) {
		apiError(ctx, 401, "缺少访问令牌。");
		return null;
	}
	const session = await sessionForApp(token);
	if (!session) {
		apiError(ctx, 401, "登录已失效，请重新登录。");
		return null;
	}
	return session;
};
const autoBattleMode = (value) => String(value ?? "pve").toLowerCase() === "pvp" ? "pvp" : "pve";
const autoBattleView = (data) => ({
	mode: data.mode,
	settings: {
		enabled: Boolean(data.settings?.enabled),
		defaultEncounterAction: data.settings?.default_encounter_action ?? "battle",
		autoPotionEnabled: Boolean(data.settings?.auto_potion_enabled),
		hpThreshold: Number(data.settings?.hp_threshold ?? 30),
		hpItemId: data.settings?.hp_item_id == null ? null : Number(data.settings.hp_item_id),
		hpItemName: data.settings?.hp_item_name ?? null,
		mpThreshold: Number(data.settings?.mp_threshold ?? 30),
		mpItemId: data.settings?.mp_item_id == null ? null : Number(data.settings.mp_item_id),
		mpItemName: data.settings?.mp_item_name ?? null
	},
	actions: data.actions.map((action) => ({
		sequence: Number(action.sequence),
		skillId: action.skillId == null ? null : Number(action.skillId),
		name: String(action.name)
	}))
});
const pendingCommandActions = /* @__PURE__ */ new Map();
const pendingActionTtl = 6e4;
const cleanupPendingCommandActions = () => {
	const now = Date.now();
	for (const [token, item] of pendingCommandActions) if (item.expiresAt <= now) pendingCommandActions.delete(token);
	if (pendingCommandActions.size > 1e4) pendingCommandActions.delete(pendingCommandActions.keys().next().value);
};
const actionValues = (entry, raw) => {
	const objectArgs = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : void 0;
	const arrayArgs = Array.isArray(raw) ? raw : void 0;
	const values = [];
	for (const [index, argument] of entry.args.entries()) {
		const rawValue = arrayArgs ? arrayArgs[index] : objectArgs?.[argument.name];
		if (rawValue === void 0 || rawValue === null || String(rawValue).trim() === "") {
			if (argument.required) return { error: `请填写${argument.label || argument.name}。` };
			values.push("");
			continue;
		}
		const value = typeof rawValue === "string" ? rawValue.trim() : String(rawValue);
		if (value.length > 4096 || /[\r\n]/.test(value)) return { error: `${argument.label || argument.name}内容无效。` };
		if (argument.type === "number") {
			const number = Number(value);
			if (!Number.isFinite(number)) return { error: `${argument.label || argument.name}必须是数字。` };
			if (argument.min !== void 0 && number < argument.min) return { error: `${argument.label || argument.name}不能小于 ${argument.min}。` };
			if (argument.max !== void 0 && number > argument.max) return { error: `${argument.label || argument.name}不能大于 ${argument.max}。` };
		}
		if (argument.type === "enum" && argument.options?.length && !argument.options.includes(value)) return { error: `${argument.label || argument.name}取值不在允许范围内。` };
		values.push(value);
	}
	return { values };
};
const actionCommand = (entry, values) => {
	let lastValue = -1;
	values.forEach((value, index) => {
		if (value.trim()) lastValue = index;
	});
	const args = lastValue < 0 ? [] : values.slice(0, lastValue + 1);
	return [entry.command, ...args].join(" ").trim();
};
const signedCoreResponse = async (session, sessionToken, originCommand, execution, blockWebProtectedWrites = false) => {
	const issued = await issueCoreInteractionActions({
		session,
		sessionToken,
		originCommand,
		execution,
		blockWebProtectedWrites
	});
	return {
		...issued.messages[0] ?? {
			text: "命令已执行。",
			buttons: []
		},
		...issued
	};
};
/**
* 兼容旧版网页按钮发送的纯文本命令。命令必须先出现在动态公开目录中，
* 因而不会因为这个兼容入口绕过管理、测试或隐藏路由过滤。
*/
const coreEntryForRawCommand = (raw) => {
	const command = raw.trim().replace(/^\/+/, "");
	if (!command) return void 0;
	return listCoreCommandCatalog().sort((left, right) => right.command.length - left.command.length).find((entry) => command === entry.command || command.startsWith(`${entry.command} `));
};
const webMarketWriteCommand = (command) => /^\/*万叶(?:卖出|求购|撤单)(?:\s|$)/.test(command.trim());
const webSkillWriteCommand = (command) => /^\/*(?:学习技能|升级技能|升级专精|链接被动|技能快捷|升级鉴识)(?:\s|$)/.test(command.trim());
const webBankWriteCommand = (command) => /^\/*钱庄(?:存入|取出|定存|兑付|提前支取)(?:\s|$)/.test(command.trim());
const webHomeWriteCommand = (command) => /^\/*家园(?:改名|购买|回家|出门|放入|取出|升级|扩建|制作|拆除)(?:\s|$)/.test(command.trim());
const webGuildShopWriteCommand = (command) => /^\/*(?:购买商品|出售商品)(?:\s|$)/.test(command.trim());
const webBookshopWriteCommand = (command) => /^\/*(?:购买书屋物品|出售书屋物品)(?:\s|$)/.test(command.trim());
const webHomeShopWriteCommand = (command) => /^\/*百纳居交易(?:\s|$)/.test(command.trim());
const webEvolutionWriteCommand = (command) => /^\/*(?:进化注射|进化共生选择|进化定型选择|领取进化委托|提交进化委托|进化变异操作)(?:\s|$)/.test(command.trim());
const webAdvancedProfessionWriteCommand = (command) => /^\/*(?:二转闲聊|接受二转|确认切换二转|推进二转|提交二转凭证|开启导师试炼|开始二转旁修|完成二转旁修|切换二转旁修|隐藏二转|隐藏导师操作|二转配置)(?:\s|$)/.test(command.trim());
const webProtectedWriteCommand = (command) => webMarketWriteCommand(command) || webSkillWriteCommand(command) || webBankWriteCommand(command) || webHomeWriteCommand(command) || webGuildShopWriteCommand(command) || webBookshopWriteCommand(command) || webHomeShopWriteCommand(command) || webEvolutionWriteCommand(command) || webAdvancedProfessionWriteCommand(command);
const webProtectedWriteMessage = (command) => webSkillWriteCommand(command) ? "请在角色页的技能面板查看消耗并确认操作。" : webBankWriteCommand(command) ? "请在探索地图的银铃钱庄查看报价并确认办理。" : /^\/*家园(?:放入|取出)(?:\s|$)/.test(command.trim()) ? "请在世界页的家园储物查看报价并确认操作。" : webHomeWriteCommand(command) ? "家园操作请先查看世界页的家园状态。" : webGuildShopWriteCommand(command) ? "请在探索地图的公会商店查看报价并确认交易。" : webBookshopWriteCommand(command) ? "请在探索地图的百味书屋查看报价并确认交易。" : webHomeShopWriteCommand(command) ? "请在探索地图的百纳居查看报价并确认交易。" : webEvolutionWriteCommand(command) ? "请在角色页的进化档案查看当前条件，并通过专用确认流程操作。" : webAdvancedProfessionWriteCommand(command) ? "请在角色页的职业进阶查看当前试炼，并通过专用确认流程操作。" : "请在世界页的万叶联市查看报价并确认交易。";
/** 桌宠 App API；默认保留旧前缀，新客户端使用 /api/desktop/v1。 */
const registerAppApiRoutes = (router, apiPrefix = "/app-api/v1") => {
	const apiPath = (path) => `${apiPrefix}${path}`;
	if (apiPrefix === "/api/web/v1") {
		registerBankApiRoutes(router, apiPrefix, {
			requireSession,
			parseBody,
			apiError
		});
		registerHomeApiRoutes(router, apiPrefix, {
			requireSession,
			parseBody,
			apiError
		});
		registerGuildShopApiRoutes(router, apiPrefix, {
			requireSession,
			parseBody,
			apiError
		});
		registerBookshopApiRoutes(router, apiPrefix, {
			requireSession,
			parseBody,
			apiError
		});
		registerHomeShopApiRoutes(router, apiPrefix, {
			requireSession,
			parseBody,
			apiError
		});
		registerEvolutionApiRoutes(router, apiPrefix, {
			requireSession,
			parseBody,
			apiError
		});
		registerAdvancedProfessionApiRoutes(router, apiPrefix, {
			requireSession,
			parseBody,
			apiError
		});
		registerMarketApiRoutes(router, apiPrefix, {
			requireSession,
			parseBody,
			apiError
		});
		registerSkillApiRoutes(router, apiPrefix, {
			requireSession,
			parseBody,
			apiError
		});
	}
	router.get(apiPath("/health"), async (ctx) => {
		ctx.type = "application/json";
		ctx.body = {
			ok: true,
			service: "fantasy-final-game-core",
			time: (/* @__PURE__ */ new Date()).toISOString()
		};
	});
	router.post(apiPath("/register"), async (ctx) => {
		try {
			if (!secureRequest(ctx)) {
				apiError(ctx, 404, "未找到接口。");
				return;
			}
			const body = await parseBody(ctx);
			const displayName = String(body.displayName ?? "").trim();
			if (!displayName) {
				apiError(ctx, 400, "请填写昵称。");
				return;
			}
			if (String(body.password ?? "") !== String(body.passwordConfirmation ?? "")) {
				apiError(ctx, 400, "两次密码不一致。");
				return;
			}
			const created = await createAppUser(displayName, body.password);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				accessToken: created.token,
				uid: created.loginId,
				loginId: created.loginId,
				gameUserId: created.gameUserId,
				account: {
					uid: created.loginId,
					loginId: created.loginId,
					gameUserId: created.gameUserId,
					passwordLoginEnabled: true
				}
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "注册失败。");
		}
	});
	router.post(apiPath("/login"), async (ctx) => {
		try {
			if (!secureRequest(ctx)) {
				apiError(ctx, 404, "未找到接口。");
				return;
			}
			const body = await parseBody(ctx);
			const result = await loginAppUser(body.loginId ?? body.gameId ?? body.uid, body.password);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				accessToken: result.token,
				uid: result.gameUserId || result.loginId,
				loginId: result.loginId,
				gameUserId: result.gameUserId,
				account: {
					uid: result.gameUserId || result.loginId,
					loginId: result.loginId,
					gameUserId: result.gameUserId,
					passwordLoginEnabled: true
				}
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (message === "登录号或密码错误。") apiError(ctx, 401, message);
			else if (message === "请求格式无效。" || message === "请求体过大。") apiError(ctx, 400, message);
			else {
				console.error("[app-api/login] unexpected failure:", error);
				apiError(ctx, 503, "登录服务暂时不可用，请稍后重试。");
			}
		}
	});
	router.post(apiPath("/password/set"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			if (String(body.newPassword ?? "") !== String(body.passwordConfirmation ?? "")) {
				apiError(ctx, 400, "两次密码不一致。");
				return;
			}
			const result = await setAppPasswordByPlayerId(session.playerId, body.newPassword);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				accessToken: result.token,
				uid: session.gameUserId || session.loginId,
				loginId: session.loginId,
				gameUserId: session.gameUserId,
				passwordLoginEnabled: true,
				passwordUpdatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "设置密码失败。");
		}
	});
	router.post(apiPath("/password/change"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			if (String(body.newPassword ?? "") !== String(body.passwordConfirmation ?? "")) {
				apiError(ctx, 400, "两次密码不一致。");
				return;
			}
			const result = await changeAppPasswordByPlayerId(session.playerId, body.currentPassword, body.newPassword);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				accessToken: result.token,
				uid: session.gameUserId || session.loginId,
				loginId: session.loginId,
				gameUserId: session.gameUserId,
				passwordLoginEnabled: true,
				passwordUpdatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "修改密码失败。");
		}
	});
	router.post(apiPath("/logout"), async (ctx) => {
		if (!secureRequest(ctx)) {
			apiError(ctx, 404, "未找到接口。");
			return;
		}
		const token = bearer(ctx);
		if (!token) {
			apiError(ctx, 401, "缺少访问令牌。");
			return;
		}
		await logoutAppSession(token);
		ctx.type = "application/json";
		ctx.body = { ok: true };
	});
	/**
	* H5 命令目录：只返回服务端明确允许公开的玩家命令。
	* 管理、测试、调试和隐藏剧情命令不会从这里暴露，前端也不需要扫描
	* 机器人路由来推断可用能力。
	*/
	router.get(apiPath("/command-catalog"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const qqUserId = await appSessionQqUser(session);
			const character = await getCharacter(qqUserId);
			const appCommands = appCommandCatalogFor(Boolean(character)).filter((command) => apiPrefix !== "/api/web/v1" || !webSkillWriteCommand(command.command));
			const appCommandNames = new Set(appCommands.flatMap((command) => [command.command, ...command.aliases ?? []]));
			const coreCommands = listCoreCommandCatalog().filter((command) => !appCommandNames.has(command.command) && !(apiPrefix === "/api/web/v1" && webProtectedWriteCommand(command.command))).map((command) => ({
				...command,
				enabled: !command.requiresCharacter || Boolean(character),
				...command.requiresCharacter && !character ? { reason: "请先完成角色注册。" } : {}
			}));
			const coreCategories = [...new Set(coreCommands.map((command) => command.category))].filter((category) => !appCommandCategories.some((item) => item.id === category)).map((category) => ({
				id: category,
				title: category
			}));
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				version: 1,
				categories: [...appCommandCategories, ...coreCategories],
				commands: [...appCommands, ...coreCommands],
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "读取命令目录失败。");
		}
	});
	/**
	* 结构化命令入口。只接受目录中的 commandId，写操作默认先生成一次性
	* 预览凭据，确认时才把命令交给真实 Router，避免网页按钮直接执行消耗型操作。
	*/
	router.post(apiPath("/command/action"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			const commandId = String(body.commandId ?? "").trim();
			const appEntry = findAppCommandById(commandId);
			const coreEntry = listCoreCommandCatalog().find((entry) => entry.id === commandId);
			const protectedEntry = appEntry ?? coreEntry;
			if (apiPrefix === "/api/web/v1" && protectedEntry && webProtectedWriteCommand(protectedEntry.command)) {
				apiError(ctx, 400, webProtectedWriteMessage(protectedEntry.command));
				return;
			}
			const entry = appEntry ?? coreEntry;
			if (!entry) {
				apiError(ctx, 400, "网页端不支持此命令。");
				return;
			}
			const qqUserId = await appSessionQqUser(session);
			if (entry.requiresCharacter && !await getCharacter(qqUserId)) {
				apiError(ctx, 400, "请先完成角色注册。");
				return;
			}
			const parsed = actionValues(entry, body.args);
			if (parsed.error || !parsed.values) {
				apiError(ctx, 400, parsed.error ?? "命令参数无效。");
				return;
			}
			const command = actionCommand(entry, parsed.values);
			const mode = String(body.mode ?? (entry.readOnly ? "execute" : "preview"));
			cleanupPendingCommandActions();
			if (!entry.readOnly && mode !== "confirm") {
				if (mode === "execute") {
					apiError(ctx, 400, "该操作需要先预览，再点击确认执行。");
					return;
				}
				const confirmToken = randomUUID();
				pendingCommandActions.set(confirmToken, {
					playerId: session.playerId,
					commandId,
					command,
					expiresAt: Date.now() + pendingActionTtl
				});
				ctx.type = "application/json";
				ctx.body = {
					ok: true,
					commandId,
					preview: `将执行：${command}`,
					confirmToken,
					expiresIn: Math.floor(pendingActionTtl / 1e3),
					refresh: entry.refresh ?? []
				};
				return;
			}
			if (!entry.readOnly) {
				const confirmToken = String(body.token ?? "").trim();
				const pending = pendingCommandActions.get(confirmToken);
				if (!pending || pending.playerId !== session.playerId || pending.commandId !== commandId || pending.command !== command || pending.expiresAt <= Date.now()) {
					if (confirmToken) pendingCommandActions.delete(confirmToken);
					apiError(ctx, 400, "确认凭据无效或已过期，请重新获取预览。");
					return;
				}
				pendingCommandActions.delete(confirmToken);
			}
			if (coreEntry ?? (commandId === "story.register" || apiPrefix === "/api/web/v1" && coreWindowCommand(command) ? coreEntryForRawCommand(command) : void 0)) {
				const execution = await executeCoreGameCommand({
					requestId: `web-action:${randomUUID()}`,
					actor: {
						provider: "app",
						subject: qqUserId,
						displayName: session.displayName
					},
					conversation: {
						scope: "private",
						id: qqUserId
					},
					command,
					source: "message"
				});
				if (!execution.matched) {
					apiError(ctx, 400, "本体命令当前不可用。");
					return;
				}
				const signed = await signedCoreResponse(session, bearer(ctx), command, execution, apiPrefix === "/api/web/v1");
				ctx.type = "application/json";
				ctx.body = {
					ok: true,
					commandId,
					...signed,
					refresh: entry.refresh ?? []
				};
				return;
			}
			const result = await executeAppCommand({
				qqUserId,
				command
			});
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				commandId,
				command,
				...result,
				...coreInteractionPresentation(command, [result.format]),
				refresh: entry.refresh ?? [],
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "命令执行失败。");
		}
	});
	router.post(apiPath("/command"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			const command = String(body.command ?? "").trim();
			if (!command) {
				apiError(ctx, 400, "缺少命令。");
				return;
			}
			if (command.length > 4096 || /[\r\n]/.test(command)) {
				apiError(ctx, 400, "命令内容无效。");
				return;
			}
			if (apiPrefix === "/api/web/v1" && webProtectedWriteCommand(command)) {
				apiError(ctx, 400, webProtectedWriteMessage(command));
				return;
			}
			const qqUserId = await appSessionQqUser(session);
			if (!isAppCommandAllowed(command) || command.replace(/^\/+/, "") === "注册" || apiPrefix === "/api/web/v1" && coreWindowCommand(command)) {
				const coreEntry = coreEntryForRawCommand(command);
				if (!coreEntry) {
					apiError(ctx, 400, "网页端暂不支持此命令。");
					return;
				}
				if (apiPrefix === "/api/web/v1" && webProtectedWriteCommand(coreEntry.command)) {
					apiError(ctx, 400, webProtectedWriteMessage(coreEntry.command));
					return;
				}
				if (coreEntry.requiresCharacter && !await getCharacter(qqUserId)) {
					apiError(ctx, 400, "请先完成角色注册。");
					return;
				}
				const execution = await executeCoreGameCommand({
					requestId: `web-command:${randomUUID()}`,
					actor: {
						provider: "app",
						subject: qqUserId,
						displayName: session.displayName
					},
					conversation: {
						scope: "private",
						id: qqUserId
					},
					command,
					source: "message"
				});
				if (!execution.matched) {
					apiError(ctx, 400, "本体命令当前不可用。");
					return;
				}
				const signed = await signedCoreResponse(session, bearer(ctx), command, execution, apiPrefix === "/api/web/v1");
				ctx.type = "application/json";
				ctx.body = {
					ok: true,
					...signed,
					refresh: coreEntry.refresh ?? []
				};
				return;
			}
			const result = await executeAppCommand({
				qqUserId,
				command
			});
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				...result,
				...coreInteractionPresentation(command, [result.format]),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "命令执行失败。");
		}
	});
	/** 只接受当前 Core 结果签发的 actionId；网页不能提交隐藏命令文本。 */
	router.post(apiPath("/interactions/actions"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			const issued = await executeIssuedCoreInteractionAction({
				session,
				sessionToken: bearer(ctx),
				actionId: String(body.actionId ?? ""),
				revision: String(body.revision ?? ""),
				idempotencyKey: String(body.idempotencyKey ?? ""),
				blockWebProtectedWrites: apiPrefix === "/api/web/v1"
			});
			const first = issued.messages[0] ?? {
				text: "操作已完成。",
				buttons: []
			};
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				...first,
				...issued,
				refresh: [
					"summary",
					"nearby",
					"story",
					"battle",
					"inventory",
					"equipment",
					"skills"
				]
			};
		} catch (error) {
			if (error instanceof CoreInteractionActionError) {
				ctx.status = error.status;
				ctx.type = "application/json";
				ctx.body = {
					ok: false,
					code: error.code,
					message: error.message
				};
			} else apiError(ctx, 400, error instanceof Error ? error.message : "互动执行失败。");
		}
	});
	router.get(apiPath("/panel"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		ctx.type = "application/json";
		ctx.body = {
			ok: true,
			...await appQuickPanel(session)
		};
	});
	/**
	* H5 自动战斗设置。网页弹窗直接复用 game/auto-battle.service 的校验与事务，
	* 不把设置复制到网页数据库，也不绕过战斗中的装备锁定规则。
	*/
	router.get(apiPath("/auto-battle/config"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const qqUserId = await appSessionQqUser(session);
			const config = await autoBattleConfig(qqUserId, autoBattleMode(ctx.query?.mode));
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				...autoBattleView(config)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "读取自动战斗设置失败。");
		}
	});
	router.get(apiPath("/auto-battle/skills"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const qqUserId = await appSessionQqUser(session);
			const page = Math.max(1, Number(ctx.query?.page ?? 1) || 1);
			const keyword = String(ctx.query?.keyword ?? "").trim();
			const mode = ctx.query?.mode === "pvp" ? "pvp" : "pve";
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				...await autoBattleSkills(qqUserId, page, keyword, mode)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "读取自动战斗技能失败。");
		}
	});
	router.get(apiPath("/auto-battle/potions"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const qqUserId = await appSessionQqUser(session);
			const page = Math.max(1, Number(ctx.query?.page ?? 1) || 1);
			const keyword = String(ctx.query?.keyword ?? "").trim();
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				...await autoPotionItems(qqUserId, page, keyword)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "读取自动药剂失败。");
		}
	});
	router.post(apiPath("/auto-battle/settings"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			const qqUserId = await appSessionQqUser(session);
			const mode = autoBattleMode(body.mode);
			const operation = String(body.operation ?? "").trim();
			if (operation === "enabled") await setAutoBattleEnabled(qqUserId, Boolean(body.enabled), mode);
			else if (operation === "potion") await setAutoPotionEnabled(qqUserId, Boolean(body.enabled), mode);
			else if (operation === "threshold") {
				const kind = String(body.kind ?? "").toLowerCase() === "mp" ? "mp" : "hp";
				await setAutoPotionThreshold(qqUserId, kind, Number(body.threshold), mode);
			} else if (operation === "potion-item") {
				const kind = String(body.kind ?? "").toLowerCase() === "mp" ? "mp" : "hp";
				const raw = body.itemId === null || body.itemId === void 0 || body.itemId === "" ? null : Number(body.itemId);
				await setAutoPotionItem(qqUserId, kind, raw === null || !Number.isFinite(raw) ? null : raw, mode);
			} else if (operation === "default-action") {
				if (mode !== "pve") throw new Error("PVP 不使用默认遇敌决策。");
				await toggleAutoBattleEncounterAction(qqUserId);
			} else throw new Error("未知的自动战斗设置操作。");
			const config = await autoBattleConfig(qqUserId, mode);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				...autoBattleView(config),
				refresh: ["summary", "autoBattle"]
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "保存自动战斗设置失败。");
		}
	});
	router.post(apiPath("/auto-battle/actions"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			const qqUserId = await appSessionQqUser(session);
			const sequence = Number(body.sequence);
			const rawSkill = body.skillId === null || body.skillId === void 0 || body.skillId === "" ? null : Number(body.skillId);
			const skillId = rawSkill === null || !Number.isFinite(rawSkill) || rawSkill === 0 ? null : rawSkill;
			const mode = autoBattleMode(body.mode);
			await saveAutoBattleAction(qqUserId, sequence, skillId, mode);
			const config = await autoBattleConfig(qqUserId, mode);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				...autoBattleView(config),
				refresh: ["summary", "autoBattle"]
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "保存自动出招失败。");
		}
	});
	router.delete(apiPath("/auto-battle/actions/:sequence"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const qqUserId = await appSessionQqUser(session);
			const sequence = Number(ctx.params.sequence);
			const mode = autoBattleMode(ctx.query?.mode);
			await deleteAutoBattleAction(qqUserId, sequence, mode);
			const config = await autoBattleConfig(qqUserId, mode);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				...autoBattleView(config),
				refresh: ["summary", "autoBattle"]
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "删除自动出招失败。");
		}
	});
	/**
	* 探索方格的即时移动。与 /command 中的“前往坐标”分开，避免网页点击
	* 近处格子时误创建远距离计时行程；具体通行、感知、遭遇和队伍规则由
	* adventure.service 的 moveToLocalCoordinate 统一执行。
	*/
	router.post(apiPath("/explore/move"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			const x = Number(body.x);
			const y = Number(body.y);
			const z = Number(body.z);
			if (![
				x,
				y,
				z
			].every(Number.isInteger)) {
				apiError(ctx, 400, "目标坐标必须是三个整数（x、y、z）。");
				return;
			}
			const qqUserId = await appSessionQqUser(session);
			const { moveToLocalCoordinate, battleStatus } = await import("../game/adventure.service.js");
			const { openingStatus, beginOpening } = await import("../game/opening.service.js");
			const opening = apiPrefix === "/api/web/v1" ? await openingStatus(qqUserId) : null;
			if (opening && opening.state !== "completed") {
				if (!(await battleStatus(qqUserId).catch(() => null))?.targets?.length) {
					if (opening.state === "armed") await beginOpening(qqUserId, "move");
					const command = "/注册";
					const execution = await executeCoreGameCommand({
						requestId: `web-opening:${randomUUID()}`,
						actor: {
							provider: "app",
							subject: qqUserId,
							displayName: session.displayName
						},
						conversation: {
							scope: "private",
							id: qqUserId
						},
						command,
						source: "message"
					});
					const signed = await signedCoreResponse(session, bearer(ctx), command, execution, apiPrefix === "/api/web/v1");
					const panel = await appQuickPanel(session);
					ctx.type = "application/json";
					ctx.body = {
						ok: true,
						...signed,
						kind: "story",
						presentation: "story",
						...panel.summary?.position ? { position: panel.summary.position } : {},
						panel,
						refresh: [
							"summary",
							"story",
							"nearby"
						]
					};
					return;
				}
			}
			const result = await moveToLocalCoordinate(qqUserId, x, y, z);
			const targets = Array.isArray(result.targets) ? result.targets.map((target) => ({
				type: String(target.type),
				id: String(target.id),
				name: String(target.name),
				description: String(target.description ?? "")
			})) : void 0;
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				kind: String(result.kind ?? "event"),
				text: String(result.text ?? "你移动到了目标位置。"),
				position: {
					x,
					y,
					z
				},
				...targets ? { interactionTargets: targets } : {},
				panel: await appQuickPanel(session),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "移动失败。");
		}
	});
	/** H5 采集入口。网页直接提交资源出生实例 ID，避免把物品 code 误当成资源编号。 */
	router.post(apiPath("/explore/mine"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			const resourceId = Number(body.resourceId);
			if (!Number.isSafeInteger(resourceId) || resourceId <= 0) {
				apiError(ctx, 400, "缺少有效的资源编号。");
				return;
			}
			const qqUserId = await appSessionQqUser(session);
			const { mineResource } = await import("../game/adventure.service.js");
			const result = await mineResource(qqUserId, resourceId);
			const stateText = result.state === "started" ? "已开始" : result.state === "mining" ? "正在" : "已完成";
			const text = result.state === "completed" ? `采集结算：${result.rewardText || "本轮没有新的产出。"}` : `${stateText}采集【${result.name}】（${result.kind}），每轮约 ${result.seconds ?? 0} 秒，本轮剩余 ${result.remaining ?? 0} 秒。同坐标资源会自动连续采集。`;
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				kind: result.state,
				text,
				resourceId,
				panel: await appQuickPanel(session),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "无法开始采集。");
		}
	});
	/**
	* H5 遭遇战入口：移动到感知范围内的怪物后，只有玩家明确点击“攻击”
	* 才会锁定目标并创建战斗。这里不读取自动战斗配置，也不代替玩家提交
	* 第一回合行动；战斗面板由返回的 panel.battle 驱动。
	*/
	router.post(apiPath("/battle/start"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			const spawnId = Number(body.spawnId);
			if (!Number.isSafeInteger(spawnId) || spawnId <= 0) {
				apiError(ctx, 400, "缺少有效的怪物编号。");
				return;
			}
			const qqUserId = await appSessionQqUser(session);
			const { moveToNearbyMonster, chooseTarget } = await import("../game/adventure.service.js");
			await moveToNearbyMonster(qqUserId, spawnId);
			await chooseTarget(qqUserId, spawnId);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				kind: "battle_started",
				text: "已进入战斗，请选择本回合行动。",
				panel: await appQuickPanel(session),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "无法开始战斗。");
		}
	});
	/** 战斗目标与动作同次提交，快捷道具参数始终是栏位而不是物品 ID。 */
	router.post(apiPath("/battle/actions"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			const sessionId = String(body.sessionId ?? "").trim();
			const turn = Number(body.turn);
			const bonusPhase = body.bonusPhase;
			const action = String(body.action ?? "").trim();
			const actions = /* @__PURE__ */ new Set([
				"attack",
				"defend",
				"escape",
				"skill",
				"item",
				"device",
				"anchor"
			]);
			const slot = body.slot === void 0 ? void 0 : Number(body.slot);
			const skillId = body.skillId === void 0 ? void 0 : Number(body.skillId);
			const deviceSkillCode = body.deviceSkillCode === void 0 ? void 0 : String(body.deviceSkillCode);
			const targetInput = body.target;
			const target = targetInput && typeof targetInput === "object" && !Array.isArray(targetInput) ? {
				kind: String(targetInput.kind),
				id: Number(targetInput.id)
			} : void 0;
			if (!(/^[0-9a-f-]{36}$/i.test(sessionId) && Number.isSafeInteger(turn) && turn > 0 && typeof bonusPhase === "boolean" && actions.has(action) && (slot === void 0 || Number.isSafeInteger(slot) && slot >= 1 && slot <= 4) && (skillId === void 0 || Number.isSafeInteger(skillId) && skillId > 0) && (deviceSkillCode === void 0 || /^[a-z0-9_]+$/.test(deviceSkillCode)) && (targetInput === void 0 || target !== void 0 && (target.kind === "member" || target.kind === "target") && Number.isSafeInteger(target.id) && target.id > 0) && (action !== "attack" || target?.kind === "target") && (action !== "skill" || slot !== void 0 !== (skillId !== void 0)) && (action !== "item" || slot !== void 0) && (action !== "device" || slot !== void 0))) {
				ctx.status = 400;
				ctx.type = "application/json";
				ctx.body = {
					ok: false,
					code: "BATTLE_ACTION_INVALID",
					message: "战斗动作参数无效，请刷新战斗状态后重试。"
				};
				return;
			}
			const qqUserId = await appSessionQqUser(session);
			const { submitWebBattleAction } = await import("../game/adventure.service.js");
			const result = await submitWebBattleAction(qqUserId, {
				sessionId,
				turn,
				bonusPhase,
				action,
				slot,
				skillId,
				deviceSkillCode,
				target
			});
			const text = String(("manualLog" in result ? result.manualLog : void 0) ?? result.log ?? (result.waiting ? "已提交行动，等待队友。" : "行动已完成。"));
			const panel = await appQuickPanel(session).catch(() => null);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				kind: "battle_action",
				text,
				log: text,
				ended: Boolean(result.ended),
				waiting: Boolean(result.waiting),
				...panel ? { panel } : {},
				refresh: [
					"summary",
					"battle",
					"inventory",
					"skills"
				],
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			const { BattleActionStaleError } = await import("../game/adventure.service.js");
			ctx.status = error instanceof BattleActionStaleError ? 409 : 400;
			ctx.type = "application/json";
			ctx.body = {
				ok: false,
				code: error instanceof BattleActionStaleError ? error.code : "BATTLE_ACTION_FAILED",
				message: error instanceof Error ? error.message : "战斗动作失败，请刷新战斗状态。"
			};
		}
	});
	/** H5 遇战中的躲避操作，复用 QQ 端 encounterAction 的感知、速度与退回规则。 */
	router.post(apiPath("/encounter/avoid"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			const spawnId = Number(body.spawnId);
			if (!Number.isSafeInteger(spawnId) || spawnId <= 0) {
				apiError(ctx, 400, "缺少有效的怪物编号。");
				return;
			}
			const qqUserId = await appSessionQqUser(session);
			const { encounterAction } = await import("../game/adventure.service.js");
			const text = await encounterAction(qqUserId, spawnId, "avoid");
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				kind: "avoided",
				text,
				spawnId,
				panel: await appQuickPanel(session),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "无法躲避当前遭遇。");
		}
	});
	/**
	* H5 交涉入口。交涉状态、版本、背包筛选和战斗转场全部复用本体
	* negotiateEncounter，网页只负责展示返回的 negotiation 数据。
	*/
	router.post(apiPath("/negotiation"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			const spawnId = Number(body.spawnId);
			if (!Number.isSafeInteger(spawnId) || spawnId <= 0) {
				apiError(ctx, 400, "缺少有效的怪物编号。");
				return;
			}
			const rawType = String(body.type ?? "view");
			const type = [
				"view",
				"talk",
				"gift",
				"leave",
				"fight"
			].includes(rawType) ? rawType : null;
			if (!type) {
				apiError(ctx, 400, "不支持的交涉操作。");
				return;
			}
			const qqUserId = await appSessionQqUser(session);
			const { negotiateEncounter } = await import("../game/adventure.service.js");
			const negotiation = await negotiateEncounter(qqUserId, spawnId, {
				type,
				...body.sessionId ? { sessionId: String(body.sessionId) } : {},
				...body.revision !== void 0 ? { revision: Number(body.revision) } : {},
				...body.itemId !== void 0 ? { itemId: Number(body.itemId) } : {},
				...body.quantity !== void 0 ? { quantity: Number(body.quantity) } : {},
				...body.page !== void 0 ? { page: Number(body.page) } : {},
				...body.keyword !== void 0 ? { keyword: String(body.keyword) } : {}
			});
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				kind: negotiation.kind,
				text: negotiation.text,
				negotiation,
				panel: await appQuickPanel(session),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "交涉暂时无法继续。");
		}
	});
	/** 队伍地图侧栏已经完成一次明确确认后，规划并启动跨区域路线。 */
	router.post(apiPath("/explore/travel"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			const x = Number(body.x);
			const y = Number(body.y);
			const z = Number(body.z);
			if (![
				x,
				y,
				z
			].every(Number.isInteger)) {
				apiError(ctx, 400, "目标坐标必须是三个整数（x、y、z）。");
				return;
			}
			const qqUserId = await appSessionQqUser(session);
			const { moveTo } = await import("../game/adventure.service.js");
			const planned = await moveTo(qqUserId, x, y, z);
			const result = planned?.kind === "travel_confirmation" ? await moveTo(qqUserId, x, y, z, { confirmationToken: String(planned.token) }) : planned;
			if (result?.kind === "travel_confirmation") {
				apiError(ctx, 409, "路线在确认时发生变化，请重新点击前往。");
				return;
			}
			const panel = await appQuickPanel(session).catch(() => null);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				kind: String(result?.kind ?? "travel"),
				text: result?.kind === "travel" ? `已开始前往${result.destinationName ?? result.regionName ?? "目标区域"}，预计 ${result.seconds} 秒。` : String(result?.text ?? "路线已安排。"),
				position: {
					x,
					y,
					z
				},
				remaining: Number(result?.remaining ?? result?.seconds ?? 0),
				panel,
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "前往失败。");
		}
	});
	/** H5 行程面板的停止操作，复用本体的事务与操作记录。 */
	router.post(apiPath("/explore/travel/cancel"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const qqUserId = await appSessionQqUser(session);
			const { cancelTravel } = await import("../game/adventure.service.js");
			const cancelled = await cancelTravel(qqUserId);
			const panel = await appQuickPanel(session).catch(() => null);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				kind: "cancelled",
				text: cancelled.activityType === "hunt" ? "寻怪已取消。" : "移动已取消。",
				panel,
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "停止行程失败。");
		}
	});
	/** H5 没有 QQ 消息计时器；到期时由客户端触发服务层原有的幂等抵达结算。 */
	router.post(apiPath("/explore/travel/settle"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const qqUserId = await appSessionQqUser(session);
			const { completeTravel, travelStatus } = await import("../game/adventure.service.js");
			const result = await completeTravel(qqUserId);
			const pending = result ? null : await travelStatus(qqUserId);
			const panel = await appQuickPanel(session).catch(() => null);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				kind: result?.kind ?? (pending ? "pending" : "idle"),
				text: result ? String(result.text ?? "已抵达目的地。") : pending ? "行程仍在进行中。" : "当前没有待结算的行程。",
				remaining: pending?.remaining ?? 0,
				panel,
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "行程结算失败。");
		}
	});
	router.get(apiPath("/realtime-ticket"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		ctx.type = "application/json";
		ctx.body = {
			ok: true,
			ticket: issueRealtimeTicket(session, bearer(ctx)),
			expiresIn: 60
		};
	});
	router.get(apiPath("/mail/unread"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				unreadCount: await countUnreadGameMails(session.playerId)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "读取未读邮件失败。");
		}
	});
	router.get(apiPath("/mail"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const beforeId = ctx.query?.beforeId;
			const page = await listGameMails(session.playerId, {
				limit: Number(ctx.query?.limit ?? 20),
				...beforeId === void 0 ? {} : { beforeId: Number(beforeId) },
				filter: String(ctx.query?.filter ?? "all")
			});
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				...page
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "读取邮件失败。");
		}
	});
	router.get(apiPath("/mail/:id"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const detail = await gameMailDetail(session.playerId, Number(ctx.params.id));
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				...detail
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "读取邮件详情失败。");
		}
	});
	router.post(apiPath("/mail/:id/claim"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const id = Number(ctx.params.id);
			if (!Number.isSafeInteger(id) || id <= 0) throw new Error("邮件编号无效。");
			const result = await claimMail(await appSessionQqUser(session), id);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				...result,
				unreadCount: await countUnreadGameMails(session.playerId)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "领取邮件附件失败。");
		}
	});
	router.post(apiPath("/mail/claim-all"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const result = await claimAllMails(await appSessionQqUser(session));
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				...result,
				unreadCount: await countUnreadGameMails(session.playerId)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "一键领取邮件附件失败。");
		}
	});
	router.delete(apiPath("/mail/:id"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const id = Number(ctx.params.id);
			if (!Number.isSafeInteger(id) || id <= 0) throw new Error("邮件编号无效。");
			await deleteMail(await appSessionQqUser(session), id);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				unreadCount: await countUnreadGameMails(session.playerId)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "删除邮件失败。");
		}
	});
	router.get(apiPath("/notifications/unread"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				unreadCount: await countUnreadWebNotifications(session.playerId)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "读取未读通知失败。");
		}
	});
	router.get(apiPath("/notifications/changes"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const afterId = Number(ctx.query?.afterId ?? 0);
			const limit = Math.max(1, Math.min(100, Math.floor(Number(ctx.query?.limit ?? 100) || 100)));
			const items = await listWebNotificationsAfter(session.playerId, afterId, limit);
			const nextAfterId = items[items.length - 1]?.id ?? afterId;
			const hasMore = items.length === limit && (await listWebNotificationsAfter(session.playerId, nextAfterId, 1)).length > 0;
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				items,
				unreadCount: await countUnreadWebNotifications(session.playerId),
				nextAfterId,
				hasMore
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "补拉通知失败。");
		}
	});
	router.get(apiPath("/notifications"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const before = ctx.query?.beforeId ?? ctx.query?.cursor;
			const page = await listWebNotifications(session.playerId, {
				limit: Number(ctx.query?.limit ?? 20),
				...before === void 0 ? {} : { beforeId: Number(before) }
			});
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				...page
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "读取通知失败。");
		}
	});
	router.post(apiPath("/notifications/read"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			const updated = body.all === true ? await markAllWebNotificationsRead(session.playerId) : await markWebNotificationsRead(session.playerId, body.ids);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				updated,
				unreadCount: await countUnreadWebNotifications(session.playerId)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "标记通知已读失败。");
		}
	});
	router.post(apiPath("/notifications/:id/read"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const updated = await markWebNotificationsRead(session.playerId, [Number(ctx.params.id)]);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				updated,
				unreadCount: await countUnreadWebNotifications(session.playerId)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "标记通知已读失败。");
		}
	});
	router.get(apiPath("/chat/channels"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				channels: await listChatChannels(session)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "读取聊天频道失败。");
		}
	});
	router.get(apiPath("/chat/channels/:channelId/messages"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const limit = Math.max(1, Math.min(100, Math.floor(Number(ctx.query?.limit ?? 20) || 20)));
			const beforeId = ctx.query?.beforeId;
			const fetched = await listChatMessages(session, String(ctx.params.channelId ?? ""), limit + 1, beforeId);
			const hasMore = fetched.length > limit;
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				messages: hasMore ? fetched.slice(-limit) : fetched,
				hasMore
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "读取聊天记录失败。");
		}
	});
	router.post(apiPath("/chat/channels/:channelId/messages"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				message: await sendChatMessage(session, String(ctx.params.channelId ?? ""), body.content)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "发送消息失败。");
		}
	});
	router.get(apiPath("/social/summary"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		if (!session.characterId) {
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				friends: [],
				friendRequests: [],
				oath: null,
				oathRequests: [],
				oathReleaseRequests: []
			};
			return;
		}
		try {
			const qqUserId = await appSessionQqUser(session);
			const [friends, incomingFriends, oath, incomingOaths, incomingReleases] = await Promise.all([
				friendList(qqUserId),
				friendRequests(qqUserId),
				oathStatus(qqUserId),
				oathRequests(qqUserId),
				oathReleaseRequests(qqUserId)
			]);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				friends: friends.map((item) => ({
					name: String(item.name),
					gameId: Number(item.game_id),
					status: String(item.status),
					affinity: Number(item.affinity),
					stage: String(item.stage?.title ?? item.stage)
				})),
				friendRequests: incomingFriends.map((item) => ({
					id: Number(item.id),
					name: String(item.name),
					gameId: Number(item.game_id),
					createdAt: new Date(item.created_at).toISOString()
				})),
				oath: oath ? {
					id: Number(oath.id),
					name: String(oath.name),
					gameId: Number(oath.game_id),
					status: String(oath.status),
					affinity: Number(oath.affinity),
					stage: String(oath.stage?.title ?? oath.stage)
				} : null,
				oathRequests: incomingOaths.map((item) => ({
					id: Number(item.id),
					name: String(item.name),
					gameId: Number(item.game_id),
					affinity: Number(item.affinity),
					stage: String(item.stage?.title ?? item.stage),
					expiresAt: new Date(item.expires_at).toISOString()
				})),
				oathReleaseRequests: incomingReleases.map((item) => ({
					id: Number(item.id),
					name: String(item.name),
					gameId: Number(item.game_id),
					expiresAt: new Date(item.expires_at).toISOString()
				}))
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "读取社交摘要失败。");
		}
	});
	router.get(apiPath("/party/current"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				party: await currentWebParty(session)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "读取当前队伍失败。");
		}
	});
	router.post(apiPath("/party/create"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				party: await createWebParty(session, body)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "创建队伍失败。");
		}
	});
	router.post(apiPath("/party/leave"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				party: await leaveWebParty(session)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "退出队伍失败。");
		}
	});
	router.post(apiPath("/party/rename"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				party: await renameWebParty(session, body.name)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "修改队伍名失败。");
		}
	});
	router.get(apiPath("/party/search"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const page = await searchPartyRecruitments(session, ctx.query);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				parties: page.recruitments,
				...page
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "搜索队伍失败。");
		}
	});
	router.get(apiPath("/party/recruitments"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const page = await searchPartyRecruitments(session, ctx.query);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				...page
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "读取队伍招募失败。");
		}
	});
	router.post(apiPath("/party/recruitments"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				recruitment: await createPartyRecruitment(session, body)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "发布队伍招募失败。");
		}
	});
	router.post(apiPath("/party/recruitments/:id/apply"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				application: await applyPartyRecruitment(session, ctx.params.id, body.message)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "申请加入队伍失败。");
		}
	});
	router.post(apiPath("/party/recruitments/:id/applications"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				application: await applyPartyRecruitment(session, ctx.params.id, body.message)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "申请加入队伍失败。");
		}
	});
	router.get(apiPath("/party/recruitments/:id/applications"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				applications: await listPartyApplications(session, ctx.params.id)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "读取入队申请失败。");
		}
	});
	router.post(apiPath("/party/applications/:id/accept"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				application: await acceptPartyApplication(session, ctx.params.id)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "同意入队申请失败。");
		}
	});
	router.post(apiPath("/party/applications/:id/reject"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.type = "application/json";
			ctx.body = {
				ok: true,
				application: await rejectPartyApplication(session, ctx.params.id)
			};
		} catch (error) {
			apiError(ctx, 400, error instanceof Error ? error.message : "拒绝入队申请失败。");
		}
	});
	if (apiPrefix === "/api/web/v1") registerHandbookRoutes(router, {
		apiPath,
		requireSession,
		parseBody,
		apiError
	});
};

//#endregion
export { registerAppApiRoutes };