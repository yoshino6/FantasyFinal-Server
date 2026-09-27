//#region src/app-api/app-format.ts
const mdNodeToText = (node) => {
	const value = node.value;
	switch (node.type) {
		case "MD.title": return `【${String(value ?? "")}】\n`;
		case "MD.subtitle": return `— ${String(value ?? "")} —\n`;
		case "MD.text":
		case "MD.content": return String(value ?? "");
		case "MD.bold": return `**${String(value ?? "")}**`;
		case "MD.italic": return `*${String(value ?? "")}*`;
		case "MD.italicStar": return `*${String(value ?? "")}*`;
		case "MD.strikethrough": return `~~${String(value ?? "")}~~`;
		case "MD.blockquote": return Array.isArray(value) ? `> ${formatValueToText(value).replace(/\r?\n/g, "\n> ")}` : `> ${String(value ?? "").replace(/\r?\n/g, "\n> ")}`;
		case "MD.code": return `\`${String(value ?? "")}\``;
		case "MD.link": return String(value?.text ?? "");
		case "MD.image": return value ? `[图片]` : "";
		case "MD.mention": return `@${String(value ?? "")}`;
		case "MD.list": return Array.isArray(value) ? value.map((item) => {
			const listItem = item;
			if (listItem && typeof listItem === "object" && "value" in listItem) {
				const itemValue = listItem.value;
				if (itemValue && typeof itemValue === "object") {
					const indexed = itemValue;
					return `${indexed.index ?? ""}. ${String(indexed.text ?? "")}`.trim();
				}
				return `- ${String(itemValue ?? "")}`;
			}
			return `- ${String(item ?? "")}`;
		}).join("\n") : "";
		case "MD.newline": return "\n";
		case "MD.divider": return "\n——————————\n";
		default: return "";
	}
};
const markdownToText = (nodes) => {
	if (!Array.isArray(nodes)) return "";
	return nodes.map((node) => {
		const item = node;
		if (Array.isArray(item.value)) return markdownToText(item.value);
		return mdNodeToText(item);
	}).join("");
};
const formatValueToText = (formatValue) => {
	if (!Array.isArray(formatValue)) return "";
	return formatValue.map((node) => {
		const item = node;
		if (item.type === "Text") return String(item.value ?? "");
		if (item.type === "Markdown") return markdownToText(item.value);
		if (item.type === "MarkdownOriginal") return String(item.value ?? "");
		if (item.type === "Image") return item.value ? "[图片]" : "";
		if (item.type === "BT.group") return "";
		return "";
	}).join("").replace(/\n{3,}/g, "\n\n").trim();
};
const markdownNodeToMarkdown = (node) => {
	const value = node.value;
	switch (node.type) {
		case "MD.title": return `# ${String(value ?? "")} `;
		case "MD.subtitle": return `## ${String(value ?? "")} `;
		case "MD.text":
		case "MD.content": return String(value ?? "");
		case "MD.bold": return `**${String(value ?? "")}** `;
		case "MD.italic": return `__${String(value ?? "")}__ `;
		case "MD.italicStar": return `*${String(value ?? "")}* `;
		case "MD.strikethrough": return `~~${String(value ?? "")}~~ `;
		case "MD.link": {
			const link = value;
			if (!link?.text && !link?.url) return "";
			if (!link?.text || !link?.url) return `<${String(link.url ?? link.text)}> `;
			return `[🔗${String(link.text)}](${String(link.url)}) `;
		}
		case "MD.image": {
			const url = String(value ?? "").trim();
			if (!url) return "";
			const options = node.options ?? {};
			return `\n![text #${Number(options.width) || 208}px #${Number(options.height) || 320}px](${url})\n`;
		}
		case "MD.list": return Array.isArray(value) ? `${value.map((item) => {
			const listItem = item;
			const itemValue = listItem && typeof listItem === "object" && "value" in listItem ? listItem.value : item;
			if (itemValue && typeof itemValue === "object") {
				const indexed = itemValue;
				return `\n${indexed.index ?? 1}. ${String(indexed.text ?? "")}`;
			}
			return `\n- ${String(itemValue ?? "")}`;
		}).join("")}\n` : "";
		case "MD.blockquote": return Array.isArray(value) ? `> ${formatValueToMarkdown(value).replace(/\r?\n/g, "\n> ")}` : `> ${String(value ?? "").replace(/\r?\n/g, "\n> ")}`;
		case "MD.divider": return "\n***\n";
		case "MD.newline": return "\n";
		case "MD.code": return `\n\`\`\`${typeof node.options?.language === "string" ? node.options.language : ""}\n${String(value ?? "")}\n\`\`\`\n`;
		case "MD.mention": return value === "everyone" ? "<qqbot-at-everyone />" : `<qqbot-at-user id="${String(value ?? "")}" />`;
		case "MD.button": return String(value ?? "");
		default: return Array.isArray(value) ? formatValueToMarkdown(value) : String(value ?? "");
	}
};
/** 将 Alemon 的结构化 Markdown 转为客户端可理解的原始 Markdown 回退。 */
const formatValueToMarkdown = (formatValue) => {
	if (!Array.isArray(formatValue)) return "";
	return formatValue.map((node) => {
		const item = node;
		if (item.type === "Text") return String(item.value ?? "");
		if (item.type === "Markdown") return formatValueToMarkdown(item.value);
		if (item.type === "MarkdownOriginal") return String(item.value ?? "");
		if (item.type === "Image") return item.value ? `\n![图片](${String(item.value)})\n` : "";
		if (item.type === "Mention") return item.value === "everyone" ? "<qqbot-at-everyone />" : `<qqbot-at-user id="${String(item.value ?? "")}" />`;
		if (item.type === "BT.group" || item.type === "BT.row" || item.type === "Select") return "";
		return markdownNodeToMarkdown(item);
	}).join("").replace(/\n{3,}/g, "\n\n").trim();
};
const commandFrom = (options, fallback) => {
	const value = options;
	const data = value?.data;
	if (typeof data === "string" && data.trim()) return data.trim();
	if (typeof value?.command === "string" && value.command.trim()) return value.command.trim();
	if (typeof value?.value === "string" && value.value.trim().startsWith("/")) return value.value.trim();
	return String(fallback ?? "").trim();
};
const formatValueToButtons = (formatValue) => {
	if (!Array.isArray(formatValue)) return [];
	const buttons = [];
	const visit = (value) => {
		if (!Array.isArray(value)) return;
		for (const node of value) {
			const item = node;
			if (item.type === "BT.group" || item.type === "BT.row") {
				visit(item.value);
				continue;
			}
			if (item.type === "Button") {
				const command = commandFrom(item.options);
				if (command) buttons.push({
					label: String(item.value ?? "按钮"),
					command
				});
				continue;
			}
			if (item.type === "MD.button") {
				const command = commandFrom(item.options);
				if (command) buttons.push({
					label: String(item.value ?? "按钮"),
					command
				});
				continue;
			}
			if (item.type === "Markdown" || item.type === "MD.row") visit(item.value);
		}
	};
	visit(formatValue);
	return buttons;
};
const formatToAppMessage = (format, petReply) => ({
	text: formatValueToText(format.value),
	markdown: formatValueToMarkdown(format.value),
	format: Array.isArray(format.value) ? format.value : void 0,
	buttons: formatValueToButtons(format.value),
	petReply
});
const formatValueToAppMessage = (formatValue, petReply) => ({
	text: formatValueToText(formatValue),
	markdown: formatValueToMarkdown(formatValue),
	format: Array.isArray(formatValue) ? formatValue : void 0,
	buttons: formatValueToButtons(formatValue),
	petReply
});
const plainAppMessage = (text, buttons = [], petReply) => ({
	text: text.trim(),
	markdown: text.trim() || (buttons.length ? "请选择一个操作：" : void 0),
	buttons,
	petReply
});

//#endregion
export { formatToAppMessage, formatValueToAppMessage, formatValueToButtons, formatValueToMarkdown, formatValueToText, plainAppMessage };