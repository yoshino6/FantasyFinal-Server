import { useGameMessage } from "../game/use-game-message.js";
import { menuCardImage } from "../game/menu-card.service.js";
import { Format } from "alemonjs";

//#region src/response/help.ts
const sendMenu = async (page) => {
	const [message] = useGameMessage();
	const buttons = Format.createButtonGroup().addRow().addButton("核心功能", "/菜单", {
		type: "command",
		autoEnter: true,
		style: page === 1 ? "blue" : void 0
	}).addButton("进阶功能", "/菜单 进阶", {
		type: "command",
		autoEnter: true,
		style: page === 2 ? "blue" : void 0
	}).addButton("面板", "/面板", {
		type: "command",
		autoEnter: true
	}).addButton("角色", "/角色", {
		type: "command",
		autoEnter: true
	}).addButton("任务", "/任务", {
		type: "command",
		autoEnter: true
	});
	await message.send({ format: Format.create().addImage(await menuCardImage(page)).addButtonGroup(buttons) });
};
var help_default = async () => sendMenu(1);
const advancedMenuHandler = async () => sendMenu(2);

//#endregion
export { advancedMenuHandler, help_default as default };