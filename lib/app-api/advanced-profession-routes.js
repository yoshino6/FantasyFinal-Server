import { appSessionQqUser } from "../game/app-channel.service.js";
import { appQuickPanel } from "./app-command.service.js";
import { advancedProfessionDetail, advancedProfessionStatus, confirmAdvancedProfessionAction, previewAdvancedProfessionAction } from "./advanced-profession.service.js";
import { startWebAdvancedProfessionTrial } from "./advanced-profession-trial.service.js";

//#region src/app-api/advanced-profession-routes.ts
const professionCode = (value) => {
	const code = String(value ?? "");
	if (!/^[a-z][a-z0-9_]{0,63}$/.test(code)) throw new Error("二转职业编号无效。");
	return code;
};
const actionName = (value) => {
	if (value === "accept" || value === "switch_quest" || value === "submit_story" || value === "submit_proof") return value;
	throw new Error("二转操作无效。");
};
const failure = (ctx, error, apiError) => {
	const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
	if (/^(?:ER_|ECONN|PROTOCOL_)/.test(code)) {
		apiError(ctx, 503, "二转试炼暂时不可用，请稍后重试。");
		ctx.body = {
			...ctx.body,
			code: "advanced_profession_unavailable"
		};
		return;
	}
	const message = error instanceof Error ? error.message : "二转试炼暂时不可用。";
	const conflict = /已变化|已失效|已过期|过期|已取消|已完成/.test(message);
	apiError(ctx, conflict ? 409 : 400, message);
	ctx.body = {
		...ctx.body,
		code: conflict ? "stale_advanced_profession_quote" : "advanced_profession_request_failed"
	};
};
const registerAdvancedProfessionApiRoutes = (router, apiPrefix, dependencies) => {
	const path = (suffix) => `${apiPrefix}/advanced-professions${suffix}`;
	const { requireSession, parseBody, apiError } = dependencies;
	router.get(path(""), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.body = {
				ok: true,
				...await advancedProfessionStatus(await appSessionQqUser(session)),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.get(path("/:code"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.body = {
				ok: true,
				...await advancedProfessionDetail(await appSessionQqUser(session), professionCode(ctx.params.code)),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.post(path("/:code/preview"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			ctx.body = {
				ok: true,
				...await previewAdvancedProfessionAction(await appSessionQqUser(session), professionCode(ctx.params.code), actionName(body.action)),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.post(path("/:code/trial/start"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			const result = await startWebAdvancedProfessionTrial(await appSessionQqUser(session), professionCode(ctx.params.code), String(body.idempotencyKey ?? ""));
			const current = await appQuickPanel(session).catch(() => null);
			const panel = current?.battle?.sessionId === result.sessionId ? current : null;
			ctx.body = {
				ok: true,
				...result,
				panel,
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.post(path("/confirm"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			ctx.body = {
				ok: true,
				result: await confirmAdvancedProfessionAction(await appSessionQqUser(session), String(body.token ?? ""), String(body.idempotencyKey ?? "")),
				refresh: [
					"advanced-professions",
					"character",
					"inventory",
					"map"
				],
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
};

//#endregion
export { registerAdvancedProfessionApiRoutes };