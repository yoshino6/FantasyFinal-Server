import { getPool } from "../../database/pool.js";

//#region src/core/notification/outbox.service.ts
let schemaReady;
const jsonObject = (value) => {
	if (typeof value === "string") try {
		return JSON.parse(value);
	} catch {
		return {};
	}
	return value;
};
const asIso = (value) => value ? new Date(value).toISOString() : null;
const toRecord = (row) => {
	const payload = jsonObject(row.payload_json);
	return {
		id: Number(row.id),
		dedupeKey: String(row.dedupe_key),
		provider: "qq",
		botId: row.bot_id ? String(row.bot_id) : void 0,
		scope: row.scope,
		targetId: String(row.target_id),
		actorId: row.actor_id ? String(row.actor_id) : void 0,
		messages: Array.isArray(payload.messages) ? payload.messages : [],
		status: row.status,
		attempts: Number(row.attempts),
		leaseUntil: asIso(row.lease_until),
		lastError: row.last_error ? String(row.last_error) : null,
		createdAt: asIso(row.created_at) ?? (/* @__PURE__ */ new Date(0)).toISOString(),
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
const ensureNotificationOutbox = async (pool) => {
	if (schemaReady) return schemaReady;
	schemaReady = (async () => {
		await (pool ?? await getPool()).query(schemaSql);
	})().catch((error) => {
		schemaReady = void 0;
		throw error;
	});
	return schemaReady;
};
const enqueueNotification = async (input, connection) => {
	const db = connection ?? await getPool();
	await ensureNotificationOutbox(db);
	const [result] = await db.execute(`INSERT INTO core_notification_outbox
      (dedupe_key,provider,bot_id,scope,target_id,actor_id,payload_json)
      VALUES (?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`, [
		input.dedupeKey,
		input.provider,
		input.botId ?? null,
		input.scope,
		input.targetId,
		input.actorId ?? null,
		JSON.stringify({ messages: input.messages })
	]);
	return Number(result.insertId);
};
const claimNotifications = async (consumerId, limit = 20, leaseSeconds = 60) => {
	const pool = await getPool();
	await ensureNotificationOutbox(pool);
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		const [rows] = await connection.query(`SELECT * FROM core_notification_outbox
       WHERE status='pending' OR (status='sending' AND lease_until<NOW())
       ORDER BY created_at,id LIMIT ? FOR UPDATE`, [Math.max(1, Math.min(100, Number(limit) || 20))]);
		const claimed = [];
		for (const row of rows) {
			await connection.execute(`UPDATE core_notification_outbox
         SET status='sending',attempts=attempts+1,lease_until=DATE_ADD(NOW(),INTERVAL ? SECOND),last_error=NULL
         WHERE id=?`, [Math.max(10, Math.min(600, Number(leaseSeconds) || 60)), row.id]);
			claimed.push(toRecord({
				...row,
				status: "sending",
				attempts: Number(row.attempts) + 1
			}));
		}
		await connection.commit();
		return claimed.map((item) => ({
			...item,
			leaseUntil: new Date(Date.now() + Math.max(10, Math.min(600, Number(leaseSeconds) || 60)) * 1e3).toISOString()
		}));
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};
const acknowledgeNotification = async (id, status, detail) => {
	const pool = await getPool();
	await ensureNotificationOutbox(pool);
	const safeDetail = String(detail ?? "").trim().slice(0, 500) || null;
	await pool.execute(`UPDATE core_notification_outbox
     SET status=?,lease_until=NULL,last_error=?,sent_at=CASE WHEN ?='sent' THEN NOW() ELSE sent_at END
     WHERE id=? AND status='sending'`, [
		status,
		status === "sent" ? null : safeDetail,
		status,
		Number(id)
	]);
};
const notificationOutboxHealth = async () => {
	const pool = await getPool();
	await ensureNotificationOutbox(pool);
	const [rows] = await pool.query(`SELECT status,COUNT(*) AS count FROM core_notification_outbox GROUP BY status`);
	return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.count)]));
};

//#endregion
export { acknowledgeNotification, claimNotifications, enqueueNotification, ensureNotificationOutbox, notificationOutboxHealth };