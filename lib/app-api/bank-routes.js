import { appSessionQqUser } from "../game/app-channel.service.js";
import { bankDepositAtBuilding, bankSummaryAtBuilding, depositProducts } from "../game/finance.service.js";
import { BANK_ACTIONS, BANK_TARGET_ID, confirmBankAction, previewBankAction } from "./bank.service.js";

//#region src/app-api/bank-routes.ts
const positiveInteger = (value, label) => {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label}必须是正整数。`);
	return parsed;
};
const failure = (ctx, error, apiError) => {
	const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
	if (/^(?:ER_|ECONN|PROTOCOL_)/.test(code)) {
		apiError(ctx, 503, "钱庄暂时不可用，请稍后重试。");
		ctx.body = {
			...ctx.body,
			code: "bank_unavailable"
		};
		return;
	}
	const message = error instanceof Error ? error.message : "钱庄暂时不可用。";
	const conflict = /已变化|已取消|已过期|过期|已完成|已经失效/.test(message);
	apiError(ctx, conflict ? 409 : 400, message);
	ctx.body = {
		...ctx.body,
		code: conflict ? "stale_bank_quote" : "bank_request_failed"
	};
};
/** 注册到 H5 前缀，地点入口 id 直接使用地图 map_npcs.code。 */
const registerBankApiRoutes = (router, apiPrefix, dependencies) => {
	const path = (suffix) => `${apiPrefix}/places/${BANK_TARGET_ID}/bank${suffix}`;
	const { requireSession, parseBody, apiError } = dependencies;
	router.get(path(""), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const summary = await bankSummaryAtBuilding(await appSessionQqUser(session));
			const products = Object.entries(depositProducts).map(([code, terms]) => ({
				code,
				name: terms.name,
				days: terms.days,
				basisPoints: terms.basisPoints,
				minCopper: terms.min
			}));
			ctx.body = {
				ok: true,
				target: {
					id: BANK_TARGET_ID,
					name: "银铃钱庄",
					locationRequired: true
				},
				summary,
				products,
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.get(path("/deposits/:id"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.body = {
				ok: true,
				deposit: await bankDepositAtBuilding(await appSessionQqUser(session), positiveInteger(ctx.params.id, "存单编号")),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.post(path("/actions/preview"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			const action = String(body.action ?? "");
			if (!BANK_ACTIONS.includes(action)) throw new Error("请选择有效的钱庄操作。");
			const input = action === "deposit" || action === "withdraw" ? {
				action,
				amount: positiveInteger(body.amount, "金额")
			} : action === "term_open" ? {
				action,
				amount: positiveInteger(body.amount, "本金"),
				productCode: String(body.productCode ?? "")
			} : {
				action,
				depositId: positiveInteger(body.depositId, "存单编号")
			};
			ctx.body = {
				ok: true,
				...await previewBankAction(await appSessionQqUser(session), input),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.post(path("/actions/confirm"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			ctx.body = {
				ok: true,
				result: await confirmBankAction(await appSessionQqUser(session), String(body.token ?? ""), String(body.idempotencyKey ?? "")),
				refresh: [
					"summary",
					"inventory",
					"map",
					"bank"
				],
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
};

//#endregion
export { registerBankApiRoutes };