import { withTransaction } from "../database/pool.js";
import { completeCraftRequest, craftCharacterId, craftRequestFor, createCraftRequest } from "../game/alchemy-journal.service.js";
import { assertCombatLoadoutMutable } from "../game/combat-loadout-lock.service.js";
import { learnSkillInTransaction, skillDetail, skillList, togglePassiveLinkInTransaction, toggleSkillShortcutInTransaction, upgradeAppraisalInTransaction, upgradeSkillInTransaction, upgradeSkillSpecializationInTransaction } from "../game/adventure.service.js";
import { randomUUID } from "node:crypto";

//#region src/app-api/skill.service.ts
const SKILL_PAGE_SIZE = 10;
const SKILL_ACTIONS = [
	"learn",
	"upgrade",
	"specialization",
	"passive_link",
	"shortcut",
	"appraisal"
];
const SKILL_SPECIALIZATIONS = [
	"overcharge",
	"instant",
	"efficient",
	"potent"
];
const APPRAISAL_DIRECTIONS = ["range", "information"];
const requestKind = "web_skill_action";
const quoteMinutes = 2;
const validCredential = (value) => /^[0-9a-f-]{36}$/i.test(value);
const isInfrastructureError = (error) => error && typeof error === "object" && "code" in error && /^(?:ER_|ECONN|PROTOCOL_)/.test(String(error.code));
const integer = (value, label) => {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}必须是正整数。`);
	return value;
};
const actionResult = async (connection, qqUserId, input, preview) => {
	const skillId = integer(input.skillId, "技能编号");
	await assertCombatLoadoutMutable(connection, await craftCharacterId(connection, qqUserId));
	switch (input.action) {
		case "learn": return learnSkillInTransaction(connection, qqUserId, skillId, preview);
		case "upgrade": return upgradeSkillInTransaction(connection, qqUserId, skillId, preview);
		case "passive_link": return togglePassiveLinkInTransaction(connection, qqUserId, skillId, preview);
		case "shortcut": return toggleSkillShortcutInTransaction(connection, qqUserId, skillId, preview);
		case "specialization":
			if (!input.specialization || !SKILL_SPECIALIZATIONS.includes(input.specialization)) throw new Error("请选择有效的专精方向。");
			return upgradeSkillSpecializationInTransaction(connection, qqUserId, skillId, input.specialization, preview);
		case "appraisal": {
			if (!input.direction || !APPRAISAL_DIRECTIONS.includes(input.direction)) throw new Error("请选择鉴识方向。");
			const detail = await skillDetail(qqUserId, skillId, connection);
			if (detail.code !== "appraisal" || !detail.learned) throw new Error("请选择已学会的鉴识技能。");
			return upgradeAppraisalInTransaction(connection, qqUserId, input.direction, preview);
		}
		default: throw new Error("不支持该技能操作。");
	}
};
const quoteAction = async (connection, qqUserId, input) => {
	const result = await actionResult(connection, qqUserId, input, true);
	const characterId = await craftCharacterId(connection, qqUserId);
	const [rows] = await connection.execute("SELECT skill_points FROM characters WHERE id=?", [characterId]);
	const before = Number(rows[0]?.skill_points);
	const cost = Number(result.cost ?? 0);
	return {
		action: input.action,
		skillId: input.skillId,
		skillPointsBefore: before,
		skillPointsAfter: before - cost,
		result
	};
};
const skillPage = (qqUserId, view, requestedPage = 1, keyword = "") => withTransaction(async (connection) => {
	await craftCharacterId(connection, qqUserId, true);
	const data = await skillList(qqUserId, connection);
	const query = keyword.trim();
	const source = (view === "learned" ? data.skills : data.discoveries).filter((item) => !query || item.name.includes(query));
	const totalPages = Math.max(1, Math.ceil(source.length / 10));
	const page = Math.min(totalPages, Math.max(1, requestedPage));
	const current = source.slice((page - 1) * 10, page * 10);
	const items = [];
	for (const item of current) {
		if (view === "learned" && "level" in item) {
			items.push({
				id: Number(item.id),
				code: String(item.code),
				name: item.name,
				category: item.category,
				tier: item.tier,
				level: Number(item.level),
				quickSlot: item.quick_slot == null ? null : Number(item.quick_slot),
				passiveLinked: Boolean(item.passive_linked)
			});
			continue;
		}
		const discovered = item;
		try {
			const quote = await quoteAction(connection, qqUserId, {
				action: "learn",
				skillId: Number(discovered.id)
			});
			items.push({
				id: Number(discovered.id),
				name: discovered.name,
				category: discovered.category,
				tier: discovered.tier,
				learnCost: Number(discovered.learn_cost),
				canLearn: true,
				remainingSkillPoints: quote.skillPointsAfter
			});
		} catch (error) {
			if (isInfrastructureError(error)) throw error;
			items.push({
				id: Number(discovered.id),
				name: discovered.name,
				category: discovered.category,
				tier: discovered.tier,
				learnCost: Number(discovered.learn_cost),
				canLearn: false,
				reason: error instanceof Error ? error.message : "暂时不能学习。"
			});
		}
	}
	return {
		view,
		page,
		totalPages,
		total: source.length,
		keyword: query,
		skillPoints: Number(data.skillPoints),
		passiveLinkLimit: Number(data.passiveLinkLimit),
		quickSlots: data.skills.filter((item) => item.quick_slot).map((item) => ({
			slot: Number(item.quick_slot),
			skillId: Number(item.id),
			name: item.name
		})),
		linkedPassives: data.skills.filter((item) => item.category === "passive" && Boolean(item.passive_linked)).map((item) => ({
			skillId: Number(item.id),
			name: item.name
		})),
		items
	};
});
const candidateActions = (detail) => {
	const skillId = Number(detail.id);
	if (!detail.learned) return [{
		action: "learn",
		skillId
	}];
	if (detail.code === "appraisal") return APPRAISAL_DIRECTIONS.map((direction) => ({
		action: "appraisal",
		skillId,
		direction
	}));
	const actions = [];
	if (detail.category === "passive") actions.push({
		action: "passive_link",
		skillId
	});
	if (!["passive", "bound"].includes(detail.category)) actions.push({
		action: "shortcut",
		skillId
	});
	if (detail.nextUpgradeCost !== null) actions.push({
		action: "upgrade",
		skillId
	});
	const specializations = detail.weaponMastery ? SKILL_SPECIALIZATIONS.filter((key) => key === "overcharge" || key === "instant") : detail.passiveSpecializable ? ["potent"] : ["passive", "bound"].includes(detail.category) ? [] : detail.specializationChoices;
	for (const specialization of specializations) actions.push({
		action: "specialization",
		skillId,
		specialization
	});
	return actions;
};
const skillDetailView = (qqUserId, skillId) => withTransaction(async (connection) => {
	await craftCharacterId(connection, qqUserId, true);
	const list = await skillList(qqUserId, connection);
	const detail = await skillDetail(qqUserId, integer(skillId, "技能编号"), connection);
	const learned = list.skills.find((item) => Number(item.id) === skillId);
	const actions = [];
	for (const action of candidateActions(detail)) try {
		actions.push({
			...action,
			enabled: true,
			quote: await quoteAction(connection, qqUserId, action)
		});
	} catch (error) {
		if (isInfrastructureError(error)) throw error;
		actions.push({
			...action,
			enabled: false,
			reason: error instanceof Error ? error.message : "暂时不能操作。"
		});
	}
	return {
		skill: {
			id: Number(detail.id),
			code: detail.code,
			name: detail.name,
			category: detail.category,
			tier: detail.tier,
			description: detail.description,
			learned: Boolean(detail.learned),
			level: Number(detail.level),
			maxLevel: Number(detail.max_level),
			skillPoints: Number(detail.skillPoints),
			learnCost: Number(detail.learn_cost),
			nextUpgradeCost: detail.nextUpgradeCost,
			skillKind: detail.skill_kind,
			element: detail.element,
			rangeType: detail.range_type,
			targetScope: detail.target_scope,
			requiredWeaponType: detail.required_weapon_type,
			actualPower: Number(detail.actualPower),
			actualManaCost: Number(detail.actualManaCost),
			actualCooldown: Number(detail.actualCooldown),
			actualChant: Number(detail.actualChant),
			quickSlot: learned?.quick_slot == null ? null : Number(learned.quick_slot),
			passiveLinked: Boolean(learned?.passive_linked),
			specializations: detail.specializations,
			specializationChoices: detail.specializationChoices,
			specializationUpgradeCosts: detail.weaponMastery ? {
				overcharge: detail.masteryProficiencyCost,
				instant: detail.masteryFocusCost
			} : detail.passiveSpecializable ? { potent: detail.specializationUpgradeCost } : ["passive", "bound"].includes(detail.category) ? {} : detail.specializationUpgradeCosts,
			specializationMaxLevel: Number(detail.specializationMaxLevel),
			masteryProficiencyCost: detail.masteryProficiencyCost,
			masteryFocusCost: detail.masteryFocusCost,
			passiveSpecializable: Boolean(detail.passiveSpecializable),
			appraisal: detail.appraisal ?? null,
			effectDetails: detail.effectDetails
		},
		actions
	};
});
const previewSkillAction = (qqUserId, input) => withTransaction(async (connection) => {
	const characterId = await craftCharacterId(connection, qqUserId, true);
	const quote = await quoteAction(connection, qqUserId, input);
	const idempotencyKey = randomUUID();
	return {
		token: await createCraftRequest(connection, characterId, requestKind, {
			...input,
			quote,
			idempotencyKey
		}, quoteMinutes),
		idempotencyKey,
		expiresAt: new Date(Date.now() + quoteMinutes * 6e4).toISOString(),
		quote
	};
});
const confirmSkillAction = (qqUserId, token, idempotencyKey) => withTransaction(async (connection) => {
	if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error("确认凭据无效，请重新获取技能预览。");
	const characterId = await craftCharacterId(connection, qqUserId, true);
	const request = await craftRequestFor(connection, characterId, requestKind, token);
	if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error("确认凭据不匹配，请重新获取技能预览。");
	if (request.result) return request.result;
	const fresh = await quoteAction(connection, qqUserId, request.snapshot);
	if (JSON.stringify(fresh) !== JSON.stringify(request.snapshot.quote)) throw new Error("技能或技能点状态已变化，请重新获取预览。");
	const result = await actionResult(connection, qqUserId, request.snapshot, false);
	await completeCraftRequest(connection, characterId, token, result);
	return result;
});

//#endregion
export { APPRAISAL_DIRECTIONS, SKILL_ACTIONS, SKILL_PAGE_SIZE, SKILL_SPECIALIZATIONS, confirmSkillAction, previewSkillAction, skillDetailView, skillPage };