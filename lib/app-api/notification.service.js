import { getPool } from "../database/pool.js";
import { createHash } from "node:crypto";

//#region src/app-api/notification.service.ts
let schemaReady;
const schemaSql = `CREATE TABLE IF NOT EXISTS web_notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  player_id BIGINT UNSIGNED NOT NULL,
  dedupe_key VARCHAR(191) NOT NULL,
  dedupe_hash BINARY(32) NOT NULL,
  category VARCHAR(32) NOT NULL DEFAULT 'system',
  title VARCHAR(120) NOT NULL DEFAULT '',
  payload_json JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_web_notifications_player_event (player_id,dedupe_hash),
  KEY idx_web_notifications_player_recent (player_id,id),
  KEY idx_web_notifications_player_unread (player_id,read_at,id),
  CONSTRAINT fk_web_notifications_player FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
) ENGINE=InnoDB`;
/** 按需建表；不在调用者的事务连接上执行 DDL，避免 MySQL 隐式提交。 */
const ensureWebNotificationInbox = async () => {
	if (!schemaReady) schemaReady = (async () => {
		await (await getPool()).query(schemaSql);
	})().catch((error) => {
		schemaReady = void 0;
		throw error;
	});
	await schemaReady;
};
const playerIdValue = (value) => {
	const playerId = Number(value);
	if (!Number.isSafeInteger(playerId) || playerId <= 0) throw new Error("玩家身份无效。");
	return playerId;
};
const boundedLimit = (value) => {
	const limit = Math.floor(Number(value) || 20);
	return Math.max(1, Math.min(100, limit));
};
const cursorValue = (value, name) => {
	if (value === void 0) return void 0;
	const cursor = Number(value);
	if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error(`${name} 无效。`);
	return cursor;
};
const toNotification = (row) => {
	let payload = {};
	try {
		payload = typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json;
	} catch {}
	return {
		id: Number(row.id),
		category: row.category,
		title: String(row.title),
		messages: Array.isArray(payload?.messages) ? payload.messages : [],
		isRead: row.read_at !== null,
		createdAt: new Date(row.created_at).toISOString(),
		readAt: row.read_at ? new Date(row.read_at).toISOString() : null
	};
};
/** 可传入业务事务连接，让事件与奖励、任务进度等业务写入同时提交。 */
const enqueueWebNotification = async (input, connection) => {
	await ensureWebNotificationInbox();
	const playerId = playerIdValue(input.playerId);
	const dedupeKey = String(input.dedupeKey ?? "").trim();
	if (!dedupeKey || dedupeKey.length > 191) throw new Error("通知事件键无效。");
	if (!Array.isArray(input.messages) || input.messages.length === 0) throw new Error("通知消息不能为空。");
	const category = input.category ?? "system";
	const title = String(input.title ?? "").trim().slice(0, 120);
	const payloadJson = JSON.stringify({ messages: input.messages });
	const dedupeHash = createHash("sha256").update(dedupeKey).digest();
	const [result] = await (connection ?? await getPool()).execute(`INSERT INTO web_notifications (player_id,dedupe_key,dedupe_hash,category,title,payload_json)
     VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`, [
		playerId,
		dedupeKey,
		dedupeHash,
		category,
		title,
		payloadJson
	]);
	return Number(result.insertId);
};
/** 本体命令只持有 qq_user_id 时，解析玩家归属后写入同一收件箱。 */
const enqueueWebNotificationForQqUser = async (qqUserId, input, connection) => {
	await ensureWebNotificationInbox();
	const userId = String(qqUserId ?? "").trim();
	if (!userId || userId.length > 32) throw new Error("玩家身份无效。");
	const db = connection ?? await getPool();
	const [rows] = await db.execute("SELECT id FROM players WHERE qq_user_id=? LIMIT 1", [userId]);
	const playerId = Number(rows[0]?.id ?? 0);
	if (!playerId) return null;
	return enqueueWebNotification({
		...input,
		playerId
	}, db);
};
const countUnreadWebNotifications = async (playerIdValueInput) => {
	await ensureWebNotificationInbox();
	const [rows] = await (await getPool()).execute("SELECT COUNT(*) AS count FROM web_notifications WHERE player_id=? AND read_at IS NULL", [playerIdValue(playerIdValueInput)]);
	return Number(rows[0]?.count ?? 0);
};
/** 最新一页与向前翻页共用；beforeId 使用严格小于，避免页边界重复。 */
const listWebNotifications = async (playerIdValueInput, options = {}) => {
	await ensureWebNotificationInbox();
	const db = await getPool();
	const playerId = playerIdValue(playerIdValueInput);
	const limit = boundedLimit(options.limit);
	const beforeId = cursorValue(options.beforeId, "通知游标");
	const args = [playerId];
	let where = "player_id=?";
	if (beforeId !== void 0) {
		where += " AND id<?";
		args.push(beforeId);
	}
	args.push(limit + 1);
	const [rows] = await db.execute(`SELECT id,category,title,payload_json,created_at,read_at
     FROM web_notifications WHERE ${where} ORDER BY id DESC LIMIT ?`, args);
	const hasMore = rows.length > limit;
	const items = rows.slice(0, limit).map(toNotification);
	return {
		items,
		unreadCount: await countUnreadWebNotifications(playerId),
		hasMore,
		nextBeforeId: hasMore ? items[items.length - 1]?.id ?? null : null
	};
};
/** 实时连接恢复时按 id 从旧到新补发；客户端可通过 id 去重。 */
const listWebNotificationsAfter = async (playerIdValueInput, afterIdValue, limitValue = 100) => {
	await ensureWebNotificationInbox();
	const db = await getPool();
	const afterId = cursorValue(afterIdValue, "通知游标") ?? 0;
	const [rows] = await db.execute(`SELECT id,category,title,payload_json,created_at,read_at
     FROM web_notifications WHERE player_id=? AND id>? ORDER BY id ASC LIMIT ?`, [
		playerIdValue(playerIdValueInput),
		afterId,
		boundedLimit(limitValue)
	]);
	return rows.map(toNotification);
};
/** 只更新指定玩家自己的通知；重复已读不会重复计数。 */
const markWebNotificationsRead = async (playerIdValueInput, ids) => {
	await ensureWebNotificationInbox();
	const playerId = playerIdValue(playerIdValueInput);
	if (!Array.isArray(ids)) throw new Error("通知编号无效。");
	const uniqueIds = [...new Set(ids.map(Number))];
	if (!uniqueIds.length) return 0;
	if (uniqueIds.length > 100 || uniqueIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("通知编号无效。");
	const [result] = await (await getPool()).execute(`UPDATE web_notifications SET read_at=NOW()
     WHERE player_id=? AND read_at IS NULL AND id IN (${uniqueIds.map(() => "?").join(",")})`, [playerId, ...uniqueIds]);
	return Number(result.affectedRows);
};
const markAllWebNotificationsRead = async (playerIdValueInput) => {
	await ensureWebNotificationInbox();
	const [result] = await (await getPool()).execute("UPDATE web_notifications SET read_at=NOW() WHERE player_id=? AND read_at IS NULL", [playerIdValue(playerIdValueInput)]);
	return Number(result.affectedRows);
};

//#endregion
export { countUnreadWebNotifications, enqueueWebNotification, enqueueWebNotificationForQqUser, ensureWebNotificationInbox, listWebNotifications, listWebNotificationsAfter, markAllWebNotificationsRead, markWebNotificationsRead };