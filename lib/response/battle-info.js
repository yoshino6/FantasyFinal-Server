import { useGameMessage } from "../game/use-game-message.js";
import { battleStatus } from "../game/adventure.service.js";
import { messageFormat } from "../game/message.js";
import { battleOperationFormat } from "./adventure.js";
import { useEvent } from "alemonjs";

//#region src/response/battle-info.ts
var battle_info_default = async () => {
	const [event] = useEvent();
	const [message] = useGameMessage();
	try {
		const battle = await battleStatus(event.current.UserId);
		await message.send({ format: battleOperationFormat(`第 ${battle.turn} 回合｜点击友方或敌方名称选择技能目标。`, battle) });
	} catch (error) {
		await message.send({ format: messageFormat("当前无战斗", "你不在战斗中。发送 /面板 返回冒险操作。") });
	}
};

//#endregion
export { battle_info_default as default };