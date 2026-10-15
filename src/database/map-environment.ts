import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { EnvironmentCell } from '../game/map-environment.config';
import { environmentV2Seed } from '../game/map-environment-v2.config';

export type EnvironmentRegistrationBounds = { regionId: number; minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
/** 整格闭区间：共用边界坐标即重叠，相邻的 max+1 格才不重叠。 */
export const environmentProfileBoundsOverlap = (a: EnvironmentRegistrationBounds, b: EnvironmentRegistrationBounds) =>
  a.regionId !== b.regionId && a.minX <= b.maxX && a.maxX >= b.minX
    && a.minY <= b.maxY && a.maxY >= b.minY && a.minZ <= b.maxZ && a.maxZ >= b.minZ;

/** 调用方必须持有事务；共享区域门闩串行化新世界登记，已有版本/种子永不 UPDATE。 */
export const registerMapEnvironmentProfileIn = async (connection: PoolConnection, regionId: number, version: 1 | 2, seed = environmentV2Seed) => {
  if (!Number.isSafeInteger(regionId) || regionId <= 0 || ![1, 2].includes(version) || typeof seed !== 'string' || !/^[a-zA-Z0-9:_-]{1,96}$/.test(seed)) throw new Error('环境生成档案参数无效。');
  // 不同关闭新区也必须共用当前读行锁；只锁各自 region/profile 会让双方
  // 都看不到对方尚未提交的档案，并把同一整格范围同时登记为两个世界。
  // 外层创建事务若产生死锁，应整体回滚，不能在本函数内吞错后继续提交。
  if (version === 2) await connection.execute('SELECT id FROM map_regions ORDER BY id LIMIT 1 FOR UPDATE');
  const [regions] = await connection.execute<RowDataPacket[]>('SELECT id,code,is_enabled FROM map_regions WHERE id=? FOR UPDATE', [regionId]);
  if (!regions[0]) throw new Error('地图区域不存在。');
  const [profiles] = await connection.execute<RowDataPacket[]>('SELECT generation_version,generation_seed FROM map_environment_region_profiles WHERE region_id=? FOR UPDATE', [regionId]);
  if (profiles[0]) {
    if (Number(profiles[0].generation_version) !== version || String(profiles[0].generation_seed) !== seed) throw new Error('区域已登记环境版本与种子，不能切换现有世界布局。');
    return { regionId, version, seed, inserted: false };
  }
  if (version === 2) {
    // 新对象身份必须可由清理入口的 canonical env2 ID 解析；旧档案的
    // 幂等调用不重新校验旧 code，避免兼容检查拒绝既有世界。
    if (typeof regions[0].code !== 'string' || !/^[a-z0-9_]{1,64}$/.test(regions[0].code)) throw new Error('新环境区域编号必须为1至64位小写字母、数字或下划线。');
    // 新区域先登记再发布；不能把已经进入过旧生成流程的公开区域当作新区域。
    if (Number(regions[0].is_enabled)) throw new Error('请在新区域开放之前登记环境版本2。');
    const [boundsRows] = await connection.execute<RowDataPacket[]>(`SELECT r.id AS region_id,
      COALESCE(a.min_x,r.min_x) AS min_x,COALESCE(a.max_x,r.max_x) AS max_x,
      COALESCE(a.min_y,r.min_y) AS min_y,COALESCE(a.max_y,r.max_y) AS max_y,
      COALESCE(a.min_z,r.min_z) AS min_z,COALESCE(a.max_z,r.max_z) AS max_z
      FROM map_regions r LEFT JOIN map_region_areas a ON a.region_id=r.id
      LEFT JOIN map_environment_region_profiles p ON p.region_id=r.id
      WHERE r.id=? OR r.is_enabled=1 OR p.region_id IS NOT NULL ORDER BY r.id,a.id FOR UPDATE`, [regionId]);
    const bounds = boundsRows.map(row => ({ regionId: Number(row.region_id), minX: Number(row.min_x), maxX: Number(row.max_x), minY: Number(row.min_y), maxY: Number(row.max_y), minZ: Number(row.min_z), maxZ: Number(row.max_z) }));
    if (!bounds.some(area => area.regionId === regionId) || bounds.some(area => ![area.regionId, area.minX, area.maxX, area.minY, area.maxY, area.minZ, area.maxZ].every(Number.isSafeInteger) || area.minX > area.maxX || area.minY > area.maxY || area.minZ > area.maxZ)) throw new Error('区域范围配置无效，不能登记环境版本。');
    if (bounds.filter(area => area.regionId === regionId).some(area => bounds.some(other => environmentProfileBoundsOverlap(area, other)))) throw new Error('新区域与已开放或已登记保留区域的整格范围重叠，不能改变既有世界布局。');
    const [occupied] = await connection.execute<RowDataPacket[]>(`SELECT '角色' AS kind FROM characters WHERE current_region_id=?
      UNION ALL SELECT '状态' FROM map_environment_states WHERE region_id=?
      UNION ALL SELECT '清理' FROM player_environment_jobs WHERE region_id=?
      UNION ALL SELECT '资源' FROM resource_spawns WHERE region_id=?
      UNION ALL SELECT '怪物' FROM monster_spawns WHERE region_id=?
      UNION ALL SELECT '前往' FROM player_travels WHERE region_id=? LIMIT 1`, Array(6).fill(regionId));
    if (occupied.length) throw new Error('区域已有角色、生成记录或进行中的活动，不能登记为新环境世界。');
  }
  await connection.execute('INSERT INTO map_environment_region_profiles (region_id,generation_version,generation_seed) VALUES (?,?,?)', [regionId, version, seed]);
  return { regionId, version, seed, inserted: true };
};
/** 显式新区域登记入口；仅使用调用方给定的 pool，不自行打开数据库。 */
export const registerMapEnvironmentProfile = async (pool: Pool, regionId: number, version: 1 | 2, seed = environmentV2Seed) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await registerMapEnvironmentProfileIn(connection, regionId, version, seed);
    await connection.commit();
    return result;
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
};

