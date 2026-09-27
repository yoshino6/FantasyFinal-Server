import { reservePassiveWarrantNotice, townPassiveWantedAlert } from "../game/pvp.service.js";
import { warrantNoticeFormat } from "../response/warrant-notice.js";
import { logger, useEvent, useMessage } from "alemonjs";

//#region src/middleware/warrant-passive-notice.ts
/** 镇内其他玩家发言时，被动提示仍在城内暴露行踪的通缉者。 */
var warrant_passive_notice_default = async (_event, next) => {
	const [event] = useEvent();
	const [message] = useMessage();
	const { IsPrivate, ChannelId, UserId } = event.current;
	if (!IsPrivate && ChannelId && UserId) try {
		const wanted = await townPassiveWantedAlert(String(UserId));
		if (wanted && await reservePassiveWarrantNotice(wanted.warrantId, String(ChannelId), String(UserId))) await message.send({ format: warrantNoticeFormat(wanted, { passive: true }) });
	} catch (error) {
		logger.warn({
			err: error,
			channelId: ChannelId,
			userId: UserId
		}, "发送被动城镇通缉提示失败");
	}
	await next();
};

//#endregion
export { warrant_passive_notice_default as default };