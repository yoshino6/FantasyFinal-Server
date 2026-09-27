import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { getPool } from '../../database/pool';

export type NotificationScope = 'private' | 'group' | 'channel';
export type NotificationStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain';

export type NotificationMessage = {
  kind: 'text' | 'markdown' | 'image';
  text?: string;
  /** 原版 Alemon Format.value；通知跨进程时与即时命令保持同一消息结构。 */
  format?: Array<{ type?: string; value?: unknown; options?: Record<string, unknown> }>;
  markdown?: string;
  url?: string;
  buttons?: Array<{ label: string; command: string; execution: 'manual' }>;
  mentionActor?: boolean;
};

export type NotificationInput = {
  dedupeKey: string;
  provider: 'qq';
  botId?: string;
  scope: NotificationScope;
  targetId: string;
  actorId?: string;
  messages: NotificationMessage[];
};

export type NotificationRecord = NotificationInput & {
  id: number;
  status: NotificationStatus;
  attempts: number;
  leaseUntil: string | null;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
};

type NotificationRow = RowDataPacket & {
  id: number;
  dedupe_key: string;
  provider: 'qq';
  bot_id: string | null;
  scope: NotificationScope;
  target_id: string;
  actor_id: string | null;
  payload_json: string | Record<string, unknown>;
  status: NotificationStatus;
  attempts: number;
  lease_until: Date | string | null;
  last_error: string | null;
  created_at: Date | string;
  sent_at: Date | string | null;
};

let schemaReady: Promise<void> | undefined;

const jsonObject = (value: string | Record<string, unknown>) => {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as { messages?: NotificationMessage[] }; } catch { return {}; }
  }
  return value;
};

const asIso = (value: Date | string | null) => value ? new Date(value).toISOString() : null;

const toRecord = (row: NotificationRow): NotificationRecord => {
  const payload = jsonObject(row.payload_json);
  return {
    id: Number(row.id),
    dedupeKey: String(row.dedupe_key),
    provider: 'qq',
    botId: row.bot_id ? String(row.bot_id) : undefined,
    scope: row.scope,
    targetId: String(row.target_id),
    actorId: row.actor_id ? String(row.actor_id) : undefined,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    status: row.status,
    attempts: Number(row.attempts),
    leaseUntil: asIso(row.lease_until),
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: asIso(row.created_at) ?? new Date(0).toISOString(),
    sentAt: asIso(row.sent_at)
  };
};

const schemaSql = `CREATE TABLE IF NOT EXISTS core_notification_outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  dedupe_key VARCHAR(191) NOT NULL,
  provider ENUM('qq') NOT NULL,
  bot_id VARCHAR(64) NULL,
  scope ENUM('private','group','channel') NOT NULL,
  target_id VARCHAR(128) NOT NULL,
  actor_id VARCHAR(64) NULL,
  payload_json JSON NOT NULL,
  status ENUM('pending','sending','sent','failed','uncertain') NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  lease_until DATETIME NULL,
  last_error VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  sent_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_core_notification_dedupe (dedupe_key),
  KEY idx_core_notification_claim (status, lease_until, created_at),
  KEY idx_core_notification_target (provider, bot_id, scope, target_id, created_at)
) ENGINE=InnoDB`;

export const ensureNotificationOutbox = async (pool?: Pool | PoolConnection) => {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const connection = pool ?? await getPool();
    await connection.query(schemaSql);
  })().catch(error => {
    schemaReady = undefined;
    throw error;
  });
  return schemaReady;
};

export const enqueueNotification = async (input: NotificationInput, connection?: Pool | PoolConnection) => {
  const db = connection ?? await getPool();
  await ensureNotificationOutbox(db);
  const [result] = await db.execute<ResultSetHeader>(
    `INSERT INTO core_notification_outbox
      (dedupe_key,provider,bot_id,scope,target_id,actor_id,payload_json)
      VALUES (?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
    [input.dedupeKey, input.provider, input.botId ?? null, input.scope, input.targetId, input.actorId ?? null, JSON.stringify({ messages: input.messages })]
  );
  return Number(result.insertId);
};

export const claimNotifications = async (consumerId: string, limit = 20, leaseSeconds = 60): Promise<NotificationRecord[]> => {
  void consumerId;
  const pool = await getPool();
  await ensureNotificationOutbox(pool);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // 兼容 MySQL 5.7 / 较旧 MariaDB：这些版本不支持 SKIP LOCKED。
    // 普通 FOR UPDATE 会让并发领取者串行等待；前一个事务提交后，后一个
    // 事务会按最新状态重新判断条件，因此不会重复领取同一条通知。
    const [rows] = await connection.query<NotificationRow[]>(
      `SELECT * FROM core_notification_outbox
       WHERE status='pending' OR (status='sending' AND lease_until<NOW())
       ORDER BY created_at,id LIMIT ? FOR UPDATE`,
      [Math.max(1, Math.min(100, Number(limit) || 20))]
    );
    const claimed: NotificationRecord[] = [];
    for (const row of rows) {
      await connection.execute(
        `UPDATE core_notification_outbox
         SET status='sending',attempts=attempts+1,lease_until=DATE_ADD(NOW(),INTERVAL ? SECOND),last_error=NULL
         WHERE id=?`,
        [Math.max(10, Math.min(600, Number(leaseSeconds) || 60)), row.id]
      );
      claimed.push(toRecord({ ...row, status: 'sending', attempts: Number(row.attempts) + 1 }));
    }
    await connection.commit();
    return claimed.map(item => ({ ...item, leaseUntil: new Date(Date.now() + Math.max(10, Math.min(600, Number(leaseSeconds) || 60)) * 1000).toISOString() }));
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

export const acknowledgeNotification = async (id: number, status: Exclude<NotificationStatus, 'pending' | 'sending'>, detail?: string) => {
  const pool = await getPool();
  await ensureNotificationOutbox(pool);
  const safeDetail = String(detail ?? '').trim().slice(0, 500) || null;
  await pool.execute(
    `UPDATE core_notification_outbox
     SET status=?,lease_until=NULL,last_error=?,sent_at=CASE WHEN ?='sent' THEN NOW() ELSE sent_at END
     WHERE id=? AND status='sending'`,
    [status, status === 'sent' ? null : safeDetail, status, Number(id)]
  );
};

export const notificationOutboxHealth = async () => {
  const pool = await getPool();
  await ensureNotificationOutbox(pool);
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT status,COUNT(*) AS count FROM core_notification_outbox GROUP BY status`);
  return Object.fromEntries(rows.map(row => [String(row.status), Number(row.count)]));
};