/** 旧存档首次启用时留出既有站位/资源/关键地点；此后普通 GET 只读。 */
const migrateLegacyEnvironmentProtections = async (pool: Pool) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const code = 'map_environment_legacy_protection_v1';
    const [done] = await connection.execute<RowDataPacket[]>('SELECT code FROM game_data_migrations WHERE code=? FOR UPDATE', [code]);
    if (done.length) { await connection.commit(); return; }
    const [positions] = await connection.execute<RowDataPacket[]>(`SELECT pos_x AS x,pos_y AS y,pos_z AS z,2 AS radius FROM map_npcs
      UNION ALL SELECT pos_x,pos_y,pos_z,2 FROM map_special_objects
      UNION ALL SELECT pos_x,pos_y,0,2 FROM dungeon_entrances
      UNION ALL SELECT plot_x,plot_y,plot_z,2 FROM player_homes WHERE status='active'
      UNION ALL SELECT pos_x,pos_y,pos_z,1 FROM resource_spawns WHERE mined_at IS NULL
      UNION ALL SELECT pos_x,pos_y,pos_z,1 FROM monster_spawns WHERE defeated_at IS NULL
      UNION ALL SELECT pos_x,pos_y,pos_z,0 FROM characters
      UNION ALL SELECT target_x,target_y,target_z,0 FROM player_travels`);
    const routes: EnvironmentCell[] = [];
    const [plans] = await connection.execute<RowDataPacket[]>("SELECT plan_json FROM player_travel_routes WHERE state='active'");
    for (const row of plans) {
      const plan = typeof row.plan_json === 'string' ? JSON.parse(row.plan_json) : row.plan_json;
      for (const leg of plan?.legs ?? []) {
        if (leg.kind !== 'walk') continue;
        const points = leg.waypoints?.length >= 2 ? leg.waypoints : [leg.from, leg.to];
        for (let index = 1; index < points.length; index++) {
          const from = points[index - 1], to = points[index];
          if (!from || !to || ![from.x, from.y, from.z, to.x, to.y, to.z].every(Number.isSafeInteger) || from.z !== to.z || from.z < 0) continue;
          if (Math.abs(to.x - from.x) + Math.abs(to.y - from.y) > 10000) throw new Error('旧前往路径超出环境迁移范围，请先检查异常存档。');
          // 旧无折点计划沿既有曼哈顿走法保留；有折点时逐整格保留原路。
          let x = from.x, y = from.y;
          routes.push({ x, y, z: from.z });
          while (x !== to.x || y !== to.y) {
            if (x !== to.x) x += Math.sign(to.x - x); else y += Math.sign(to.y - y);
            routes.push({ x, y, z: from.z });
          }
        }
      }
    }
    const { suppressEnvironmentForCells } = await import('../game/map-environment.service');
    const hidden = (await import('../game/map-hidden-mentor.locations')).mapHiddenMentorLocations;
    for (const radius of [0, 1, 2]) {
      const cells: EnvironmentCell[] = positions.filter(point => Number(point.radius) === radius).map(point => ({ x: Number(point.x), y: Number(point.y), z: Number(point.z) }));
      if (radius === 0) cells.push(...routes);
      if (radius === 2) cells.push(...hidden.map(point => ({ x: point.x, y: point.y, z: point.z })));
      const unique = [...new Map(cells.filter(cell => [cell.x, cell.y, cell.z].every(Number.isSafeInteger) && cell.z >= 0).map(cell => [`${cell.x}:${cell.y}:${cell.z}`, cell])).values()];
      for (let index = 0; index < unique.length; index += 80) await suppressEnvironmentForCells(connection, unique.slice(index, index + 80), radius);
    }
    await connection.execute('INSERT INTO game_data_migrations (code) VALUES (?)', [code]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
};

