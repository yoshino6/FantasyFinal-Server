import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { getPool, withTransaction } from '../database/pool';
import { activeSkillCodesForAdvancedProfession, mapHiddenAdvancedProfessions } from './advanced-profession.config';
import { mapHiddenAdvancedQuests } from './map-hidden-advanced-quest.config';
import { mapHiddenMentorLocations } from './map-hidden-mentor.locations';
import { playerGrowthShares } from './growth-rules';
import { heartGrowthAdjustment } from './heart-question.service';
import { equippedEnchantmentEffects } from './equipment-enchantment-effects';
import { assertCombatLoadoutMutable } from './combat-loadout-lock.service';
import { grantMapHiddenAdvancedProfession } from './advanced-profession.service';
import { durationText } from './time-format';
import { consumeInventory } from './inventory-binding';
import { recordCharacterOperation } from './character-operation.service';
import { randomUUID } from 'node:crypto';
import { trialEventEvidenceSatisfied, type MapHiddenTrialEvent } from './map-hidden-trial-evidence';

type Character = RowDataPacket & {
  id: number; level: number; profession_code: string | null; adventurer_registered: number;
  current_region_id: number; region_code: string; pos_x: number; pos_y: number; pos_z: number;
  perception: number; perception_growth: number; activity_status: string;
};
type Mentor = RowDataPacket & {
  mentor_code: string; profession_code: string; region_id: number; pos_x: number; pos_y: number;
  pos_z: number; minimum_range: number; enabled: number;
};
type Quest = RowDataPacket & {
  character_id: number; profession_code: string; stage: number; revision: number;
  observed_kills: number; proof_kills: number; trial_spawn_id: number | null; practice_spawn_id: number | null;
  practice_spawn_id_2: number | null; completed_at: Date | null;
};
type CurrentProfession = RowDataPacket & { profession_code: string; completed_at: Date };

const baseName: Record<string, string> = { warrior: '战士', mage: '法师', rogue: '盗贼', priest: '牧师', archer: '射手' };
const professionFor = (code: string) => mapHiddenAdvancedProfessions.find(entry => entry.code === code);
const mentorByCode = (code: string) => mapHiddenAdvancedProfessions.find(entry => entry.mentor.code === code);
const unavailable = () => new Error('这里没有可交谈的隐藏导师。');
const cooldownMs = 24 * 60 * 60_000;
const trialRequiredSkills: Record<string, { every: string[]; attackAny: string[]; combo?: boolean }> = {
  sword_shadow: { every: ['sword_shadow_polish', 'sword_shadow_sheathe'], attackAny: ['sword_shadow_chase', 'sword_shadow_storm'], combo: true },
  titan: { every: ['titan_anchor', 'titan_defer'], attackAny: ['titan_quake', 'titan_unbroken'] },
  spirit_summoner: { every: ['summoner_call'], attackAny: ['summoner_command', 'summoner_triad'] },
  master_thief: { every: ['thief_appraise'], attackAny: ['thief_exploit', 'thief_loaded'] },
  holy_knight: { every: ['paladin_rally', 'paladin_switch_vow'], attackAny: ['paladin_charge', 'paladin_sanctuary'] },
  stringblade: { every: ['stringblade_draw'], attackAny: ['stringblade_shot', 'stringblade_cross'] }
};
const trialEventCodes: Record<string, readonly string[]> = {
  sword_shadow: ['sword_attack_hit', 'sword_attack_miss_preserved', 'sword_polished_hit', 'sword_combo_hit', 'sword_switched_target'],
  titan: ['titan_deferred_hit', 'titan_wound_tick', 'titan_guard_redirect'],
  spirit_summoner: ['summoner_attack_role', 'summoner_guard_role', 'summoner_heal_role', 'summoner_three_roles_round', 'summoner_resummon'],
  master_thief: ['thief_training_pick', 'thief_forbidden_identified', 'thief_loaded_benefit'],
  holy_knight: ['paladin_courage_active', 'paladin_guard_active', 'paladin_guard_redirect'],
  stringblade: ['stringblade_ranged_hit', 'stringblade_melee_hit', 'stringblade_alternate', 'stringblade_switched_target']
};
const practiceCount: Record<string, number> = { sword_shadow: 1, titan: 2, master_thief: 1, stringblade: 1 };

