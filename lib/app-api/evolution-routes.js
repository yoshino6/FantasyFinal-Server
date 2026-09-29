import { appSessionQqUser } from "../game/app-channel.service.js";
import { confirmEvolutionMutation, evolutionMutation, evolutionStatus, previewEvolutionMutation } from "./evolution.service.js";

//#region src/app-api/evolution-routes.ts
const mutationId = (value) => {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("变异记录编号无效。");
	return parsed;
};
const mutationAction = (value) => {
	if (value === "pause" || value === "resume") return value;
	throw new Error("当前网页仅支持暂停或恢复偏差型变异。");
};
const failure = (ctx, error, apiError) => {
	const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
	if (/^(?:ER_|ECONN|PROTOCOL_)/.test(code)) {
		apiError(ctx, 503, "演化档案暂时不可用，请稍后重试。");
		ctx.body = {
			...ctx.body,
			code: "evolution_unavailable"
		};
		return;
	}
	const message = error instanceof Error ? error.message : "演化档案暂时不可用。";
	const conflict = /已变化|已失效|已过期|过期|已取消|已完成/.test(message);
	apiError(ctx, conflict ? 409 : 400, message);
	ctx.body = {
		...ctx.body,
		code: conflict ? "stale_evolution_quote" : "evolution_request_failed"
	};
};
const registerEvolutionApiRoutes = (router, apiPrefix, dependencies) => {
	const path = (suffix) => `${apiPrefix}/evolution${suffix}`;
	const { requireSession, parseBody, apiError } = dependencies;
	router.get(path(""), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.body = {
				ok: true,
				...await evolutionStatus(await appSessionQqUser(session)),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.get(path("/mutations/:id"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.body = {
				ok: true,
				...await evolutionMutation(await appSessionQqUser(session), mutationId(ctx.params.id)),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.post(path("/mutations/:id/preview"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			ctx.body = {
				ok: true,
				...await previewEvolutionMutation(await appSessionQqUser(session), mutationId(ctx.params.id), mutationAction(body.action)),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
	router.post(path("/mutations/confirm"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			ctx.body = {
				ok: true,
				result: await confirmEvolutionMutation(await appSessionQqUser(session), String(body.token ?? ""), String(body.idempotencyKey ?? "")),
				refresh: [
					"summary",
					"evolution",
					"character"
				],
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			failure(ctx, error, apiError);
		}
	});
};

//#endregion
export { registerEvolutionApiRoutes };