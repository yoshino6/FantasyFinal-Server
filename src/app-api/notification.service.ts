import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { getPool } from '../database/pool';
import type { AppMessage } from './app-format';

type Db = Pool | PoolConnection;

export type WebNotificationCategory =
  | 'system'
  | 'command'
  | 'quest'
  | 'achievement'
  | 'battle'
  | 'party'
  | 'friend'
  | 'mail'
  | 'world';

export type WebNotificationInput = {
  playerId: number;
  /** 同一玩家内稳定、唯一的业务事件键；重复入队只会返回原通知 id。 */
  dedupeKey: string;
  category?: WebNotificationCategory;
  title?: string;
  /** 保留正文、图片、按钮及 Alemon Format 节点，供 Web 客户端完整呈现。 */
  messages: AppMessage[];
};

export type WebNotification = {
  id: number;
  category: WebNotificationCategory;
  title: string;
  messages: AppMessage[];
  isRead: boolean;
  createdAt: string;
  readAt: string | null;
};

export type WebNotificationPage = {
  /** 按 id 从新到旧排列。 */
  items: WebNotification[];
  unreadCount: number;
  hasMore: boolean;
  /** 继续读取更早消息时作为 beforeId；没有更多消息时为 null。 */
  nextBeforeId: number | null;
};

type WebNotificationRow = RowDataPacket & {
  id: number;
  category: WebNotificationCategory;
  title: string;
  payload_json: string | { messages?: AppMessage[] };
  created_at: Date | string;
  read_at: Date | string | null;
};

let schemaReady: Promise<void> | undefined;

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
export const ensureWebNotificationInbox = async () => {
  if (!schemaReady) {
    schemaReady = (async () => {
      const pool = await getPool();
      await pool.query(schemaSql);
    })().catch(error => {
      schemaReady = undefined;
      throw error;
    });
  }
  await schemaReady;
};

const playerIdValue = (value: number) => {
  const playerId = Number(value);
  if (!Number.isSafeInteger(playerId) || playerId <= 0) throw new Error('玩家身份无效。');
  return playerId;
};

const boundedLimit = (value: number | undefined) => {
  const limit = Math.floor(Number(value) || 20);
  return Math.max(1, Math.min(100, limit));
};

const cursorValue = (value: number | undefined, name: string) => {
  if (value === undefined) return undefined;
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error(`${name} 无效。`);
  return cursor;
};

