import { getPool, withTransaction } from "../database/pool.js";

//#region src/app-api/mail.service.ts
const playerIdValue = (value) => {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error("玩家身份无效。");
	return value;
};
const mailIdValue = (value) => {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error("邮件编号无效。");
	return value;
};
const isoTime = (value) => value ? new Date(value).toISOString() : null;
const mailSummary = (row) => ({
	id: Number(row.id),
	title: row.title,
	senderName: "游戏系统",
	createdAt: isoTime(row.received_at),
	isRead: row.read_at !== null,
	hasAttachments: Boolean(row.has_attachments),
	claimedAt: isoTime(row.claimed_at),
	preview: row.content.replace(/\s+/g, " ").trim().slice(0, 100)
});
const countUnreadGameMailsWith = async (db, playerId) => {
	const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM player_mails m
     JOIN characters c ON c.id=m.character_id
     WHERE c.player_id=? AND c.npc_code IS NULL AND m.deleted_at IS NULL AND m.read_at IS NULL`, [playerIdValue(playerId)]);
	return Number(rows[0]?.total ?? 0);
};
const countUnreadGameMails = async (playerId) => countUnreadGameMailsWith(await getPool(), playerId);
/** 游戏邮件与 Web 事件通知分开存储；游标始终按邮件 id 倒序。 */
const listGameMails = async (playerId, options = {}) => {
	const db = await getPool();
	const ownerId = playerIdValue(playerId);
	const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit) || 20)));
	const beforeId = options.beforeId;
	if (beforeId !== void 0 && (!Number.isSafeInteger(beforeId) || beforeId < 0)) throw new Error("邮件游标无效。");
	const filter = options.filter ?? "all";
	if (![
		"all",
		"unread",
		"attachments"
	].includes(filter)) throw new Error("邮件筛选条件无效。");
	const where = [
		"c.player_id=?",
		"c.npc_code IS NULL",
		"m.deleted_at IS NULL"
	];
	const args = [ownerId];
	if (beforeId !== void 0) {
		where.push("m.id<?");
		args.push(beforeId);
	}
	if (filter === "unread") where.push("m.read_at IS NULL");
	if (filter === "attachments") where.push("EXISTS (SELECT 1 FROM player_mail_attachments a WHERE a.mail_id=m.id)");
	args.push(limit + 1);
	const [rows] = await db.execute(`SELECT m.id,m.title,m.content,m.received_at,m.read_at,m.claimed_at,
       EXISTS (SELECT 1 FROM player_mail_attachments a WHERE a.mail_id=m.id) AS has_attachments
     FROM player_mails m JOIN characters c ON c.id=m.character_id
     WHERE ${where.join(" AND ")} ORDER BY m.id DESC LIMIT ?`, args);
	const hasMore = rows.length > limit;
	const items = rows.slice(0, limit).map(mailSummary);
	return {
		items,
		unreadCount: await countUnreadGameMails(ownerId),
		hasMore,
		nextBeforeId: hasMore ? items[items.length - 1]?.id ?? null : null
	};
};
/** 阅读详情时只标记当前玩家的邮件，附件仍由游戏邮件服务领取。 */
const gameMailDetail = async (playerId, mailId) => withTransaction(async (db) => {
	const ownerId = playerIdValue(playerId);
	const id = mailIdValue(mailId);
	const [rows] = await db.execute(`SELECT m.id,m.title,m.content,m.received_at,m.read_at,m.claimed_at,
       EXISTS (SELECT 1 FROM player_mail_attachments a WHERE a.mail_id=m.id) AS has_attachments
     FROM player_mails m JOIN characters c ON c.id=m.character_id
     WHERE m.id=? AND c.player_id=? AND c.npc_code IS NULL AND m.deleted_at IS NULL FOR UPDATE`, [id, ownerId]);
	const mail = rows[0];
	if (!mail) throw new Error("邮件不存在或已被删除。");
	if (mail.read_at === null) {
		await db.execute(`UPDATE player_mails m JOIN characters c ON c.id=m.character_id
       SET m.read_at=NOW() WHERE m.id=? AND c.player_id=? AND c.npc_code IS NULL AND m.deleted_at IS NULL AND m.read_at IS NULL`, [id, ownerId]);
		const [readRows] = await db.execute("SELECT read_at FROM player_mails WHERE id=?", [id]);
		mail.read_at = readRows[0]?.read_at ?? /* @__PURE__ */ new Date();
	}
	const [attachments] = await db.execute(`SELECT a.item_id,i.code,i.name,a.quantity,i.rarity,i.item_type
     FROM player_mail_attachments a JOIN item_definitions i ON i.id=a.item_id
     WHERE a.mail_id=? ORDER BY a.id`, [id]);
	return {
		item: {
			...mailSummary(mail),
			body: mail.content,
			readAt: isoTime(mail.read_at),
			attachments: attachments.map((attachment) => ({
				itemId: Number(attachment.item_id),
				code: attachment.code,
				name: attachment.name,
				quantity: Number(attachment.quantity),
				rarity: attachment.rarity,
				itemType: attachment.item_type
			}))
		},
		unreadCount: await countUnreadGameMailsWith(db, ownerId)
	};
});

//#endregion
export { countUnreadGameMails, gameMailDetail, listGameMails };