import { appSessionQqUser } from "../game/app-channel.service.js";
import { APPRAISAL_DIRECTIONS, SKILL_ACTIONS, SKILL_SPECIALIZATIONS, confirmSkillAction, previewSkillAction, skillDetailView, skillPage } from "./skill.service.js";

//#region src/app-api/skill-routes.ts
const integer = (value, label, max = Number.MAX_SAFE_INTEGER) => {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${label}必须是 1 至 ${max} 之间的整数。`);
	return parsed;
};
const errorResponse = (ctx, error, apiError) => {
	const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
	if (/^(?:ER_|ECONN|PROTOCOL_)/.test(code)) {
		apiError(ctx, 503, "技能服务暂时不可用，请稍后重试。");
		ctx.body = {
			...ctx.body,
			code: "skill_unavailable"
		};
		return;
	}
	const message = error instanceof Error ? error.message : "技能服务暂时不可用。";
	const conflict = /已变化|已取消|已过期|过期|已失效/.test(message);
	apiError(ctx, conflict ? 409 : 400, message);
	ctx.body = {
		...ctx.body,
		code: conflict ? "stale_skill_quote" : "skill_request_failed"
	};
};
/** H5 角色技能专用接口；QQ 仍沿用原有技能指令。 */
const registerSkillApiRoutes = (router, apiPrefix, dependencies) => {
	const path = (suffix) => `${apiPrefix}${suffix}`;
	const { requireSession, parseBody, apiError } = dependencies;
	router.get(path("/skills"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const view = String(ctx.query.view ?? "learned");
			if (view !== "learned" && view !== "available") throw new Error("不存在该技能列表。");
			const keyword = String(ctx.query.keyword ?? "").trim();
			if (keyword.length > 80) throw new Error("搜索词最多 80 个字符。");
			ctx.body = {
				ok: true,
				...await skillPage(await appSessionQqUser(session), view, integer(ctx.query.page ?? 1, "页码", 1e4), keyword),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			errorResponse(ctx, error, apiError);
		}
	});
	router.get(path("/skills/:id"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			ctx.body = {
				ok: true,
				...await skillDetailView(await appSessionQqUser(session), integer(ctx.params.id, "技能编号")),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			errorResponse(ctx, error, apiError);
		}
	});
	router.post(path("/skills/actions/preview"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			const action = String(body.action ?? "");
			if (!SKILL_ACTIONS.includes(action)) throw new Error("不支持该技能操作。");
			const skillId = integer(body.skillId, "技能编号");
			const specialization = body.specialization == null ? void 0 : String(body.specialization);
			const direction = body.direction == null ? void 0 : String(body.direction);
			if (action === "specialization" && !SKILL_SPECIALIZATIONS.includes(specialization)) throw new Error("请选择有效的专精方向。");
			if (action === "appraisal" && !APPRAISAL_DIRECTIONS.includes(direction)) throw new Error("请选择鉴识方向。");
			const input = {
				action,
				skillId,
				...action === "specialization" ? { specialization } : {},
				...action === "appraisal" ? { direction } : {}
			};
			ctx.body = {
				ok: true,
				...await previewSkillAction(await appSessionQqUser(session), input),
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			errorResponse(ctx, error, apiError);
		}
	});
	router.post(path("/skills/actions/confirm"), async (ctx) => {
		const session = await requireSession(ctx);
		if (!session) return;
		try {
			const body = await parseBody(ctx);
			ctx.body = {
				ok: true,
				result: await confirmSkillAction(await appSessionQqUser(session), String(body.token ?? ""), String(body.idempotencyKey ?? "")),
				refresh: [
					"summary",
					"skills",
					"battle"
				],
				serverTime: (/* @__PURE__ */ new Date()).toISOString()
			};
		} catch (error) {
			errorResponse(ctx, error, apiError);
		}
	});
};

//#endregion
export { registerSkillApiRoutes };