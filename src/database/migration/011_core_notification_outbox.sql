-- Core 与 QQ Gateway 之间的主动消息队列。
-- bootstrap.ts 会在启动时以 CREATE TABLE IF NOT EXISTS 保证旧库也能补齐；
-- 本文件用于人工部署、审计和独立迁移工具。
CREATE TABLE IF NOT EXISTS core_notification_outbox (
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
  KEY idx_core_notification_claim (status,lease_until,created_at),
  KEY idx_core_notification_target (provider,bot_id,scope,target_id,created_at)
) ENGINE=InnoDB;
