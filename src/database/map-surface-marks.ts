import type { Pool, RowDataPacket } from 'mysql2/promise';

/** 事件与绘画数据同一行物化；调用方与移动/战斗结算同事务写入，唯一键持久去重。 */
export const initializeMapSurfaceMarks = async (pool: Pool) => {
  await pool.query(`CREATE TABLE IF NOT EXISTS map_surface_marks (
    event_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    scope_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    region_id BIGINT UNSIGNED NOT NULL, pos_x INT NOT NULL, pos_y INT NOT NULL, pos_z INT NOT NULL,
    end_x INT NULL, end_y INT NULL, kind ENUM('walk','blood','slime','debris','magic') NOT NULL,
    effect_seed INT UNSIGNED NOT NULL, intensity DECIMAL(5,4) NOT NULL,
    occurred_at_ms BIGINT NOT NULL, expires_at_ms BIGINT NOT NULL,
    PRIMARY KEY (event_key), KEY idx_surface_visible (scope_key,region_id,pos_z,kind,expires_at_ms,pos_x,pos_y),
    KEY idx_surface_window (scope_key,region_id,pos_z,kind,pos_x,pos_y,expires_at_ms),
    KEY idx_surface_expiry (expires_at_ms),
    CONSTRAINT fk_surface_region FOREIGN KEY (region_id) REFERENCES map_regions(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  // 兼容已创建的首版地表表；只追加局部窗口索引，不改事件、障碍或奖励数据。
  const [indexes] = await pool.query<RowDataPacket[]>(`SELECT INDEX_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='map_surface_marks' AND INDEX_NAME='idx_surface_window' LIMIT 1`);
  if (!indexes.length) {
    try { await pool.query('ALTER TABLE map_surface_marks ADD KEY idx_surface_window (scope_key,region_id,pos_z,kind,pos_x,pos_y,expires_at_ms)'); }
    catch (error: any) { if (error?.code !== 'ER_DUP_KEYNAME' && Number(error?.errno) !== 1061) throw error; }
  }
};
