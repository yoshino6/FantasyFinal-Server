import { useGameMessage } from "../game/use-game-message.js";
import { messageFormat } from "../game/message.js";
import { aquaAction, aquaView } from "../game/aqua.service.js";
import { Format, useEvent, useRoute } from "alemonjs";

//#region src/response/aqua.ts
var aqua_default = async () => {
	const [event] = useEvent(), [route] = useRoute(), [message] = useGameMessage();
	try {
		const action = route.param("action");
		const view = action === void 0 ? await aquaView(event.current.UserId) : await aquaAction(event.current.UserId, Number(route.param("revision")), String(action));
		const buttons = Format.createButtonGroup();
		for (const choice of view.choices) buttons.addRow().addButton(choice.label, `/女神 ${view.revision} ${choice.code}`, {
			type: "command",
			autoEnter: true,
			style: "blue"
		});
		buttons.addRow().addButton("凭物与回执", "/初行见闻", {
			type: "command",
			autoEnter: true
		}).addButton("返回公会", "/初行公会", {
			type: "command",
			autoEnter: true
		});
		await message.send({ format: Format.create().addMarkdown(Format.createMarkdown().addTitle(view.title).addNewline().addNewline().addText(view.text)).addButtonGroup(buttons) });
	} catch (error) {
		await message.send({ format: messageFormat("女神办事桌", error instanceof Error ? error.message : "请稍后重试。") });
	}
};

//#endregion
export { aqua_default as default };