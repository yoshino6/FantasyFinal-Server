import { Format } from "alemonjs";

//#region src/response/warrant-notice.ts
/** 主动入城公告与镇内被动提示共用同一份通缉文本。 */
const warrantNoticeFormat = (wanted, options = {}) => {
	const { independent = false, passive = false } = options;
	const markdown = Format.createMarkdown().addTitle("城镇通缉").addNewline().addNewline().addText(`不法分子【${wanted.name}】${passive ? "正位于" : "进入"}${wanted.regionName}！`).addNewline().addText(`坐标：（${wanted.x}, ${wanted.y}, ${wanted.z}）`);
	const buttons = Format.createButtonGroup().addRow().addButton("前往", `/前往 ${wanted.x} ${wanted.y} ${wanted.z}`, {
		type: "command",
		autoEnter: false,
		style: "blue"
	});
	return (independent ? new Format() : Format.create()).addMarkdown(markdown).addButtonGroup(buttons);
};

//#endregion
export { warrantNoticeFormat };