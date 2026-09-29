import { appSessionQqUser } from "../game/app-channel.service.js";
import { confirmGuildShopTrade, guildShopItem, guildShopSellable, guildShopShelf, previewGuildShopTrade } from "./guild-shop.service.js";

//#region src/app-api/guild-shop-routes.ts
const positiveInteger = (value, label, max = Number.MAX_SAFE_INTEGER) => {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${label}必须是 1 至 ${max} 之间的整数。`);
	return parsed;
};
const targetId = (value) => {
	const parsed = String(value ?? "");
	if (!/^[a-z0-9_]{1,64}$/.test(parsed)) throw new Error("公会目标无效。");
	return parsed;
};
const keyword = (value) => {
	const parsed = String(value ?? "").trim();
	if (parsed.length > 80) throw new Error("搜索词最多 80 个字符。");
	return parsed;
};
const failure = (ctx, error, apiError) => {
	const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
	if (/^(?:ER_|ECONN|PROTOCOL_)/.test(code)) {
		apiError(ctx, 503, "公会商店暂时不可用，请稍后重试。");
		ctx.body = {
			...ctx.body,
			code: "guild_shop_unavailable"
		};
		return;
	}
	const message = error instanceof Error ? error.message : "公会商店暂时不可用。";
	const conflict = /已变化|已失效|已过期|过期|已取消|已完成/.test(message);
	apiError(ctx, conflict ? 409 : 400, message);
	ctx.body = {
		...ctx.body,
		code: conflict ? "stale_guild_shop_quote" : "guild_shop_request_failed"
	};
};
const registerGuildShopApiRoutes = (router, apiPrefix, dependencies) => {
	const path = (suffix) => `${apiPrefix}/places/:targetId/guild-shop${suffix}`;
	const { requireSession, parseBody, apiError } = dependencies;
	router.get(path(""), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.body = {
				ok: true,
				...await guildShopShelf(await appSessionQqUser(session), targetId(ctx.params.targetId), positiveInteger(ctx.query.page ?? 1, "页码", 1e5), keyword(ctx.query.keyword)),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.get(path("/items/:id"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.body = {
				ok: true,
				...await guildShopItem(await appSessionQqUser(session), targetId(ctx.params.targetId), positiveInteger(ctx.params.id, "商品编号")),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.get(path("/sellable"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.body = {
				ok: true,
				...await guildShopSellable(await appSessionQqUser(session), targetId(ctx.params.targetId), positiveInteger(ctx.query.page ?? 1, "页码", 1e5), keyword(ctx.query.keyword)),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	for (const side of ["buy", "sell"]) {
		router.post(path(`/${side}/preview`), async (ctx) => {
			const session = await requireSession(ctx);
			if (!session) return;
			try {
				const body = await parseBody(ctx);
				ctx.body = {
					ok: true,
					...await previewGuildShopTrade(await appSessionQqUser(session), targetId(ctx.params.targetId), side, positiveInteger(body.itemId, "商品编号"), positiveInteger(body.quantity ?? 1, "数量", 999)),
					serverTime: (/* @__PURE__ */ new Date()).toISOString()
				};
			} catch (error) {
				failure(ctx, error, apiError);
			}
		});
		router.post(path(`/${side}/confirm`), async (ctx) => {
			const session = await requireSession(ctx);
			if (!session) return;
			try {
				const body = await parseBody(ctx);
				ctx.body = {
					ok: true,
					result: await confirmGuildShopTrade(await appSessionQqUser(session), targetId(ctx.params.targetId), side, String(body.token ?? ""), String(body.idempotencyKey ?? "")),
					refresh: [
						"summary",
						"inventory",
						"map",
						"guildShop"
					],
					serverTime: (/* @__PURE__ */ new Date()).toISOString()
				};
			} catch (error) {
				failure(ctx, error, apiError);
			}
		});
	}
};

//#endregion
export { registerGuildShopApiRoutes };