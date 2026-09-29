import { homeOverview, homePurchaseSite } from "../game/home.service.js";
import { appSessionQqUser } from "../game/app-channel.service.js";
import { confirmHomePurchase, previewHomePurchase } from "./home-purchase.service.js";
import { confirmWebHomeStorageTransfer, previewWebHomeStorageTransfer, webHomeStorageCatalog } from "./home-storage.service.js";

//#region src/app-api/home-routes.ts
const failure = (ctx, error, apiError) => {
	const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
	if (/^(?:ER_|ECONN|PROTOCOL_)/.test(code)) {
		apiError(ctx, 503, "家园暂时不可用，请稍后重试。");
		ctx.body = {
			...ctx.body,
			code: "home_unavailable"
		};
		return;
	}
	const message = error instanceof Error ? error.message : "家园暂时不可用。";
	const conflict = /已变化|已失效|已过期|过期|已取消|已完成/.test(message);
	apiError(ctx, conflict ? 409 : 400, message);
	ctx.body = {
		...ctx.body,
		code: conflict ? "stale_home_quote" : "home_request_failed"
	};
};
const registerHomeApiRoutes = (router, apiPrefix, dependencies) => {
	const path = (suffix) => `${apiPrefix}/home${suffix}`;
	const { requireSession, parseBody, apiError } = dependencies;
	router.get(path(""), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.body = {
				ok: true,
				...await homeOverview(await appSessionQqUser(session)),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.get(path("/floors/:number"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const number = Number(ctx.params.number);
			if (!Number.isSafeInteger(number) || number < 1 || number > 3) throw new Error("楼层编号无效。");
			const overview = await homeOverview(await appSessionQqUser(session));
			if (!overview.home) throw new Error("你还没有小屋。");
			const floor = overview.home.floors.find((item) => item.number === number);
			if (!floor) throw new Error(`第 ${number} 层尚未扩建。`);
			ctx.body = {
				ok: true,
				home: {
					id: overview.home.id,
					name: overview.home.name,
					level: overview.home.level,
					floorCount: overview.home.floorCount,
					location: overview.home.location,
					inHome: overview.home.inHome
				},
				floor,
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.get(path("/purchase-site"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.body = {
				ok: true,
				...await homePurchaseSite(await appSessionQqUser(session)),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.post(path("/purchase/preview"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.body = {
				ok: true,
				...await previewHomePurchase(await appSessionQqUser(session)),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.post(path("/purchase/confirm"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			ctx.body = {
				ok: true,
				result: await confirmHomePurchase(await appSessionQqUser(session), String(body.token ?? ""), String(body.idempotencyKey ?? "")),
				refresh: [
					"summary",
					"inventory",
					"map",
					"home"
				],
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.get(path("/storage"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const scope = String(ctx.query.scope ?? "storage");
			const category = String(ctx.query.category ?? "装备");
			const page = Number(ctx.query.page ?? 1);
			const keyword = String(ctx.query.keyword ?? "");
			if (scope !== "storage" && scope !== "backpack") throw new Error("储物范围无效。");
			if (category !== "装备" && category !== "道具" && category !== "材料") throw new Error("储物分类无效。");
			ctx.body = {
				ok: true,
				...await webHomeStorageCatalog(await appSessionQqUser(session), scope, category, page, keyword),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	for (const side of ["deposit", "withdraw"]) {
		router.post(path(`/storage/${side}/preview`), async (ctx) => {
			const session = await requireSession(ctx);
			if (!session) return;
			try {
				const body = await parseBody(ctx);
				const itemId = Number(body.itemId);
				const quantity = Number(body.quantity);
				if (!Number.isSafeInteger(itemId) || itemId < 1 || !Number.isSafeInteger(quantity) || quantity < 1) throw new Error("物品编号和数量必须为正整数。");
				ctx.body = {
					ok: true,
					...await previewWebHomeStorageTransfer(await appSessionQqUser(session), side, itemId, quantity),
					serverTime: (/* @__PURE__ */ new Date()).toISOString()
				};
			} catch (error) {
				failure(ctx, error, apiError);
			}
		});
		router.post(path(`/storage/${side}/confirm`), async (ctx) => {
			const session = await requireSession(ctx);
			if (!session) return;
			try {
				const body = await parseBody(ctx);
				ctx.body = {
					ok: true,
					result: await confirmWebHomeStorageTransfer(await appSessionQqUser(session), side, String(body.token ?? ""), String(body.idempotencyKey ?? "")),
					refresh: [
						"home",
						"inventory",
						"summary"
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
export { registerHomeApiRoutes };