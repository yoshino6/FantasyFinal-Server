import { getPool } from "../database/pool.js";

//#region src/game/group-channel.service.ts
/** 记录机器人已知的 QQ 群。私聊触发的全群公告依赖这份持久化名册。 */
const rememberGroupChannel = async (groupOpenId, botId) => {
	const groupId = String(groupOpenId ?? "").trim();
	const activeBotId = String(botId ?? "").trim();
	if (!groupId || !activeBotId) return;
	await (await getPool()).execute(`INSERT INTO bot_group_channels (bot_id,group_openid,last_seen_at)
    VALUES (?,?,NOW()) ON DUPLICATE KEY UPDATE last_seen_at=VALUES(last_seen_at)`, [activeBotId, groupId]);
};
const knownGroupChannels = async (botId) => {
	const activeBotId = String(botId ?? "").trim();
	if (!activeBotId) return [];
	const [rows] = await (await getPool()).execute("SELECT group_openid FROM bot_group_channels WHERE bot_id=? ORDER BY last_seen_at DESC", [activeBotId]);
	return rows.map((row) => String(row.group_openid)).filter(Boolean);
};

//#endregion
export { knownGroupChannels, rememberGroupChannel };