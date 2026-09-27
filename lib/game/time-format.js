//#region src/game/time-format.ts
/** 将游戏中的秒数统一显示为中文时分秒，避免长时间操作只显示大量秒数。 */
const durationText = (seconds) => {
	const total = Math.max(0, Math.ceil(Number(seconds) || 0));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor(total % 3600 / 60);
	const remainingSeconds = total % 60;
	return [
		hours ? `${hours}时` : "",
		minutes ? `${minutes}分` : "",
		remainingSeconds ? `${remainingSeconds}秒` : ""
	].filter(Boolean).join("") || "0秒";
};
const detentionMessage = (detainedUntil) => {
	const until = detainedUntil ? new Date(detainedUntil).getTime() : Date.now();
	return `你已被城镇守卫关押，请安静等待释放。\n剩余时间：${durationText((until - Date.now()) / 1e3)}`;
};

//#endregion
export { detentionMessage, durationText };