//#region src/game/achievement-delivery-rules.ts
const object = (v) => v && typeof v === "object" ? v : {};
const achievementDeliveryOutcome = (results) => {
	const successes = results.filter((r) => r.code === 2e3);
	const platformCodes = results.map((r) => Number(object(r.message).err_code ?? object(r.message).code ?? 0)).filter(Boolean);
	const messageIds = successes.map((r) => String(object(r.data).id ?? "")).filter(Boolean);
	const blocked = results.length > 0 && results.every((r) => r.code === 4001 || r.code === 4002 || Number(object(r.message).err_code ?? object(r.message).code) === 40034105);
	return {
		status: successes.length === results.length && results.length > 0 ? "sent" : successes.length > 0 ? "uncertain" : blocked ? "blocked" : "uncertain",
		resultCodes: results.map((r) => Number(r.code ?? 0)),
		platformCodes,
		messageIds
	};
};

//#endregion
export { achievementDeliveryOutcome };