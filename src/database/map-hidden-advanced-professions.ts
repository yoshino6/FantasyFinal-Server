import type { Pool, RowDataPacket } from 'mysql2/promise';
import { mapHiddenMentorLocations } from '../game/map-hidden-mentor.locations';
import { mapHiddenAdvancedQuests } from '../game/map-hidden-advanced-quest.config';
import { mapHiddenAdvancedProfessions } from '../game/advanced-profession.config';

type Region = RowDataPacket & { id: number; code: string; is_enabled: number; is_owner_only: number };

/** 坐标及发现、进度、永久资格独立保存，不能误入公开地图/NPC 查询。 */
export const initializeMapHiddenAdvancedProfessions = async (pool: Pool) => {
  await pool.query(`CREATE TABLE IF NOT EXISTS map_hidden_advanced_mentors (
    mentor_code VARCHAR(64) NOT NULL, profession_code VARCHAR(64) NOT NULL, region_id BIGINT UNSIGNED NOT NULL,
    pos_x INT NOT NULL, pos_y INT NOT NULL, pos_z INT NOT NULL, minimum_range TINYINT UNSIGNED NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    PRIMARY KEY (mentor_code), UNIQUE KEY uk_map_hidden_profession (profession_code),
    UNIQUE KEY uk_map_hidden_cell (region_id,pos_x,pos_y,pos_z),
    CONSTRAINT fk_map_hidden_mentor_region FOREIGN KEY (region_id) REFERENCES map_regions(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS player_map_hidden_advanced_discoveries (
    character_id BIGINT UNSIGNED NOT NULL, mentor_code VARCHAR(64) NOT NULL,
    discovered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (character_id,mentor_code),
    CONSTRAINT fk_map_hidden_discovery_character FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT fk_map_hidden_discovery_mentor FOREIGN KEY (mentor_code) REFERENCES map_hidden_advanced_mentors(mentor_code)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS player_map_hidden_advanced_quests (
    character_id BIGINT UNSIGNED NOT NULL, profession_code VARCHAR(64) NOT NULL,
    stage TINYINT UNSIGNED NOT NULL DEFAULT 2, revision INT UNSIGNED NOT NULL DEFAULT 0,
    observed_kills SMALLINT UNSIGNED NOT NULL DEFAULT 0, proof_kills SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    trial_spawn_id BIGINT UNSIGNED NULL, practice_spawn_id BIGINT UNSIGNED NULL, practice_spawn_id_2 BIGINT UNSIGNED NULL,
    accepted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (character_id,profession_code), KEY idx_map_hidden_quest_active (character_id,stage),
    CONSTRAINT fk_map_hidden_quest_character FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    CONSTRAINT fk_map_hidden_quest_spawn FOREIGN KEY (trial_spawn_id) REFERENCES monster_spawns(id) ON DELETE SET NULL,
    CONSTRAINT fk_map_hidden_quest_practice_spawn FOREIGN KEY (practice_spawn_id) REFERENCES monster_spawns(id) ON DELETE SET NULL,
    CONSTRAINT fk_map_hidden_quest_practice_spawn_2 FOREIGN KEY (practice_spawn_id_2) REFERENCES monster_spawns(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);
  try { await pool.query('ALTER TABLE player_map_hidden_advanced_quests ADD COLUMN practice_spawn_id BIGINT UNSIGNED NULL AFTER trial_spawn_id'); }
  catch (error: any) { if (error?.code !== 'ER_DUP_FIELDNAME') throw error; }
  try { await pool.query('ALTER TABLE player_map_hidden_advanced_quests ADD COLUMN practice_spawn_id_2 BIGINT UNSIGNED NULL AFTER practice_spawn_id'); }
  catch (error: any) { if (error?.code !== 'ER_DUP_FIELDNAME') throw error; }
  await pool.query(`CREATE TABLE IF NOT EXISTS player_map_hidden_advanced_qualifications (
    character_id BIGINT UNSIGNED NOT NULL, profession_code VARCHAR(64) NOT NULL,
    qualified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (character_id,profession_code),
    CONSTRAINT fk_map_hidden_qualification_character FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS player_map_hidden_advanced_victories (
    character_id BIGINT UNSIGNED NOT NULL, profession_code VARCHAR(64) NOT NULL,
    stage TINYINT UNSIGNED NOT NULL, session_id CHAR(36) NOT NULL,
    credited_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (character_id,profession_code,stage,session_id),
    CONSTRAINT fk_map_hidden_victory_character FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS player_map_hidden_advanced_trial_actions (
    character_id BIGINT UNSIGNED NOT NULL, profession_code VARCHAR(64) NOT NULL,
    session_id CHAR(36) NOT NULL, skill_code VARCHAR(64) NOT NULL,
    successful TINYINT(1) NOT NULL DEFAULT 0,
    first_used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (character_id,profession_code,session_id,skill_code),
    CONSTRAINT fk_map_hidden_trial_action_character FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS player_map_hidden_advanced_trial_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    character_id BIGINT UNSIGNED NOT NULL, profession_code VARCHAR(64) NOT NULL,
    session_id CHAR(36) NOT NULL, turn_no INT UNSIGNED NOT NULL,
    event_code VARCHAR(64) NOT NULL, target_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id), UNIQUE KEY uk_map_hidden_trial_event
      (character_id,profession_code,session_id,turn_no,event_code,target_id),
    KEY idx_map_hidden_trial_event_review (character_id,profession_code,session_id,id),
    CONSTRAINT fk_map_hidden_trial_event_character FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  // 探囊按怪物实体而非战斗会话记账；逃跑后重进同一只怪也不能再次成功偷取。
  await pool.query(`CREATE TABLE IF NOT EXISTS monster_thief_reservations (
    spawn_id BIGINT UNSIGNED NOT NULL, character_id BIGINT UNSIGNED NOT NULL,
    origin_session_id CHAR(36) NOT NULL, status ENUM('reserved','redeemed','forfeited') NOT NULL DEFAULT 'reserved',
    redeemed_session_id CHAR(36) NULL, reserved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    settled_at DATETIME NULL,
    PRIMARY KEY (spawn_id), KEY idx_monster_thief_character (character_id,status),
    CONSTRAINT fk_monster_thief_spawn FOREIGN KEY (spawn_id) REFERENCES monster_spawns(id) ON DELETE CASCADE,
    CONSTRAINT fk_monster_thief_character FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);

  for (const mentor of mapHiddenMentorLocations) {
    const [regions] = await pool.execute<Region[]>('SELECT id,code,is_enabled,is_owner_only FROM map_regions WHERE code=? LIMIT 1', [mentor.regionCode]);
    const region = regions[0];
    if (!region) throw new Error(`隐藏导师地图不存在：${mentor.regionCode}`);
    const profession = mapHiddenAdvancedProfessions.find(entry => entry.code === mentor.professionCode && entry.mentor.code === mentor.mentorCode);
    const mission = mapHiddenAdvancedQuests[mentor.professionCode];
    if (!profession || !mission) throw new Error(`隐藏导师职业与任务资料不一致：${mentor.mentorCode}`);
    const [items] = await pool.execute<RowDataPacket[]>('SELECT 1 FROM item_definitions WHERE code=? LIMIT 1', [mission.material.code]);
    if (!items.length) throw new Error(`隐藏导师材料未初始化：${mission.material.code}`);
    for (const targetCode of [...mission.observation.codes, ...mission.proof.codes, profession.trial.code]) {
      const [targets] = await pool.execute<RowDataPacket[]>('SELECT 1 FROM monster_templates WHERE code=? LIMIT 1', [targetCode]);
      if (!targets.length) throw new Error(`隐藏导师魔物未初始化：${targetCode}`);
    }
    const [bounds] = await pool.execute<RowDataPacket[]>(`SELECT 1 FROM map_region_areas
      WHERE region_id=? AND ? BETWEEN min_x AND max_x AND ? BETWEEN min_y AND max_y AND ? BETWEEN min_z AND max_z LIMIT 1`,
    [region.id, mentor.x, mentor.y, mentor.z]);
    if (!bounds.length) throw new Error(`隐藏导师位置不在地图有效区域：${mentor.mentorCode}`);
    const [occupied] = await pool.execute<RowDataPacket[]>(`SELECT 1 FROM map_npcs WHERE region_id=? AND pos_x=? AND pos_y=? AND pos_z=?
      UNION ALL SELECT 1 FROM map_special_objects WHERE region_id=? AND pos_x=? AND pos_y=? AND pos_z=? LIMIT 1`,
    [region.id, mentor.x, mentor.y, mentor.z, region.id, mentor.x, mentor.y, mentor.z]);
    if (occupied.length) throw new Error(`隐藏导师与公开地图对象位置冲突：${mentor.mentorCode}`);
    await pool.execute(`INSERT INTO map_hidden_advanced_mentors
      (mentor_code,profession_code,region_id,pos_x,pos_y,pos_z,minimum_range,enabled)
      VALUES (?,?,?,?,?,?,?,1)
      ON DUPLICATE KEY UPDATE profession_code=VALUES(profession_code),region_id=VALUES(region_id),
        pos_x=VALUES(pos_x),pos_y=VALUES(pos_y),pos_z=VALUES(pos_z),minimum_range=VALUES(minimum_range),enabled=1`,
    [mentor.mentorCode, mentor.professionCode, region.id, mentor.x, mentor.y, mentor.z, mentor.minimumRange]);
  }
};
