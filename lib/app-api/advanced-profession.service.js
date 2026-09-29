import { registeredAdvancedProfessionByCode } from "../game/advanced-profession.config.js";
import { withTransaction } from "../database/pool.js";
import { completeCraftRequest, craftCharacterId, craftRequestFor, createCraftRequest } from "../game/alchemy-journal.service.js";
import { advanceAdvancedProfessionStageInTransaction, advancedProfessionOverview, beginAdvancedProfessionInTransaction, submitAdvancedProfessionProofInTransaction } from "../game/advanced-profession.service.js";
import { randomUUID } from "node:crypto";

//#region src/app-api/advanced-profession.service.ts
const requestKind = "web_advanced_quest";
const quoteMinutes = 2;
const validCredential = (value) => /^[0-9a-f-]{36}$/i.test(value);
const validAction = (value) => value === "accept" || value === "switch_quest" || value === "submit_story" || value === "submit_proof";
const actionInTransaction = (connection, qqUserId, code, action, preview) => {
	if (action === "accept" || action === "switch_quest") return beginAdvancedProfessionInTransaction(connection, qqUserId, code, action === "switch_quest", preview);
	if (action === "submit_story") return advanceAdvancedProfessionStageInTransaction(connection, qqUserId, code, preview);
	if (action === "submit_proof") return submitAdvancedProfessionProofInTransaction(connection, qqUserId, code, preview);
	throw new Error("二转操作无效。");
};
const advancedProfessionStatus = async (qqUserId) => {
	const state = await advancedProfessionOverview(qqUserId);
	const { character, activeQuest, completed, hiddenQuest, retrainRemainingSeconds, materialQuantities } = state;
	const activeProfession = registeredAdvancedProfessionByCode(activeQuest?.profession_code ?? "");
	const currentProfession = registeredAdvancedProfessionByCode(completed?.profession_code ?? "");
	const candidates = state.professions.map((profession) => {
		const atMentor = character.region_code === "world_tree" && Number(character.pos_x) === profession.mentor.x && Number(character.pos_y) === profession.mentor.y;
		const ownQuest = activeQuest?.profession_code === profession.code ? activeQuest : null;
		const stage = Number(ownQuest?.stage ?? 0);
		const ownedMaterial = materialQuantities[profession.route.materialCode] ?? 0;
		const availableActions = [];
		if (atMentor && completed?.profession_code !== profession.code) {
			if (ownQuest && stage === 1 && Number(ownQuest.story_kills) >= profession.first.requiredKills) availableActions.push("submit_story");
			else if (ownQuest && stage === 2 && Number(ownQuest.proof_kills) >= profession.second.requiredKills && ownedMaterial >= profession.second.materialCount) availableActions.push("submit_proof");
			else if (!ownQuest && Number(character.level) >= 25 && character.profession && !hiddenQuest && !retrainRemainingSeconds) availableActions.push(activeQuest ? "switch_quest" : "accept");
		}
		const blockedReason = completed?.profession_code === profession.code ? "当前已成为该职业。" : !ownQuest && Number(character.level) < 25 ? "二转试炼将在 Lv.25 开放。" : !ownQuest && !character.profession ? "请先选择初始职业。" : !ownQuest && hiddenQuest ? "正在进行地图隐藏二转任务，请先回原导师中断。" : !ownQuest && retrainRemainingSeconds ? `重新二转冷却中，还需 ${retrainRemainingSeconds} 秒。` : !atMentor ? `请前往世界树的【${profession.mentor.title}·${profession.mentor.name}】处。` : stage === 1 && Number(ownQuest.story_kills) < profession.first.requiredKills ? `第一段见闻还需 ${profession.first.requiredKills - Number(ownQuest.story_kills)} 次目标战斗。` : stage === 2 && Number(ownQuest.proof_kills) < profession.second.requiredKills ? `第二段凭证还需 ${profession.second.requiredKills - Number(ownQuest.proof_kills)} 次目标战斗。` : stage === 2 && ownedMaterial < profession.second.materialCount ? `还需 ${profession.second.materialCount - ownedMaterial} 个【${profession.route.materialName}】。` : stage === 3 ? "前两段已完成，待挑战导师。" : null;
		return {
			code: profession.code,
			name: profession.name,
			baseProfession: profession.baseProfession,
			role: profession.role,
			mentor: {
				id: profession.mentor.code,
				name: profession.mentor.name,
				title: profession.mentor.title,
				regionCode: "world_tree",
				x: profession.mentor.x,
				y: profession.mentor.y,
				z: 0,
				locationRequired: true,
				atSite: atMentor
			},
			route: {
				regionCode: profession.route.regionCode,
				name: profession.route.name,
				x: profession.route.x,
				y: profession.route.y,
				mapCodes: profession.route.maps,
				materialCode: profession.route.materialCode,
				materialName: profession.route.materialName
			},
			passive: {
				name: profession.passive.name,
				description: profession.passive.description
			},
			trial: {
				name: profession.trial.name,
				description: profession.trial.description,
				ready: stage === 3
			},
			quest: ownQuest ? {
				stage,
				storyKills: Number(ownQuest.story_kills),
				proofKills: Number(ownQuest.proof_kills),
				first: {
					title: profession.first.title,
					story: stage >= 1 ? profession.first.story : null,
					target: profession.first.targetText,
					requiredKills: profession.first.requiredKills
				},
				second: {
					title: profession.second.title,
					story: stage >= 2 ? profession.second.story : null,
					target: profession.second.targetText,
					requiredKills: profession.second.requiredKills,
					materialCount: profession.second.materialCount,
					materialOwned: ownedMaterial
				}
			} : null,
			completed: completed?.profession_code === profession.code,
			availableActions,
			blockedReason
		};
	});
	return {
		character: {
			level: Number(character.level),
			baseProfession: character.profession
		},
		currentProfession: completed ? {
			code: completed.profession_code,
			name: currentProfession?.name ?? completed.profession_code,
			completedAt: completed.completed_at
		} : null,
		activeQuest: activeQuest ? {
			professionCode: activeQuest.profession_code,
			professionName: activeProfession?.name ?? activeQuest.profession_code,
			stage: Number(activeQuest.stage),
			storyKills: Number(activeQuest.story_kills),
			proofKills: Number(activeQuest.proof_kills)
		} : null,
		hiddenQuestActive: Boolean(hiddenQuest),
		retrainRemainingSeconds,
		candidates
	};
};
const advancedProfessionDetail = async (qqUserId, code) => {
	const state = await advancedProfessionStatus(qqUserId);
	const candidate = state.candidates.find((item) => item.code === code);
	if (!candidate) throw new Error("这条世界树二转传承尚未开放。");
	return {
		character: state.character,
		currentProfession: state.currentProfession,
		activeQuest: state.activeQuest,
		hiddenQuestActive: state.hiddenQuestActive,
		retrainRemainingSeconds: state.retrainRemainingSeconds,
		candidate
	};
};
const previewAdvancedProfessionAction = (qqUserId, code, action) => withTransaction(async (connection) => {
	if (!validAction(action)) throw new Error("二转操作无效。");
	const characterId = await craftCharacterId(connection, qqUserId, true);
	const quote = await actionInTransaction(connection, qqUserId, code, action, true);
	const replacedQuestCode = "replacedQuestCode" in quote ? quote.replacedQuestCode : null;
	if (action === "accept" && quote.stageBefore !== 0 && !replacedQuestCode) throw new Error("这条试炼已在进行。");
	if (action === "switch_quest" && !replacedQuestCode) throw new Error("当前没有需要中断的其他二转任务。");
	const idempotencyKey = randomUUID();
	return {
		token: await createCraftRequest(connection, characterId, requestKind, {
			action,
			professionCode: code,
			quote,
			idempotencyKey
		}, quoteMinutes),
		idempotencyKey,
		expiresAt: new Date(Date.now() + quoteMinutes * 6e4).toISOString(),
		quote
	};
});
const confirmAdvancedProfessionAction = (qqUserId, token, idempotencyKey) => withTransaction(async (connection) => {
	if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error("确认凭据无效，请重新查看二转试炼。");
	const characterId = await craftCharacterId(connection, qqUserId, true);
	const request = await craftRequestFor(connection, characterId, requestKind, token);
	if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error("确认凭据不匹配，请重新查看二转试炼。");
	if (request.result) return request.result;
	const snapshot = request.snapshot;
	if (!validAction(snapshot.action)) throw new Error("二转确认操作无效。");
	const fresh = await actionInTransaction(connection, qqUserId, snapshot.professionCode, snapshot.action, true);
	if (JSON.stringify(fresh) !== JSON.stringify(snapshot.quote)) throw new Error("二转试炼状态已变化，请重新获取确认。");
	const result = await actionInTransaction(connection, qqUserId, snapshot.professionCode, snapshot.action, false);
	await completeCraftRequest(connection, characterId, token, result);
	return result;
});

//#endregion
export { advancedProfessionDetail, advancedProfessionStatus, confirmAdvancedProfessionAction, previewAdvancedProfessionAction };