/** 由正常启动初始化调用；本模块不会自行打开数据库或执行生产迁移。 */
export const initializeMapEnvironment = async (pool: Pool) => {
  await pool.query(`CREATE TABLE IF NOT EXISTS map_environment_region_profiles (
    region_id BIGINT UNSIGNED NOT NULL, generation_version TINYINT UNSIGNED NOT NULL DEFAULT 1,
    generation_seed VARCHAR(96) NOT NULL, registered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (region_id),
    CONSTRAINT fk_environment_profile_region FOREIGN KEY (region_id) REFERENCES map_regions(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  // 既有区域首次显式冻结为1；重启绝不覆盖已经登记的2或其种子。
  await pool.query(`INSERT IGNORE INTO map_environment_region_profiles (region_id,generation_version,generation_seed)
    SELECT id,1,? FROM map_regions`, [environmentV2Seed]);
  await pool.query(`CREATE TABLE IF NOT EXISTS map_environment_states (
    object_id VARCHAR(160) NOT NULL, region_id BIGINT UNSIGNED NOT NULL,
    state ENUM('cleared','suppressed') NOT NULL, revision INT UNSIGNED NOT NULL DEFAULT 1,
    cleared_by BIGINT UNSIGNED NULL, changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (object_id), KEY idx_map_environment_region (region_id,state),
    CONSTRAINT fk_environment_region FOREIGN KEY (region_id) REFERENCES map_regions(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS player_environment_jobs (
    character_id BIGINT UNSIGNED NOT NULL, object_id VARCHAR(160) NOT NULL, job_id CHAR(36) NOT NULL,
    region_id BIGINT UNSIGNED NOT NULL, origin_x INT NOT NULL, origin_y INT NOT NULL, origin_z INT NOT NULL,
    object_json JSON NOT NULL, started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, finishes_at DATETIME NOT NULL,
    PRIMARY KEY (character_id), UNIQUE KEY uk_environment_job_object (object_id), UNIQUE KEY uk_environment_job_id (job_id),
    CONSTRAINT fk_environment_job_character FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT fk_environment_job_region FOREIGN KEY (region_id) REFERENCES map_regions(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS map_environment_rewards (
    object_id VARCHAR(160) NOT NULL, job_id CHAR(36) NOT NULL, character_id BIGINT UNSIGNED NOT NULL,
    rewards_json JSON NOT NULL, settled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (object_id), UNIQUE KEY uk_environment_reward_job (job_id), KEY idx_environment_reward_character (character_id,settled_at),
    CONSTRAINT fk_environment_reward_character FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await migrateLegacyEnvironmentProtections(pool);
};
