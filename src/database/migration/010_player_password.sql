-- Game ID + 密码统一登录：players 表增加密码与登录安全字段
ALTER TABLE players
  ADD COLUMN password_hash VARCHAR(256) NULL AFTER qq_nickname,
  ADD COLUMN password_updated_at DATETIME NULL AFTER password_hash,
  ADD COLUMN failed_login_count SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER password_updated_at,
  ADD COLUMN locked_until DATETIME NULL AFTER failed_login_count,
  ADD COLUMN last_login_at DATETIME NULL AFTER locked_until;

-- app_sessions 增加 player_id，兼容直接按玩家建立会话；app_user_id 不再必填
ALTER TABLE app_sessions ADD COLUMN player_id BIGINT UNSIGNED NULL AFTER app_user_id;
CREATE INDEX idx_app_sessions_player ON app_sessions (player_id, expires_at);
ALTER TABLE app_sessions MODIFY app_user_id VARCHAR(64) NULL;