const characterFor = async (db: Pool | PoolConnection, user: string, lock = false) => {
  const [rows] = await db.execute<Character[]>(`SELECT c.id,c.level,c.profession_code,c.adventurer_registered,c.current_region_id,
      r.code AS region_code,c.pos_x,c.pos_y,c.pos_z,c.perception,c.perception_growth,c.activity_status
    FROM characters c JOIN players p ON p.id=c.player_id JOIN map_regions r ON r.id=c.current_region_id
    WHERE p.qq_user_id=? AND c.npc_id IS NULL LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [user]);
  if (!rows[0]) throw new Error('请先创建角色。');
  return rows[0];
};

const assertQualifiedBase = (character: Character, profession: NonNullable<ReturnType<typeof professionFor>>) => {
  if (Number(character.level) < 25 || !Number(character.adventurer_registered)) throw new Error('完成冒险者登记并达到 Lv.25 后，才能接受这条传承。');
  if (baseName[String(character.profession_code ?? '')] !== profession.baseProfession) throw new Error('这条传承与你的主职业不符。');
};

const assertAvailable = async (connection: PoolConnection, character: Character) => {
  if (character.activity_status !== 'active') throw new Error('请先恢复行动状态。');
  await assertCombatLoadoutMutable(connection, Number(character.id));
  const [travels] = await connection.execute<RowDataPacket[]>('SELECT 1 FROM player_travels WHERE character_id=? LIMIT 1 FOR UPDATE', [character.id]);
  if (travels.length) throw new Error('请先完成当前行程。');
};

const perceptionRange = async (db: Pool | PoolConnection, character: Character) => {
  const heart = await heartGrowthAdjustment(db, Number(character.id));
  const final = Number(character.perception) + (Number(character.perception_growth) + Number(heart?.delta.perception ?? 0)) * playerGrowthShares(Number(character.level));
  const base = Math.max(1, Math.min(10, 2 + Math.floor(Math.max(1, Number(character.level)) / 5), 1 + Math.floor(Math.pow(Math.max(1, final) / 7, .9))));
  const enchantment = await equippedEnchantmentEffects(db, Number(character.id));
  return base + Math.max(0, Math.min(3, Number(enchantment.mapPerceptionBonus ?? 0)));
};

const loadMentor = async (db: Pool | PoolConnection, code: string) => {
  const profession = professionFor(code) ?? mentorByCode(code);
  if (!profession) throw unavailable();
  const [rows] = await db.execute<Mentor[]>(`SELECT m.* FROM map_hidden_advanced_mentors m JOIN map_regions r ON r.id=m.region_id
    WHERE m.profession_code=? AND m.mentor_code=? AND m.enabled=1 AND r.is_enabled=1 AND r.is_owner_only=0 LIMIT 1`, [profession.code, profession.mentor.code]);
  if (!rows[0]) throw unavailable();
  return { profession, mentor: rows[0] };
};

const assertAtDiscoveredMentor = async (db: Pool | PoolConnection, character: Character, code: string) => {
  const { profession, mentor } = await loadMentor(db, code);
  const [discovered] = await db.execute<RowDataPacket[]>('SELECT 1 FROM player_map_hidden_advanced_discoveries WHERE character_id=? AND mentor_code=? LIMIT 1', [character.id, mentor.mentor_code]);
  if (!discovered.length || Number(character.current_region_id) !== Number(mentor.region_id)
    || Number(character.pos_x) !== Number(mentor.pos_x) || Number(character.pos_y) !== Number(mentor.pos_y)
    || Number(character.pos_z) !== Number(mentor.pos_z)) throw unavailable();
  assertQualifiedBase(character, profession);
  return { profession, mentor };
};

const questFor = async (db: Pool | PoolConnection, characterId: number, code: string, lock = false) => {
  const [rows] = await db.execute<Quest[]>(`SELECT * FROM player_map_hidden_advanced_quests WHERE character_id=? AND profession_code=?${lock ? ' FOR UPDATE' : ''}`, [characterId, code]);
  return rows[0] ?? null;
};

const currentProfessionFor = async (db: Pool | PoolConnection, characterId: number, lock = false) => {
  const [rows] = await db.execute<CurrentProfession[]>(`SELECT profession_code,completed_at FROM player_advanced_professions WHERE character_id=?${lock ? ' FOR UPDATE' : ''}`, [characterId]);
  return rows[0] ?? null;
};

const cooldownSeconds = (current: CurrentProfession | null) => current
  ? Math.max(0, Math.ceil((new Date(current.completed_at).getTime() + cooldownMs - Date.now()) / 1000)) : 0;

const assertRetrainReady = (current: CurrentProfession | null, code: string) => {
  if (current?.profession_code === code) throw new Error('你当前已经是这条职业路线。');
  const remaining = cooldownSeconds(current);
  if (remaining) throw new Error(`重新二转仍在冷却中，请在 ${durationText(remaining)} 后再来。`);
};

/** 角色单独感知；一次只发现范围内最近的一位符合职业门槛的导师。 */
export const senseMapHiddenAdvancedMentor = async (user: string) => withTransaction(async connection => {
  const character = await characterFor(connection, user, true);
  await assertAvailable(connection, character);
  if (Number(character.level) < 25 || !Number(character.adventurer_registered) || !baseName[String(character.profession_code ?? '')])
    return { kind: 'none' as const, text: '你静下心神，附近的风声暂时没有给出新的回应。' };
  const range = await perceptionRange(connection, character);
  const [mentors] = await connection.execute<(Mentor & { discovered_at: Date | null })[]>(`SELECT m.*,d.discovered_at
    FROM map_hidden_advanced_mentors m LEFT JOIN player_map_hidden_advanced_discoveries d
      ON d.character_id=? AND d.mentor_code=m.mentor_code
    JOIN map_regions r ON r.id=m.region_id AND r.is_enabled=1 AND r.is_owner_only=0
    WHERE m.region_id=? AND m.pos_z=? AND m.enabled=1`, [character.id, character.current_region_id, character.pos_z]);
  const within = mentors.map(mentor => ({ mentor, distance: Math.abs(Number(mentor.pos_x) - Number(character.pos_x)) + Math.abs(Number(mentor.pos_y) - Number(character.pos_y)) }))
    .filter(entry => entry.distance <= range && professionFor(entry.mentor.profession_code)?.baseProfession === baseName[String(character.profession_code)])
    .sort((a, b) => a.distance - b.distance || a.mentor.mentor_code.localeCompare(b.mentor.mentor_code));
  const undiscovered = within.find(entry => !entry.mentor.discovered_at);
  if (!undiscovered) {
    if (within.length) return { kind: 'already' as const, text: '你认出了曾经感知到的气息。到它真正停驻之处，才能当面交谈。' };
    return { kind: 'none' as const, text: '你静下心神，附近的风声暂时没有给出新的回应。' };
  }
  const location = mapHiddenMentorLocations.find(entry => entry.mentorCode === undiscovered.mentor.mentor_code);
  if (range < Number(undiscovered.mentor.minimum_range)) return { kind: 'hint' as const, text: location?.hint ?? '空气里似乎藏着一段尚未听清的回声。' };
  const profession = professionFor(undiscovered.mentor.profession_code)!;
  await connection.execute('INSERT IGNORE INTO player_map_hidden_advanced_discoveries (character_id,mentor_code) VALUES (?,?)', [character.id, undiscovered.mentor.mentor_code]);
  await recordCharacterOperation(connection, { characterId: Number(character.id), kind: 'profession.map_hidden_mentor_discovered',
    source: { system: 'map_hidden_advanced_mentor', id: randomUUID(), step: 'discovered' }, outcome: '发现',
    summary: `感知到${profession.name}隐藏导师`, detail: { professionCode: profession.code, mentorCode: profession.mentor.code } });
  return { kind: 'discovered' as const, text: `${location?.hint ?? '你听见了遥远的回声。'}\n\n你感知到了【${profession.mentor.title}·${profession.mentor.name}】的气息。继续探索，走到对方真正停驻之处才能交谈。`, professionCode: profession.code };
});

/** 只返回当前位置已经由本人发现的导师，不暴露未发现者的名称或坐标。 */
export const mapHiddenMentorAtCurrentCell = async (user: string) => {
  const pool = await getPool();
  const character = await characterFor(pool, user);
  const [rows] = await pool.execute<Mentor[]>(`SELECT m.* FROM map_hidden_advanced_mentors m
    JOIN player_map_hidden_advanced_discoveries d ON d.mentor_code=m.mentor_code AND d.character_id=?
    JOIN map_regions r ON r.id=m.region_id AND r.is_enabled=1 AND r.is_owner_only=0
    WHERE m.enabled=1 AND m.region_id=? AND m.pos_x=? AND m.pos_y=? AND m.pos_z=? LIMIT 1`,
  [character.id, character.current_region_id, character.pos_x, character.pos_y, character.pos_z]);
  const profession = rows[0] ? professionFor(rows[0].profession_code) : undefined;
  if (!profession || character.activity_status !== 'active' || Number(character.level) < 25 || !Number(character.adventurer_registered)
    || baseName[String(character.profession_code ?? '')] !== profession.baseProfession) return null;
  return { professionCode: profession.code, name: `${profession.mentor.title}·${profession.mentor.name}` };
};

export const mapHiddenAdvancedMentorView = async (user: string, code: string) => withTransaction(async connection => {
  const character = await characterFor(connection, user, true);
  const { profession } = await assertAtDiscoveredMentor(connection, character, code);
  await assertAvailable(connection, character);
  const quest = await questFor(connection, Number(character.id), profession.code);
  const current = await currentProfessionFor(connection, Number(character.id));
  const [qualification] = await connection.execute<RowDataPacket[]>('SELECT qualified_at FROM player_map_hidden_advanced_qualifications WHERE character_id=? AND profession_code=? LIMIT 1', [character.id, profession.code]);
  const [publicQuests] = await connection.execute<(RowDataPacket & { profession_code: string; stage: number })[]>(`SELECT profession_code,stage FROM player_advanced_profession_quests
    WHERE character_id=? AND stage IN (1,2,3) LIMIT 1`, [character.id]);
  const mission = mapHiddenAdvancedQuests[profession.code];
  const [inventory] = await connection.execute<(RowDataPacket & { quantity: number })[]>(`SELECT COALESCE(SUM(pi.quantity),0) AS quantity FROM player_inventory pi
    JOIN item_definitions i ON i.id=pi.item_id WHERE pi.character_id=? AND i.code=?`, [character.id, mission.material.code]);
  return { profession, quest, mission, qualified: Boolean(qualification[0]), currentCode: current?.profession_code ?? null,
    publicQuest: publicQuests[0] ? { code: String(publicQuests[0].profession_code), stage: Number(publicQuests[0].stage) } : null,
    retrainRemainingSeconds: cooldownSeconds(current), materialQuantity: Number(inventory[0]?.quantity ?? 0) };
});

/** 任务栏只展示本人已当面接取的当前阶段，不提供导师坐标或远程交付按钮。 */
export const mapHiddenTrackedQuests = async (user: string) => {
  const pool = await getPool();
  const [rows] = await pool.execute<(Quest & { current_region_id: number; pos_x: number; pos_y: number; pos_z: number })[]>(`SELECT q.*,c.current_region_id,c.pos_x,c.pos_y,c.pos_z
    FROM player_map_hidden_advanced_quests q JOIN characters c ON c.id=q.character_id
    JOIN players p ON p.id=c.player_id WHERE p.qq_user_id=? AND c.npc_id IS NULL
      AND q.stage BETWEEN 2 AND 6 ORDER BY q.accepted_at`, [user]);
  const entries: { title: string; description: string; action?: { label: string; command: string } }[] = [];
  for (const row of rows) {
    const profession = professionFor(String(row.profession_code));
    const mission = mapHiddenAdvancedQuests[String(row.profession_code)];
    if (!profession || !mission) continue;
    const stage = Number(row.stage);
    const description = stage === 2 ? '当面听取导师的传承说明。'
      : stage === 3 ? `在导师所在区域击败${mission.observation.name}：${Number(row.observed_kills)}/${mission.observation.count}。胜利结算后回导师处交付观察。`
      : stage === 4 ? `随身备齐${mission.material.name}×${mission.material.count}，回导师处交付。`
      : stage === 5 ? `在导师所在区域击败专项目标${mission.proof.name}：${Number(row.proof_kills)}/${mission.proof.count}。`
      : `回到导师所在之处开启本人试炼。${mission.trialInstruction}`;
    const [atMentor] = await pool.execute<RowDataPacket[]>(`SELECT 1 FROM map_hidden_advanced_mentors m
      JOIN player_map_hidden_advanced_discoveries d ON d.mentor_code=m.mentor_code AND d.character_id=?
      JOIN map_regions r ON r.id=m.region_id AND r.is_enabled=1 AND r.is_owner_only=0
      WHERE m.profession_code=? AND m.enabled=1 AND m.region_id=? AND m.pos_x=? AND m.pos_y=? AND m.pos_z=? LIMIT 1`,
    [row.character_id, profession.code, row.current_region_id, row.pos_x, row.pos_y, row.pos_z]);
    entries.push({ title: `【隐藏二转·${profession.name} ${stage - 1}/5】`, description,
      action: atMentor.length ? { label: '[与导师继续]', command: `/隐藏导师 ${profession.code}` } : undefined });
  }
  return entries;
};

const updateStage = async (connection: PoolConnection, quest: Quest, nextStage: number) => {
  const [changed] = await connection.execute<ResultSetHeader>(`UPDATE player_map_hidden_advanced_quests
    SET stage=?,revision=revision+1 WHERE character_id=? AND profession_code=? AND stage=? AND revision=?`,
  [nextStage, quest.character_id, quest.profession_code, quest.stage, quest.revision]);
  if (changed.affectedRows !== 1) throw new Error('导师记录已经更新，请重新打开。');
};

const retireTrialSpawns = async (connection: PoolConnection, quest: Quest) => {
  for (const spawnId of [quest.trial_spawn_id, quest.practice_spawn_id, quest.practice_spawn_id_2]) {
    if (spawnId) await connection.execute('UPDATE monster_spawns SET defeated_at=NOW() WHERE id=? AND defeated_at IS NULL', [spawnId]);
  }
};

/** 所有任务按钮都重新校验位置、发现、角色、冷却与版本。 */
export const mapHiddenAdvancedMentorAction = async (user: string, code: string, revision: number, action: string) => withTransaction(async connection => {
  const character = await characterFor(connection, user, true);
  const { profession } = await assertAtDiscoveredMentor(connection, character, code);
  await assertAvailable(connection, character);
  const mission = mapHiddenAdvancedQuests[profession.code];
  const current = await currentProfessionFor(connection, Number(character.id), true);
  const quest = await questFor(connection, Number(character.id), profession.code, true);
  const [qualified] = await connection.execute<RowDataPacket[]>('SELECT 1 FROM player_map_hidden_advanced_qualifications WHERE character_id=? AND profession_code=? LIMIT 1 FOR UPDATE', [character.id, profession.code]);
  if (!Number.isSafeInteger(revision) || revision !== Number(quest?.revision ?? 0)) throw new Error('导师记录已经更新，请重新打开。');

  if (action === 'become') {
    if (!qualified.length) throw new Error('请先完成导师试炼。');
    assertRetrainReady(current, profession.code);
    const granted = await grantMapHiddenAdvancedProfession(connection, Number(character.id), profession.code);
    return { kind: 'became' as const, profession: granted.profession.name };
  }
  if (qualified.length || Number(quest?.stage) === 7) throw new Error('这条传承已经完成，资格会永久保留。');

  if (action === 'accept' || action === 'accept_legacy') {
    if (quest && Number(quest.stage) >= 2 && Number(quest.stage) <= 6) throw new Error('你已接下这条传承。');
    assertRetrainReady(current, profession.code);
    const [publicQuests] = await connection.execute<(RowDataPacket & { profession_code: string; stage: number })[]>(`SELECT profession_code,stage FROM player_advanced_profession_quests
      WHERE character_id=? AND stage IN (1,2,3) FOR UPDATE`, [character.id]);
    if (publicQuests.length) {
      const legacyOnly = profession.code === 'spirit_summoner' && publicQuests.length === 1 && publicQuests[0].profession_code === 'spirit_summoner';
      if (!legacyOnly || action !== 'accept_legacy') throw new Error(legacyOnly ? '旧世界树唤灵师试炼仍在进行，请使用“中断旧试炼并接取”入口。' : '你正在进行世界树二转试炼，请先结束原任务。');
      const [archived] = await connection.execute<ResultSetHeader>(`UPDATE player_advanced_profession_quests SET stage=5,completed_at=NOW()
        WHERE character_id=? AND profession_code='spirit_summoner' AND stage IN (1,2,3)`, [character.id]);
      if (archived.affectedRows !== 1) throw new Error('旧试炼记录已经变化，请重新打开。');
      await recordCharacterOperation(connection, { characterId: Number(character.id), kind: 'profession.legacy_summoner_quest_abandoned',
        source: { system: 'map_hidden_advanced_quest', id: randomUUID(), step: 'legacy_abandoned' }, outcome: '中断',
        summary: '中断旧世界树唤灵师试炼，改从地图隐藏导师重新开始', detail: { previousStage: Number(publicQuests[0].stage) } });
    } else if (action === 'accept_legacy') throw new Error('没有需要中断的旧世界树唤灵师试炼。');
    const [other] = await connection.execute<RowDataPacket[]>(`SELECT profession_code FROM player_map_hidden_advanced_quests
      WHERE character_id=? AND profession_code<>? AND stage BETWEEN 2 AND 6 LIMIT 1 FOR UPDATE`, [character.id, profession.code]);
    if (other.length) throw new Error('你正在进行另一条隐藏传承，请先回原导师处中断。');
    await connection.execute(`INSERT INTO player_map_hidden_advanced_quests
      (character_id,profession_code,stage,revision,observed_kills,proof_kills,trial_spawn_id,practice_spawn_id,practice_spawn_id_2)
      VALUES (?,?,2,1,0,0,NULL,NULL,NULL)
      ON DUPLICATE KEY UPDATE stage=2,revision=revision+1,observed_kills=0,proof_kills=0,trial_spawn_id=NULL,practice_spawn_id=NULL,practice_spawn_id_2=NULL,completed_at=NULL,accepted_at=NOW()`,
    [character.id, profession.code]);
    await recordCharacterOperation(connection, { characterId: Number(character.id), kind: 'profession.map_hidden_quest_accepted',
      source: { system: 'map_hidden_advanced_quest', id: randomUUID(), step: 'accepted' }, outcome: '接取',
      summary: `接取${profession.name}隐藏传承`, detail: { professionCode: profession.code } });
    return { kind: 'accepted' as const };
  }
  if (!quest || Number(quest.stage) < 2 || Number(quest.stage) > 6) throw new Error('请先当面接受传承。');

  if (action === 'abandon') {
    await retireTrialSpawns(connection, quest);
    await connection.execute('DELETE FROM player_map_hidden_advanced_quests WHERE character_id=? AND profession_code=? AND revision=?', [character.id, profession.code, quest.revision]);
    await recordCharacterOperation(connection, { characterId: Number(character.id), kind: 'profession.map_hidden_quest_abandoned',
      source: { system: 'map_hidden_advanced_quest', id: randomUUID(), step: 'abandoned' }, outcome: '中断',
      summary: `中断${profession.name}隐藏传承`, detail: { professionCode: profession.code, stage: Number(quest.stage) } });
    return { kind: 'abandoned' as const };
  }
  if (action === 'listen' && Number(quest.stage) === 2) {
    await updateStage(connection, quest, 3);
    return { kind: 'progressed' as const };
  }
  if (action === 'submit_observation' && Number(quest.stage) === 3) {
    if (Number(quest.observed_kills) < mission.observation.count) throw new Error('实战观察还没有完成。');
    await updateStage(connection, quest, 4);
    return { kind: 'progressed' as const };
  }
  if (action === 'submit_material' && Number(quest.stage) === 4) {
    const [items] = await connection.execute<(RowDataPacket & { item_id: number; quantity: number })[]>(`SELECT pi.item_id,pi.quantity FROM player_inventory pi
      JOIN item_definitions i ON i.id=pi.item_id WHERE pi.character_id=? AND i.code=? LIMIT 1 FOR UPDATE`, [character.id, mission.material.code]);
    if (Number(items[0]?.quantity ?? 0) < mission.material.count) throw new Error(`还需随身携带【${mission.material.name}】×${mission.material.count}。`);
    await consumeInventory(connection, Number(character.id), Number(items[0].item_id), mission.material.count);
    await updateStage(connection, quest, 5);
    return { kind: 'progressed' as const };
  }
  if (action === 'submit_proof' && Number(quest.stage) === 5) {
    if (Number(quest.proof_kills) < mission.proof.count) throw new Error('职业专项目标尚未完成。');
    await updateStage(connection, quest, 6);
    return { kind: 'progressed' as const };
  }
  if (action !== 'start_trial' || Number(quest.stage) !== 6) throw new Error('当前阶段不能执行这项操作。');
  assertRetrainReady(current, profession.code);
  const [ambient] = await connection.execute<RowDataPacket[]>(`SELECT 1 FROM monster_spawns s
    WHERE s.region_id=? AND s.pos_x=? AND s.pos_y=? AND s.pos_z=? AND s.defeated_at IS NULL
      AND NOT JSON_CONTAINS(COALESCE(s.traits_json,JSON_ARRAY()),JSON_OBJECT('code','advanced_profession_trial'))
    LIMIT 1 FOR UPDATE`, [character.current_region_id, character.pos_x, character.pos_y, character.pos_z]);
  if (ambient.length) throw new Error('导师试炼场地还有其他魔物，请先清理此格。');
  const [existing] = quest.trial_spawn_id
    ? await connection.execute<(RowDataPacket & { id: number })[]>('SELECT id FROM monster_spawns WHERE id=? AND defeated_at IS NULL LIMIT 1 FOR UPDATE', [quest.trial_spawn_id])
    : [[] as (RowDataPacket & { id: number })[]];
  const existingPracticeIds = [quest.practice_spawn_id, quest.practice_spawn_id_2].slice(0, practiceCount[profession.code] ?? 0);
  const practiceAlive: boolean[] = [];
  for (const spawnId of existingPracticeIds) {
    if (!spawnId) { practiceAlive.push(false); continue; }
    const [rows] = await connection.execute<RowDataPacket[]>('SELECT 1 FROM monster_spawns WHERE id=? AND defeated_at IS NULL LIMIT 1 FOR UPDATE', [spawnId]);
    practiceAlive.push(Boolean(rows[0]));
  }
  const requiredSkills = activeSkillCodesForAdvancedProfession(profession.code);
  const [skillRows] = requiredSkills.length ? await connection.execute<(RowDataPacket & { id: number; code: string; name: string })[]>(`SELECT id,code,name FROM skill_definitions WHERE code IN (${requiredSkills.map(() => '?').join(',')})`, requiredSkills) : [[] as (RowDataPacket & { id: number; code: string; name: string })[]];
  const borrowedSkills = requiredSkills.map(skillCode => skillRows.find(row => row.code === skillCode)).filter((entry): entry is RowDataPacket & { id: number; code: string; name: string } => Boolean(entry)).map(entry => ({ id: Number(entry.id), name: String(entry.name) }));
  if (borrowedSkills.length !== 4) throw new Error('导师试炼技能尚未准备好，请稍后重试。');
  // 妙手成功探囊后若逃跑/落败，同一只陪练已用掉唯一可偷名额；重开试炼必须换一只 monster life。
  const reservedPracticeIds = profession.code === 'master_thief' ? existingPracticeIds.filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0) : [];
  const [spentPractice] = reservedPracticeIds.length
    ? await connection.execute<RowDataPacket[]>(`SELECT 1 FROM monster_thief_reservations WHERE spawn_id IN (${reservedPracticeIds.map(() => '?').join(',')}) LIMIT 1 FOR UPDATE`, reservedPracticeIds)
    : [[] as RowDataPacket[]];
  if (existing[0] && practiceAlive.every(Boolean) && !spentPractice.length)
    return { kind: 'trial' as const, spawnId: Number(existing[0].id), borrowedSkills };
  await retireTrialSpawns(connection, quest);

  const [templates] = await connection.execute<(RowDataPacket & Record<string, unknown> & { id: number; level: number; skill_sequence: unknown })[]>('SELECT * FROM monster_templates WHERE code=? LIMIT 1', [profession.trial.code]);
  const template = templates[0];
  if (!template) throw new Error('导师试炼尚未完成初始化，请稍后重试。');
  const { monsterCombatStats } = await import('./adventure.service');
  const traits = [
    { code: 'advanced_profession_trial', name: '二转导师试炼', owner_character_id: Number(character.id), profession_code: profession.code,
      hpPct: profession.code === 'spirit_summoner' ? 500 : 200 },
    { code: 'map_hidden_advanced_trial', name: '地图隐藏二转导师试炼', owner_character_id: Number(character.id), profession_code: profession.code, mentor_code: profession.mentor.code }
  ];
  const stats = monsterCombatStats({ ...template, monster_class: 'boss', traits_json: traits } as unknown as Parameters<typeof monsterCombatStats>[0]);
  const [created] = await connection.execute<ResultSetHeader>(`INSERT INTO monster_spawns
    (template_id,region_id,pos_x,pos_y,pos_z,level,constitution,spirit,strength,intelligence,agility,perception,current_hp,skill_sequence,traits_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [template.id, character.current_region_id, character.pos_x, character.pos_y, character.pos_z, 30,
    profession.trial.stats[0], profession.trial.stats[1], profession.trial.stats[2], profession.trial.stats[3], profession.trial.stats[4], profession.trial.stats[5],
    Math.max(1, Math.floor(Number(stats.hpMax))), typeof template.skill_sequence === 'string' ? template.skill_sequence : JSON.stringify(template.skill_sequence ?? []), JSON.stringify(traits)]);
  const practiceSpawnIds: number[] = [];
  if ((practiceCount[profession.code] ?? 0) > 0) {
    const [practiceTemplates] = await connection.execute<(RowDataPacket & Record<string, unknown> & { id: number; skill_sequence: unknown })[]>(
      'SELECT * FROM monster_templates WHERE code=? LIMIT 1', [mission.observation.codes[0]]);
    const practiceTemplate = practiceTemplates[0];
    if (!practiceTemplate) throw new Error('导师陪练目标尚未准备好，请稍后重试。');
    const practiceTraits = [
      { code: 'advanced_profession_trial', name: '导师陪练', owner_character_id: Number(character.id), profession_code: profession.code, hpPct: 200 },
      { code: 'map_hidden_advanced_trial', name: '地图隐藏二转陪练', owner_character_id: Number(character.id), profession_code: profession.code, mentor_code: profession.mentor.code },
      { code: 'map_hidden_advanced_sparring', name: '导师陪练目标', owner_character_id: Number(character.id), profession_code: profession.code }
    ];
    const practiceStats = monsterCombatStats({ ...practiceTemplate, level: 30, constitution: profession.trial.stats[0], spirit: profession.trial.stats[1],
      strength: profession.trial.stats[2], intelligence: profession.trial.stats[3], agility: profession.trial.stats[4],
      perception: profession.trial.stats[5], traits_json: practiceTraits } as unknown as Parameters<typeof monsterCombatStats>[0]);
    for (let index = 0; index < practiceCount[profession.code]; index += 1) {
      const [practice] = await connection.execute<ResultSetHeader>(`INSERT INTO monster_spawns
        (template_id,region_id,pos_x,pos_y,pos_z,level,constitution,spirit,strength,intelligence,agility,perception,current_hp,skill_sequence,traits_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [practiceTemplate.id, character.current_region_id, character.pos_x, character.pos_y, character.pos_z, 30,
        ...profession.trial.stats, Math.max(1, Math.floor(Number(practiceStats.hpMax))),
        typeof practiceTemplate.skill_sequence === 'string' ? practiceTemplate.skill_sequence : JSON.stringify(practiceTemplate.skill_sequence ?? []), JSON.stringify(practiceTraits)]);
      practiceSpawnIds.push(Number(practice.insertId));
    }
  }
  const [bound] = await connection.execute<ResultSetHeader>(`UPDATE player_map_hidden_advanced_quests
    SET trial_spawn_id=?,practice_spawn_id=?,practice_spawn_id_2=?,revision=revision+1
    WHERE character_id=? AND profession_code=? AND stage=6 AND revision=?`,
  [created.insertId, practiceSpawnIds[0] ?? null, practiceSpawnIds[1] ?? null, character.id, profession.code, quest.revision]);
  if (bound.affectedRows !== 1) throw new Error('导师试炼记录已经变化，请重新打开。');
  return { kind: 'trial' as const, spawnId: Number(created.insertId), borrowedSkills };
});

/** 仅在真实胜利结算里调用；用 session 唯一账本阻止重放或同场重复计数。 */
export const recordMapHiddenAdvancedVictory = async (connection: PoolConnection, characterId: number, targetCodes: string[], sessionId: string) => {
  if (!targetCodes.length) return;
  const [quests] = await connection.execute<Quest[]>(`SELECT q.* FROM player_map_hidden_advanced_quests q
    WHERE q.character_id=? AND q.stage IN (3,5) LIMIT 1 FOR UPDATE`, [characterId]);
  const quest = quests[0];
  if (!quest) return;
  const mission = mapHiddenAdvancedQuests[quest.profession_code];
  const objective = Number(quest.stage) === 3 ? mission?.observation : mission?.proof;
  if (!objective) return;
  const [fought] = await connection.execute<(RowDataPacket & { code: string })[]>(`SELECT t.code FROM combat_targets ct
    JOIN combat_sessions cs ON cs.id=ct.session_id AND cs.state='victory'
    JOIN combat_members cm ON cm.session_id=cs.id AND cm.character_id=? AND cm.is_defeated=0
    JOIN monster_spawns s ON s.id=ct.spawn_id
    JOIN monster_reward_settlements rs ON rs.spawn_id=s.id AND rs.session_id=cs.id AND rs.channel='combat'
    JOIN monster_templates t ON t.id=s.template_id
    JOIN map_hidden_advanced_mentors mentor ON mentor.profession_code=? AND mentor.region_id=s.region_id
    WHERE ct.session_id=? AND ct.is_defeated=1 AND t.code IN (${objective.codes.map(() => '?').join(',')})`,
  [characterId, quest.profession_code, sessionId, ...objective.codes]);
  const supplied = new Set(targetCodes);
  const gained = fought.filter(row => supplied.has(String(row.code))).length;
  if (!gained) return;
  const [recorded] = await connection.execute<ResultSetHeader>(`INSERT IGNORE INTO player_map_hidden_advanced_victories
    (character_id,profession_code,stage,session_id) VALUES (?,?,?,?)`, [characterId, quest.profession_code, quest.stage, sessionId]);
  if (recorded.affectedRows !== 1) return;
  const column = Number(quest.stage) === 3 ? 'observed_kills' : 'proof_kills';
  await connection.execute(`UPDATE player_map_hidden_advanced_quests SET ${column}=LEAST(?,${column}+?),revision=revision+1
    WHERE character_id=? AND profession_code=? AND stage=?`, [objective.count, gained, characterId, quest.profession_code, quest.stage]);
};

/** 由真实 PVE 行动结算调用；按钮/客户端永远不能直接写试炼证据。 */
export const recordMapHiddenTrialSkillUse = async (connection: PoolConnection, sessionId: string, ownerCharacterId: number, skillCode: string, hit: boolean) => {
  const [quests] = await connection.execute<Quest[]>(`SELECT q.* FROM player_map_hidden_advanced_quests q
    JOIN combat_targets ct ON ct.spawn_id=q.trial_spawn_id AND ct.session_id=?
    JOIN combat_sessions cs ON cs.id=ct.session_id AND cs.state='active'
    JOIN combat_members cm ON cm.session_id=cs.id AND cm.character_id=q.character_id
    WHERE q.character_id=? AND q.stage=6 LIMIT 1`, [sessionId, ownerCharacterId]);
  const quest = quests[0];
  if (!quest || !activeSkillCodesForAdvancedProfession(quest.profession_code).includes(skillCode)) return;
  await connection.execute(`INSERT INTO player_map_hidden_advanced_trial_actions
    (character_id,profession_code,session_id,skill_code,successful) VALUES (?,?,?,?,?)
    ON DUPLICATE KEY UPDATE successful=GREATEST(successful,VALUES(successful))`,
  [ownerCharacterId, quest.profession_code, sessionId, skillCode, hit ? 1 : 0]);
};

/** 只在剑影持鞘的实际追加攻击结算后调用。 */
export const recordMapHiddenTrialCombo = async (connection: PoolConnection, sessionId: string, ownerCharacterId: number) => {
  const [quests] = await connection.execute<Quest[]>(`SELECT q.* FROM player_map_hidden_advanced_quests q
    JOIN combat_targets ct ON ct.spawn_id=q.trial_spawn_id AND ct.session_id=?
    JOIN combat_sessions cs ON cs.id=ct.session_id AND cs.state='active'
    JOIN combat_members cm ON cm.session_id=cs.id AND cm.character_id=q.character_id AND cm.is_defeated=0
    WHERE q.character_id=? AND q.profession_code='sword_shadow' AND q.stage=6 LIMIT 1`, [sessionId, ownerCharacterId]);
  if (!quests[0]) return;
  await connection.execute(`INSERT INTO player_map_hidden_advanced_trial_actions
    (character_id,profession_code,session_id,skill_code,successful) VALUES (?,'sword_shadow',?,'__sheathe_combo__',1)
    ON DUPLICATE KEY UPDATE successful=1`, [ownerCharacterId, sessionId]);
};

/** 战斗结算点记录真实动作；同回合、同目标的同一事件只记一次。 */
export const recordMapHiddenTrialEvent = async (connection: PoolConnection, sessionId: string, ownerCharacterId: number, eventCode: string, targetId?: number) => {
  const [rows] = await connection.execute<(Quest & { turn_no: number })[]>(`SELECT q.*,cs.turn_no
    FROM player_map_hidden_advanced_quests q
    JOIN combat_targets ct ON ct.spawn_id=q.trial_spawn_id AND ct.session_id=?
    JOIN combat_sessions cs ON cs.id=ct.session_id AND cs.state='active'
    JOIN combat_members cm ON cm.session_id=cs.id AND cm.character_id=q.character_id AND cm.is_defeated=0
    JOIN monster_spawns s ON s.id=q.trial_spawn_id
    WHERE q.character_id=? AND q.stage=6
      AND JSON_CONTAINS(COALESCE(s.traits_json,JSON_ARRAY()),JSON_OBJECT('code','map_hidden_advanced_trial','owner_character_id',?,'profession_code',q.profession_code))
    LIMIT 1`, [sessionId, ownerCharacterId, ownerCharacterId]);
  const quest = rows[0];
  if (!quest || !trialEventCodes[String(quest.profession_code)]?.includes(eventCode)) return;
  const target = targetId === undefined ? 0 : Number(targetId);
  if (!Number.isSafeInteger(target) || target < 0) return;
  if (eventCode === 'titan_guard_redirect' || eventCode === 'paladin_guard_redirect') {
    if (!target || target === ownerCharacterId) return;
    const [protectedMember] = await connection.execute<RowDataPacket[]>(`SELECT 1 FROM combat_members
      WHERE session_id=? AND character_id=? LIMIT 1`, [sessionId, target]);
    if (!protectedMember.length) return;
  } else if (target > 0) {
    const [present] = await connection.execute<RowDataPacket[]>(`SELECT 1 FROM combat_targets WHERE session_id=? AND spawn_id=?
      UNION ALL SELECT 1 FROM combat_members WHERE session_id=? AND character_id=? LIMIT 1`,
    [sessionId, target, sessionId, target]);
    if (!present.length) return;
  }
  await connection.execute(`INSERT IGNORE INTO player_map_hidden_advanced_trial_events
    (character_id,profession_code,session_id,turn_no,event_code,target_id) VALUES (?,?,?,?,?,?)`,
  [ownerCharacterId, quest.profession_code, sessionId, quest.turn_no, eventCode, target]);
};

/** 仅由本人击败自己开启的导师 spawn 后调用；资格和当前二转在同一事务中更新。 */
export const completeMapHiddenAdvancedTrial = async (connection: PoolConnection, characterId: number, professionCode: string, spawnId: number, sessionId: string) => {
  const profession = professionFor(professionCode);
  if (!profession) return null;
  const [characters] = await connection.execute<Character[]>(`SELECT c.id,c.level,c.profession_code,c.adventurer_registered,c.current_region_id,
      r.code AS region_code,c.pos_x,c.pos_y,c.pos_z,c.perception,c.perception_growth,c.activity_status
    FROM characters c JOIN map_regions r ON r.id=c.current_region_id WHERE c.id=? AND c.npc_id IS NULL LIMIT 1 FOR UPDATE`, [characterId]);
  const character = characters[0];
  if (!character) return null;
  const { mentor } = await assertAtDiscoveredMentor(connection, character, professionCode);
  const quest = await questFor(connection, characterId, professionCode, true);
  if (!quest || Number(quest.stage) !== 6 || Number(quest.trial_spawn_id) !== Number(spawnId)) return null;
  const [evidence] = await connection.execute<RowDataPacket[]>(`SELECT 1 FROM combat_sessions cs
    JOIN combat_targets ct ON ct.session_id=cs.id AND ct.spawn_id=? AND ct.is_defeated=1
    JOIN combat_members cm ON cm.session_id=cs.id AND cm.character_id=? AND cm.is_defeated=0
    JOIN monster_spawns s ON s.id=ct.spawn_id AND s.region_id=? AND s.pos_x=? AND s.pos_y=? AND s.pos_z=?
    JOIN monster_templates t ON t.id=s.template_id AND t.code=?
    WHERE cs.id=? AND cs.state='victory'
      AND JSON_CONTAINS(COALESCE(s.traits_json,JSON_ARRAY()),JSON_OBJECT('code','advanced_profession_trial','owner_character_id',?))
      AND JSON_CONTAINS(COALESCE(s.traits_json,JSON_ARRAY()),JSON_OBJECT('code','map_hidden_advanced_trial','owner_character_id',?,'profession_code',?))
    LIMIT 1`, [spawnId, characterId, mentor.region_id, mentor.pos_x, mentor.pos_y, mentor.pos_z,
    profession.trial.code, sessionId, characterId, characterId, professionCode]);
  if (!evidence.length) return null;
  const [actions] = await connection.execute<(RowDataPacket & { skill_code: string })[]>(`SELECT skill_code
    FROM player_map_hidden_advanced_trial_actions WHERE character_id=? AND profession_code=? AND session_id=? AND successful=1`,
  [characterId, professionCode, sessionId]);
  const used = new Set(actions.map(row => String(row.skill_code)));
  const requirements = trialRequiredSkills[professionCode];
  if (!requirements || requirements.every.some(skillCode => !used.has(skillCode))
    || !requirements.attackAny.some(skillCode => used.has(skillCode))
    || (requirements.combo && !used.has('__sheathe_combo__')))
    return { profession, failed: true as const, instruction: mapHiddenAdvancedQuests[professionCode].trialInstruction };
  const [trialEvents] = await connection.execute<(RowDataPacket & MapHiddenTrialEvent)[]>(`SELECT id,turn_no,event_code,target_id
    FROM player_map_hidden_advanced_trial_events
    WHERE character_id=? AND profession_code=? AND session_id=? ORDER BY turn_no,id`,
  [characterId, professionCode, sessionId]);
  if (!trialEventEvidenceSatisfied(professionCode, quest, trialEvents))
    return { profession, failed: true as const, instruction: mapHiddenAdvancedQuests[professionCode].trialInstruction };
  await retireTrialSpawns(connection, quest);
  await updateStage(connection, quest, 7);
  await connection.execute(`UPDATE player_map_hidden_advanced_quests SET completed_at=NOW() WHERE character_id=? AND profession_code=?`, [characterId, professionCode]);
  await connection.execute(`INSERT IGNORE INTO player_map_hidden_advanced_qualifications
    (character_id,profession_code) VALUES (?,?)`, [characterId, professionCode]);
  await recordCharacterOperation(connection, { characterId, kind: 'profession.map_hidden_qualified',
    source: { system: 'map_hidden_advanced_trial', id: sessionId, step: 'qualified' }, outcome: '完成',
    summary: `通过${profession.name}隐藏导师试炼`, detail: { professionCode, spawnId, sessionId } });
  const current = await currentProfessionFor(connection, characterId, true);
  if (current?.profession_code === professionCode || cooldownSeconds(current) > 0) return { profession, qualifiedOnly: true as const };
  const granted = await grantMapHiddenAdvancedProfession(connection, characterId, professionCode);
  return { ...granted, qualifiedOnly: false as const };
};