const toNotification = (row: WebNotificationRow): WebNotification => {
  let payload: { messages?: AppMessage[] } = {};
  try {
    payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json;
  } catch { /* 历史损坏记录仍可显示标题。 */ }
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
export const enqueueWebNotification = async (input: WebNotificationInput, connection?: Db): Promise<number> => {
  await ensureWebNotificationInbox();
  const playerId = playerIdValue(input.playerId);
  const dedupeKey = String(input.dedupeKey ?? '').trim();
  if (!dedupeKey || dedupeKey.length > 191) throw new Error('通知事件键无效。');
  if (!Array.isArray(input.messages) || input.messages.length === 0) throw new Error('通知消息不能为空。');
  const category = input.category ?? 'system';
  const title = String(input.title ?? '').trim().slice(0, 120);
  const payloadJson = JSON.stringify({ messages: input.messages });
  const dedupeHash = createHash('sha256').update(dedupeKey).digest();
  const db = connection ?? await getPool();
  const [result] = await db.execute<ResultSetHeader>(
    `INSERT INTO web_notifications (player_id,dedupe_key,dedupe_hash,category,title,payload_json)
     VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
    [playerId, dedupeKey, dedupeHash, category, title, payloadJson]
  );
  return Number(result.insertId);
};

/** 本体命令只持有 qq_user_id 时，解析玩家归属后写入同一收件箱。 */
export const enqueueWebNotificationForQqUser = async (
  qqUserId: string,
  input: Omit<WebNotificationInput, 'playerId'>,
  connection?: Db
): Promise<number | null> => {
  await ensureWebNotificationInbox();
  const userId = String(qqUserId ?? '').trim();
  if (!userId || userId.length > 32) throw new Error('玩家身份无效。');
  const db = connection ?? await getPool();
  const [rows] = await db.execute<(RowDataPacket & { id: number })[]>(
    'SELECT id FROM players WHERE qq_user_id=? LIMIT 1',
    [userId]
  );
  const playerId = Number(rows[0]?.id ?? 0);
  if (!playerId) return null;
  return enqueueWebNotification({ ...input, playerId }, db);
};

export const countUnreadWebNotifications = async (playerIdValueInput: number): Promise<number> => {
  await ensureWebNotificationInbox();
  const db = await getPool();
  const [rows] = await db.execute<(RowDataPacket & { count: number })[]>(
    'SELECT COUNT(*) AS count FROM web_notifications WHERE player_id=? AND read_at IS NULL',
    [playerIdValue(playerIdValueInput)]
  );
  return Number(rows[0]?.count ?? 0);
};

/** 最新一页与向前翻页共用；beforeId 使用严格小于，避免页边界重复。 */
export const listWebNotifications = async (
  playerIdValueInput: number,
  options: { limit?: number; beforeId?: number } = {}
): Promise<WebNotificationPage> => {
  await ensureWebNotificationInbox();
  const db = await getPool();
  const playerId = playerIdValue(playerIdValueInput);
  const limit = boundedLimit(options.limit);
  const beforeId = cursorValue(options.beforeId, '通知游标');
  const args: Array<number> = [playerId];
  let where = 'player_id=?';
  if (beforeId !== undefined) {
    where += ' AND id<?';
    args.push(beforeId);
  }
  args.push(limit + 1);
  const [rows] = await db.execute<WebNotificationRow[]>(
    `SELECT id,category,title,payload_json,created_at,read_at
     FROM web_notifications WHERE ${where} ORDER BY id DESC LIMIT ?`,
    args
  );
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
export const listWebNotificationsAfter = async (
  playerIdValueInput: number,
  afterIdValue: number,
  limitValue = 100
): Promise<WebNotification[]> => {
  await ensureWebNotificationInbox();
  const db = await getPool();
  const afterId = cursorValue(afterIdValue, '通知游标') ?? 0;
  const [rows] = await db.execute<WebNotificationRow[]>(
    `SELECT id,category,title,payload_json,created_at,read_at
     FROM web_notifications WHERE player_id=? AND id>? ORDER BY id ASC LIMIT ?`,
    [playerIdValue(playerIdValueInput), afterId, boundedLimit(limitValue)]
  );
  return rows.map(toNotification);
};

/** 只更新指定玩家自己的通知；重复已读不会重复计数。 */
export const markWebNotificationsRead = async (playerIdValueInput: number, ids: readonly number[]): Promise<number> => {
  await ensureWebNotificationInbox();
  const playerId = playerIdValue(playerIdValueInput);
  if (!Array.isArray(ids)) throw new Error('通知编号无效。');
  const uniqueIds = [...new Set(ids.map(Number))];
  if (!uniqueIds.length) return 0;
  if (uniqueIds.length > 100 || uniqueIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('通知编号无效。');
  const db = await getPool();
  const [result] = await db.execute<ResultSetHeader>(
    `UPDATE web_notifications SET read_at=NOW()
     WHERE player_id=? AND read_at IS NULL AND id IN (${uniqueIds.map(() => '?').join(',')})`,
    [playerId, ...uniqueIds]
  );
  return Number(result.affectedRows);
};

export const markAllWebNotificationsRead = async (playerIdValueInput: number): Promise<number> => {
  await ensureWebNotificationInbox();
  const db = await getPool();
  const [result] = await db.execute<ResultSetHeader>(
    'UPDATE web_notifications SET read_at=NOW() WHERE player_id=? AND read_at IS NULL',
    [playerIdValue(playerIdValueInput)]
  );
  return Number(result.affectedRows);
};
