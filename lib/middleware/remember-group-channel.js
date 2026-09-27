import { rememberGroupChannel } from "../game/group-channel.service.js";
import { logger, useEvent } from "alemonjs";

//#region src/middleware/remember-group-channel.ts
/** 在任何群事件中登记 group_openid，使私聊操作也能向群主动推送公告。 */
var remember_group_channel_default = async (_event, next) => {
	const [event] = useEvent();
	const current = event.current;
	if (!current.IsPrivate && current.ChannelId) try {
		await rememberGroupChannel(String(current.ChannelId), current.BotId);
	} catch (error) {
		logger.warn({
			err: error,
			channelId: current.ChannelId
		}, "记录 QQ 群主动消息目标失败");
	}
	await next();
};

//#endregion
export { remember_group_channel_default as default };