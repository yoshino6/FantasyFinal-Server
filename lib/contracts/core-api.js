//#region src/contracts/core-api.ts
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value, max = 4096) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const parseCoreCommandRequest = (value) => {
	if (!isRecord(value)) throw new Error("请求体必须是 JSON 对象");
	const requestId = String(value.requestId ?? "").trim();
	const command = String(value.command ?? "").trim();
	const actor = value.actor;
	if (!isNonEmptyString(requestId, 256)) throw new Error("requestId 无效");
	if (!isNonEmptyString(command, 4096)) throw new Error("command 无效");
	if (!isRecord(actor) || !["qq", "app"].includes(String(actor.provider)) || !isNonEmptyString(actor.subject, 256)) throw new Error("actor 无效");
	const source = String(value.source ?? "message");
	if (![
		"message",
		"interaction",
		"system"
	].includes(source)) throw new Error("source 无效");
	let conversation;
	if (value.conversation !== void 0) {
		const raw = value.conversation;
		if (!isRecord(raw) || ![
			"private",
			"group",
			"channel"
		].includes(String(raw.scope)) || !isNonEmptyString(raw.id, 256)) throw new Error("conversation 无效");
		conversation = {
			scope: raw.scope,
			id: raw.id,
			...isNonEmptyString(raw.botId, 256) ? { botId: raw.botId } : {}
		};
	}
	return {
		requestId,
		actor: {
			provider: actor.provider,
			subject: actor.subject,
			...isNonEmptyString(actor.displayName, 256) ? { displayName: actor.displayName } : {}
		},
		...conversation ? { conversation } : {},
		command,
		source,
		...isNonEmptyString(value.sentAt, 128) ? { sentAt: value.sentAt } : {}
	};
};

//#endregion
export { isNonEmptyString, isRecord, parseCoreCommandRequest };