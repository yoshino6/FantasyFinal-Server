import { appSessionQqUser } from "../game/app-channel.service.js";
import { confirmHomeShopTrade, homeShopOffer, homeShopShelf, previewHomeShopTrade } from "./home-shop.service.js";

//#region src/app-api/home-shop-routes.ts
const positiveInteger = (value, label, max = Number.MAX_SAFE_INTEGER) => {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${label}必须是 1 至 ${max} 之间的整数。`);
	return parsed;
};
const targetId = (value) => {
	const parsed = String(value ?? "");
	if (!/^[a-z0-9_]{1,64}$/.test(parsed)) throw new Error("百纳居目标无效。");
	return parsed;
};
const failure = (ctx, error, apiError) => {
	const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
	if (/^(?:ER_|ECONN|PROTOCOL_)/.test(code)) {
		apiError(ctx, 503, "百纳居暂时不可用，请稍后重试。");
		ctx.body = {
			...ctx.body,
			code: "home_shop_unavailable"
		};
		return;
	}
	const message = error instanceof Error ? error.message : "百纳居暂时不可用。";
	const conflict = /已变化|已失效|已过期|过期|已取消|已完成/.test(message);
	apiError(ctx, conflict ? 409 : 400, message);
	ctx.body = {
		...ctx.body,
		code: conflict ? "stale_home_shop_quote" : "home_shop_request_failed"
	};
};
const registerHomeShopApiRoutes = (router, apiPrefix, dependencies) => {
	const path = (suffix) => `${apiPrefix}/places/:targetId/home-shop${suffix}`;
	const { requireSession, parseBody, apiError } = dependencies;
	router.get(path(""), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.body = {
				ok: true,
				...await homeShopShelf(await appSessionQqUser(session), targetId(ctx.params.targetId)),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.get(path("/offers/:id"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.body = {
				ok: true,
				...await homeShopOffer(await appSessionQqUser(session), targetId(ctx.params.targetId), positiveInteger(ctx.params.id, "报价编号")),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.post(path("/trade/preview"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			ctx.body = {
				ok: true,
				...await previewHomeShopTrade(await appSessionQqUser(session), targetId(ctx.params.targetId), positiveInteger(body.offerId, "报价编号"), positiveInteger(body.quantity ?? 1, "数量", 999)),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.post(path("/trade/confirm"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			ctx.body = {
				ok: true,
				result: await confirmHomeShopTrade(await appSessionQqUser(session), targetId(ctx.params.targetId), String(body.token ?? ""), String(body.idempotencyKey ?? "")),
				refresh: [
					"summary",
					"inventory",
					"map",
					"homeShop"
				],
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
};

//#endregion
export { registerHomeShopApiRoutes };