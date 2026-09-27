import { useGameMessage } from "../game/use-game-message.js";
import { changeAppPasswordByQqUser, setAppPasswordByQqUser } from "../game/app-channel.service.js";
import { messageFormat } from "../game/message.js";
import { Format, useEvent, useRoute } from "alemonjs";

//#region src/response/app-password.ts
var app_password_default = async () => {
	const [event] = useEvent();
	const [route] = useRoute();
	const [message] = useGameMessage();
	const qqUserId = event.current.UserId;
	try {
		const password = String(route.param("password") ?? "");
		if (!password) {
			const markdown = Format.createMarkdown().addTitle("设置跨平台密码").addNewline().addNewline().addText("设置后可在桌宠等平台使用 Game ID + 密码登录。").addNewline().addNewline().addBlockquote("发送：/设置密码 <8-64位密码>");
			const buttons = Format.createButtonGroup().addRow().addButton("取消", "/菜单", {
				type: "command",
				autoEnter: true
			});
			await message.send({ format: Format.create().addMarkdown(markdown).addButtonGroup(buttons) });
			return;
		}
		const result = await setAppPasswordByQqUser(qqUserId, password);
		const markdown = Format.createMarkdown().addTitle("密码已设置").addNewline().addNewline().addText(`你的 Game ID：${result.gameUserId}`).addNewline().addNewline().addBlockquote("之后可在桌宠等平台使用 Game ID + 密码登录。");
		const buttons = Format.createButtonGroup().addRow().addButton("我的", "/角色", {
			type: "command",
			autoEnter: true,
			style: "blue"
		});
		await message.send({ format: Format.create().addMarkdown(markdown).addButtonGroup(buttons) });
	} catch (error) {
		await message.send({ format: messageFormat("设置密码失败", error instanceof Error ? error.message : "请稍后重试。") });
	}
};
const changePasswordHandler = async () => {
	const [event] = useEvent();
	const [route] = useRoute();
	const [message] = useGameMessage();
	const qqUserId = event.current.UserId;
	try {
		const currentPassword = String(route.param("currentPassword") ?? "");
		const password = String(route.param("password") ?? "");
		const result = await changeAppPasswordByQqUser(qqUserId, currentPassword, password);
		const markdown = Format.createMarkdown().addTitle("密码已修改").addNewline().addNewline().addText(`你的 Game ID：${result.gameUserId}`).addNewline().addNewline().addBlockquote("之后请使用新的密码登录。");
		const buttons = Format.createButtonGroup().addRow().addButton("我的", "/角色", {
			type: "command",
			autoEnter: true,
			style: "blue"
		});
		await message.send({ format: Format.create().addMarkdown(markdown).addButtonGroup(buttons) });
	} catch (error) {
		await message.send({ format: messageFormat("修改密码失败", error instanceof Error ? error.message : "请稍后重试。") });
	}
};

//#endregion
export { changePasswordHandler, app_password_default as default };