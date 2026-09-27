import { useGameMessage } from "./use-game-message.js";
import { ResultCode, logger, setTimeout, useClient, useEvent } from "alemonjs";

//#region src/game/talent-detail-message.ts
/** QQ's generic message.delete hook omits scope; use the connector's matching API. */
const talentRecallTarget = (event) => {
	if (event.Target?.targetId) return event.Target;
	if (event.IsPrivate) {
		const match = /^(C2C|DIRECT):(.+)$/.exec(event.OpenId ?? "");
		if (match) return {
			scope: match[1] === "C2C" ? "c2c" : "direct",
			targetId: match[2]
		};
	} else {
		const match = /^(GROUP|GUILD):(.+)$/.exec(event.SpaceId ?? "");
		if (match) return {
			scope: match[1] === "GROUP" ? "group" : "channel",
			targetId: match[2]
		};
	}
};
const scheduleTalentRecall = (results, recall, schedule = setTimeout) => {
	const ids = [...new Set(results.filter((r) => r.code === ResultCode.Ok && typeof r.data?.id === "string" && r.data.id).map((r) => r.data.id))];
	if (!ids.length) return;
	schedule(async () => {
		for (const id of ids) try {
			if (!(await recall(id)).some((r) => r.code === ResultCode.Ok)) logger.warn("天赋详情自动撤回未成功。");
		} catch {
			logger.warn("天赋详情自动撤回失败。");
		}
	}, 6e4);
};
const useTalentDetailMessage = () => {
	const [event] = useEvent(), [message] = useGameMessage(), [client] = useClient();
	const target = talentRecallTarget(event.current);
	const method = target && {
		group: "grouMessageDelte",
		c2c: "userMessageDelete",
		direct: "dmsMessageDelete",
		channel: "channelsMessagesDelete"
	}[target.scope];
	const recall = async (id) => {
		if (event.current.Platform === "qq-bot") {
			if (!target || !method) return [{
				code: ResultCode.FailParams,
				message: "无法确定详情消息会话",
				data: null
			}];
			return client[method](target.targetId, id);
		}
		return [await message.delete({ messageId: id })];
	};
	return { async send(params) {
		const results = await message.send(params);
		scheduleTalentRecall(results, recall);
		return results;
	} };
};

//#endregion
export { scheduleTalentRecall, talentRecallTarget, useTalentDetailMessage };