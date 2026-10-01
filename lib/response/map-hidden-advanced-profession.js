import { activeSkillCodesForAdvancedProfession } from "../game/advanced-profession.config.js";
import { newAdvancedSkillDefinitions } from "../game/map-hidden-advanced-skills.config.js";
import { useGameMessage } from "../game/use-game-message.js";
import { addStoryIllustration } from "../game/story-illustrations.js";
import { durationText } from "../game/time-format.js";
import { mapHiddenAdvancedMentorAction, mapHiddenAdvancedMentorView, senseMapHiddenAdvancedMentor } from "../game/map-hidden-advanced-profession.service.js";
import { battleStatus, chooseTarget } from "../game/adventure.service.js";
import { messageFormat } from "../game/message.js";
import { battleStartFormat } from "./adventure.js";
import { Format, useEvent, useRoute } from "alemonjs";

//#region src/response/map-hidden-advanced-profession.ts
const fail = async (message, error) => message.send({ format: messageFormat("隐藏导师", error instanceof Error ? error.message : "请稍后重试。") });
const mapHiddenAdvancedMentorFormat = async (user, code, receipt = "") => {
	const view = await mapHiddenAdvancedMentorView(user, code);
	const { profession, quest, mission, qualified, currentCode, retrainRemainingSeconds } = view;
	const stage = Number(quest?.stage ?? 0);
	const revision = Number(quest?.revision ?? 0);
	const markdown = addStoryIllustration(Format.createMarkdown().addTitle(`${profession.mentor.title}·${profession.mentor.name}`).addNewline().addNewline(), `map_hidden.${profession.code}.${stage === 6 && !qualified ? "trial" : "lesson"}`).addBlockquote(mission.lesson).addNewline().addNewline();
	if (receipt) markdown.addText(receipt).addNewline().addNewline();
	const buttons = Format.createButtonGroup();
	const action = (verb) => `/隐藏导师操作 ${profession.code} ${revision} ${verb}`;
	if (qualified) {
		markdown.addText(`【${profession.name}】的传承资格已经永久保留。`).addNewline();
		if (currentCode === profession.code) markdown.addText("你当前正使用这条二转职业。");
		else if (retrainRemainingSeconds > 0) markdown.addText(`重新二转尚需 ${durationText(retrainRemainingSeconds)}。`);
		else buttons.addRow().addButton(`重新成为${profession.name}`, action("become"), {
			type: "command",
			autoEnter: false,
			style: "blue"
		});
	} else if (!quest || stage < 2) {
		markdown.addText(`传承方向：${profession.role}`).addNewline().addNewline().addText("当面接受后，旧二转职业会保留到你本人通过导师试炼；发现与任务进度只属于你。");
		if (retrainRemainingSeconds > 0) markdown.addNewline().addText(`重新二转尚需 ${durationText(retrainRemainingSeconds)}。`);
		else if (view.publicQuest?.code === "spirit_summoner" && profession.code === "spirit_summoner") {
			markdown.addNewline().addNewline().addBlockquote("你仍有旧世界树唤灵师任务。若改走这里，旧任务当前进度会被中断并留存历史。");
			buttons.addRow().addButton("中断旧试炼并接取", action("accept_legacy"), {
				type: "command",
				autoEnter: false,
				style: "blue"
			});
		} else if (view.publicQuest) markdown.addNewline().addText("请先结束当前世界树二转任务。");
		else buttons.addRow().addButton("接受隐藏传承", action("accept"), {
			type: "command",
			autoEnter: false,
			style: "blue"
		});
	} else if (stage === 2) {
		markdown.addBold("第一段：听取传承").addNewline().addText("导师说明这条路线的战斗职责与风险；听完后才能开始野外观察。");
		buttons.addRow().addButton("听取传承", action("listen"), {
			type: "command",
			autoEnter: false,
			style: "blue"
		});
	} else if (stage === 3) {
		markdown.addBold("第二段：实战观察").addNewline().addText(`在该导师所在区域，真实击败【${mission.observation.name}】 ${Number(quest?.observed_kills ?? 0)}/${mission.observation.count}。胜利结算才会记录进度。`);
		if (Number(quest?.observed_kills ?? 0) >= mission.observation.count) buttons.addRow().addButton("交回观察记录", action("submit_observation"), {
			type: "command",
			autoEnter: false,
			style: "blue"
		});
	} else if (stage === 4) {
		markdown.addBold("第三段：地图凭证").addNewline().addText(`随身交付【${mission.material.name}】 ${view.materialQuantity}/${mission.material.count}；交付会真实扣除物品。`);
		if (view.materialQuantity >= mission.material.count) buttons.addRow().addButton("交付材料", action("submit_material"), {
			type: "command",
			autoEnter: false,
			style: "blue"
		});
	} else if (stage === 5) {
		markdown.addBold("第四段：职业专项目标").addNewline().addText(`在该导师所在区域，真实击败【${mission.proof.name}】 ${Number(quest?.proof_kills ?? 0)}/${mission.proof.count}。这场胜利会检验你对该路线危险的应对。`);
		if (Number(quest?.proof_kills ?? 0) >= mission.proof.count) buttons.addRow().addButton("交回专项目标", action("submit_proof"), {
			type: "command",
			autoEnter: false,
			style: "blue"
		});
	} else if (stage === 6) {
		markdown.addBold("第五段：本人导师试炼").addNewline().addBlockquote(mission.trialInstruction).addNewline().addText("试炼期间可临时使用本路线的四项技能；胜利时核对本人真实战斗事件。条件未完成时可重新开启试炼。");
		buttons.addRow().addButton("开启导师试炼", action("start_trial"), {
			type: "command",
			autoEnter: false,
			style: "blue"
		});
	}
	if (stage >= 2 && stage <= 6 && !qualified) buttons.addRow().addButton("中断当前传承", action("abandon"), {
		type: "command",
		autoEnter: false
	});
	buttons.addRow().addButton("查看传承四技", `/隐藏导师技能 ${profession.code}`, {
		type: "command",
		autoEnter: false,
		style: "blue"
	});
	buttons.addRow().addButton("返回面板", "/面板", {
		type: "command",
		autoEnter: false
	});
	return Format.create().addMarkdown(markdown).addButtonGroup(buttons);
};
/** 只在本人已发现的导师所在格展示技能说明；试炼借用技能不在永久技能列表中。 */
const mapHiddenAdvancedMentorSkillFormat = async (user, code) => {
	const { profession } = await mapHiddenAdvancedMentorView(user, code);
	const skills = activeSkillCodesForAdvancedProfession(profession.code).map((skillCode) => newAdvancedSkillDefinitions.find((skill) => skill.code === skillCode));
	if (skills.length !== 4 || skills.some((skill) => !skill)) throw new Error("导师的传承技能尚未准备好。");
	const markdown = Format.createMarkdown().addTitle(`${profession.name}｜传承四技`).addNewline().addNewline().addBlockquote(profession.role).addNewline().addNewline();
	for (const skill of skills) markdown.addBold(`${skill.name}｜MP ${skill.manaCost}｜冷却 ${skill.cooldownTurns} 回合`).addNewline().addText(skill.description).addNewline().addNewline();
	return Format.create().addMarkdown(markdown).addButtonGroup(Format.createButtonGroup().addRow().addButton("返回导师", `/隐藏导师 ${profession.code}`, {
		type: "command",
		autoEnter: false,
		style: "blue"
	}));
};
const senseMapHiddenAdvancedMentorHandler = async () => {
	const [event] = useEvent();
	const [message] = useGameMessage();
	try {
		const result = await senseMapHiddenAdvancedMentor(event.current.UserId);
		if (result.kind !== "discovered") {
			await message.send({ format: messageFormat("感知", result.text) });
			return;
		}
		const markdown = Format.createMarkdown().addTitle("感知").addNewline().addNewline().addBlockquote(result.text);
		const buttons = Format.createButtonGroup().addRow().addButton("查看当前格", "/面板", {
			type: "command",
			autoEnter: false
		});
		await message.send({ format: Format.create().addMarkdown(markdown).addButtonGroup(buttons) });
	} catch (error) {
		await fail(message, error);
	}
};
const mapHiddenAdvancedMentorHandler = async () => {
	const [event] = useEvent();
	const [route] = useRoute();
	const [message] = useGameMessage();
	try {
		await message.send({ format: await mapHiddenAdvancedMentorFormat(event.current.UserId, String(route.param("code"))) });
	} catch (error) {
		await fail(message, error);
	}
};
const mapHiddenAdvancedMentorSkillHandler = async () => {
	const [event] = useEvent();
	const [route] = useRoute();
	const [message] = useGameMessage();
	try {
		await message.send({ format: await mapHiddenAdvancedMentorSkillFormat(event.current.UserId, String(route.param("code"))) });
	} catch (error) {
		await fail(message, error);
	}
};
const mapHiddenAdvancedMentorActionHandler = async () => {
	const [event] = useEvent();
	const [route] = useRoute();
	const [message] = useGameMessage();
	const code = String(route.param("code"));
	try {
		const result = await mapHiddenAdvancedMentorAction(event.current.UserId, code, Number(route.param("revision")), String(route.param("action")));
		if (result.kind === "trial") {
			await chooseTarget(event.current.UserId, result.spawnId);
			const battle = await battleStatus(event.current.UserId);
			const skillSummary = activeSkillCodesForAdvancedProfession(code).map((skillCode) => newAdvancedSkillDefinitions.find((skill) => skill.code === skillCode)).filter((skill) => Boolean(skill)).map((skill) => `${skill.name}（MP ${skill.manaCost}，冷却 ${skill.cooldownTurns}）：${skill.description}`).join("\n");
			await message.send({ format: battleStartFormat(`隐藏导师试炼已经开始。四项传承技能只在本场临时借用；请在战斗面板选择行动。\n\n${skillSummary}`, battle) });
			return;
		}
		await message.send({ format: await mapHiddenAdvancedMentorFormat(event.current.UserId, code, result.kind === "accepted" ? "传承已接下，导师开始讲述第一段经历。" : result.kind === "abandoned" ? "当前传承已中断，已获得的永久资格不会丢失。" : result.kind === "became" ? `你重新成为了【${result.profession}】。` : "导师核对了你带回的真实记录。") });
	} catch (error) {
		await fail(message, error);
	}
};

//#endregion
export { mapHiddenAdvancedMentorActionHandler, mapHiddenAdvancedMentorFormat, mapHiddenAdvancedMentorHandler, mapHiddenAdvancedMentorSkillFormat, mapHiddenAdvancedMentorSkillHandler, senseMapHiddenAdvancedMentorHandler };