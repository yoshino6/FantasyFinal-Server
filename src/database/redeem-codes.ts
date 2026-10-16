import type { Pool, RowDataPacket } from 'mysql2/promise';

const campaignForeignKeyExists = async (pool: Pick<Pool, 'query'>, tableName: string, constraintName: string) => {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME,
    REFERENCED_TABLE_SCHEMA=TABLE_SCHEMA AS references_current_schema
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME=? ORDER BY ORDINAL_POSITION`, [tableName, constraintName]);
  return rows.length === 1 && rows[0].COLUMN_NAME === 'campaign_id'
    && rows[0].REFERENCED_TABLE_NAME === 'web_redeem_campaigns' && rows[0].REFERENCED_COLUMN_NAME === 'id'
    && Number(rows[0].references_current_schema) === 1;
};

/** Empty tables only: reward codes are configured by the administrator, never seeded at startup. */
export const ensureRedeemCodeSchema = async (pool: Pick<Pool, 'query'>) => {
  await pool.query(`CREATE TABLE IF NOT EXISTS web_redeem_campaigns (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, name VARCHAR(96) NOT NULL,
    mail_title VARCHAR(96) NOT NULL, mail_content TEXT NOT NULL, rewards_json JSON NOT NULL,
    status ENUM('draft','active','paused') NOT NULL DEFAULT 'draft',
    start_at_ms BIGINT UNSIGNED NULL, end_at_ms BIGINT UNSIGNED NULL,
    min_level INT UNSIGNED NOT NULL DEFAULT 1, max_level INT UNSIGNED NULL,
    total_claim_limit INT UNSIGNED NULL, per_player_limit INT UNSIGNED NOT NULL DEFAULT 1,
    claims_count INT UNSIGNED NOT NULL DEFAULT 0,
    request_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, created_by VARCHAR(32) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id), UNIQUE KEY uk_redeem_campaign_request (request_key)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS web_redeem_batches (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, campaign_id BIGINT UNSIGNED NOT NULL,
    request_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, created_by VARCHAR(32) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id), UNIQUE KEY uk_redeem_batch_request (campaign_id,request_key),
    CONSTRAINT fk_redeem_batch_campaign FOREIGN KEY (campaign_id) REFERENCES web_redeem_campaigns(id)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS web_redeem_codes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    title VARCHAR(96) NOT NULL, content TEXT NOT NULL, rewards_json JSON NOT NULL,
    enabled TINYINT UNSIGNED NOT NULL DEFAULT 1, expires_at DATETIME NULL,
    max_uses INT UNSIGNED NULL, uses_count INT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id), UNIQUE KEY uk_web_redeem_code_hash (code_hash)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS web_redeem_code_claims (
    code_id BIGINT UNSIGNED NOT NULL, player_id BIGINT UNSIGNED NOT NULL,
    mail_id BIGINT UNSIGNED NOT NULL, claimed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (code_id,player_id), KEY idx_web_redeem_claim_player (player_id),
    CONSTRAINT fk_web_redeem_claim_code FOREIGN KEY (code_id) REFERENCES web_redeem_codes(id) ON DELETE CASCADE,
    CONSTRAINT fk_web_redeem_claim_player FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  // Hash-only legacy codes and their claims remain usable; no campaign or reward is fabricated.
  for (const statement of [
    'ALTER TABLE web_redeem_codes ADD COLUMN campaign_id BIGINT UNSIGNED NULL',
    'ALTER TABLE web_redeem_codes ADD COLUMN batch_id BIGINT UNSIGNED NULL',
    'ALTER TABLE web_redeem_codes ADD COLUMN code_text VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL',
    'ALTER TABLE web_redeem_codes ADD COLUMN issued_at DATETIME NULL',
    'ALTER TABLE web_redeem_codes ADD COLUMN deleted_at DATETIME NULL',
    'ALTER TABLE web_redeem_code_claims ADD COLUMN campaign_id BIGINT UNSIGNED NULL',
    'ALTER TABLE web_redeem_codes ADD KEY idx_redeem_code_campaign (campaign_id,deleted_at,id)',
    'ALTER TABLE web_redeem_codes ADD KEY idx_redeem_code_batch (batch_id,id)',
    'ALTER TABLE web_redeem_code_claims ADD KEY idx_redeem_claim_campaign (campaign_id,player_id)'
  ]) {
    try { await pool.query(statement); }
    catch (error: any) { if (!['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME'].includes(error?.code)) throw error; }
  }
  // MySQL 5.7 can report an existing foreign-key name as ER_DUP_KEY (1022).
  // Inspect the actual relationship first; never hide an unrelated duplicate-key error.
  for (const [tableName, constraintName] of [
    ['web_redeem_codes', 'fk_redeem_code_campaign'],
    ['web_redeem_code_claims', 'fk_redeem_claim_campaign']
  ]) {
    if (await campaignForeignKeyExists(pool, tableName, constraintName)) continue;
    try {
      await pool.query(`ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} FOREIGN KEY (campaign_id) REFERENCES web_redeem_campaigns(id)`);
    } catch (error: any) {
      const duplicateName = ['ER_DUP_KEY', 'ER_FK_DUP_NAME'].includes(error?.code) || [1022, 1826].includes(Number(error?.errno));
      // Another startup may have added it after our check. Only accept a verified foreign key.
      if (!duplicateName || !await campaignForeignKeyExists(pool, tableName, constraintName)) throw error;
    }
  }
};
