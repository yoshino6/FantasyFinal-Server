import { recordAchievement } from './achievement-events';
import { randomUUID } from 'node:crypto';
import { recordCharacterOperation } from './character-operation.service';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { getPool, withTransaction } from '../database/pool';
import { activeSkillCodesForAdvancedProfession, advancedProfessionByCode, advancedProfessionByMentor, advancedProfessionInheritanceCodes, advancedInheritanceSkillCode, inheritancePassiveFor, mapHiddenAdvancedProfessionByCode, mapHiddenAdvancedProfessions, type AdvancedProfession, worldTreeAdvancedProfessions } from './advanced-profession.config';
import { legacySpiritSummonerSkillCodes } from './spirit-summoner.config';
import { advancedMentorTrialBuild, advancedMentorTrialTraits } from './advanced-mentor-trial.config';
import { resetSkillPointAllocation } from './skill-point-ledger.service';
import { recalculateCharacterStats } from './character.service';
import { durationText } from './time-format';
import { hiddenProfessions, hiddenSkills, hiddenPassiveCode } from './hidden-profession.config';
import { assertCombatLoadoutMutable } from './combat-loadout-lock.service';
import { consumeBinding, consumeInventory, type Binding } from './inventory-binding';

type Character = RowDataPacket & { id: number; level: number; profession: string; current_region_id: number; region_code: string; pos_x: number; pos_y: number };
type Quest = RowDataPacket & { profession_code: string; stage: number; story_kills: number; proof_kills: number; completed_at: Date | null };
type CompletedProfession = RowDataPacket & { profession_code: string; completed_at: Date };

const advancedProfessionRetrainCooldownMs = 24 * 60 * 60_000;

const allAdvancedProfessionSkillCodes = [...new Set([
  ...worldTreeAdvancedProfessions.flatMap(profession => [profession.passive.code, ...activeSkillCodesForAdvancedProfession(profession.code)]),
  ...mapHiddenAdvancedProfessions.flatMap(profession => [profession.passive.code, ...activeSkillCodesForAdvancedProfession(profession.code)]),
  ...legacySpiritSummonerSkillCodes,
  ...advancedProfessionInheritanceCodes,
  ...hiddenSkills.map(skill => skill.code), ...hiddenProfessions.map(profession => hiddenPassiveCode(profession.code))
])];

/** 二转职业始终以 player_advanced_professions 当前记录为准；旧职业技能与快捷配置不得残留。 */
export const revokeAdvancedProfessionSkills = async (connection: PoolConnection, characterId: number) => {
  if (!allAdvancedProfessionSkillCodes.length) return;
  const placeholders = allAdvancedProfessionSkillCodes.map(() => '?').join(',');
  const values = [characterId, ...allAdvancedProfessionSkillCodes];
  await connection.execute(`DELETE pss FROM player_skill_specializations pss JOIN skill_definitions s ON s.id=pss.skill_id
    WHERE pss.character_id=? AND s.code IN (${placeholders})`, values);
  for (const table of ['player_auto_battle_actions', 'player_pvp_auto_battle_actions']) {
    await connection.execute(`UPDATE ${table} a JOIN skill_definitions s ON s.id=a.skill_id
      SET a.skill_id=NULL WHERE a.character_id=? AND s.code IN (${placeholders})`, values);
  }
  await connection.execute(`DELETE ps FROM player_skills ps JOIN skill_definitions s ON s.id=ps.skill_id
    WHERE ps.character_id=? AND s.code IN (${placeholders})`, values);
};

const characterFor = async (qqUserId: string, connection?: Pool | PoolConnection) => {
  const db = connection ?? await getPool();
  const [rows] = await db.execute<Character[]>(`SELECT c.id,c.level,c.profession_code AS profession,c.current_region_id,r.code AS region_code,c.pos_x,c.pos_y
    FROM characters c JOIN players p ON p.id=c.player_id JOIN map_regions r ON r.id=c.current_region_id
    WHERE p.qq_user_id=? AND c.npc_id IS NULL LIMIT 1`, [qqUserId]);
  if (!rows[0]) throw new Error('请先创建角色。');
  return rows[0];
};

const assertAtMentor = (character: Character, profession: AdvancedProfession) => {
  if (character.region_code !== 'world_tree' || Number(character.pos_x) !== profession.mentor.x || Number(character.pos_y) !== profession.mentor.y) throw new Error(`请前往世界树的【${profession.mentor.title}·${profession.mentor.name}】处。`);
};

export const isWorldTreeAdvancedMentor = (code: string) => Boolean(advancedProfessionByMentor(code));

export type AdvancedProfessionView = {
  profession: AdvancedProfession;
  character: Character;
  /** 当前导师的进行中任务；已完成的历史记录不再视为任务。 */
  active: Quest | null;
  /** 同一角色全局唯一的进行中二转任务，用于切换前确认。 */
  activeQuest: Quest | null;
  completedCode: string | null;
  retrainRemainingSeconds: number;
  materialQuantity: number;
};

/** 角色页远程读取任务与导师候选；只有到达对应导师后才可办理试炼步骤。 */
export const advancedProfessionOverview = async (qqUserId: string) => {
  const pool = await getPool(); const character = await characterFor(qqUserId, pool);
  const [quests] = await pool.execute<Quest[]>('SELECT profession_code,stage,story_kills,proof_kills,completed_at FROM player_advanced_profession_quests WHERE character_id=? AND stage IN (1,2,3) ORDER BY stage DESC,profession_code ASC', [character.id]);
  const [done] = await pool.execute<CompletedProfession[]>('SELECT profession_code,completed_at FROM player_advanced_professions WHERE character_id=? LIMIT 1', [character.id]);
  const [hidden] = await pool.execute<(RowDataPacket & { profession_code: string })[]>(`SELECT profession_code FROM player_map_hidden_advanced_quests
    WHERE character_id=? AND stage BETWEEN 2 AND 6 LIMIT 1`, [character.id]);
  const materialCodes = [...new Set(worldTreeAdvancedProfessions.map(profession => profession.route.materialCode))];
  const [materials] = await pool.execute<(RowDataPacket & { code: string; quantity: number })[]>(`SELECT i.code,pi.quantity FROM player_inventory pi
    JOIN item_definitions i ON i.id=pi.item_id WHERE pi.character_id=? AND i.code IN (${materialCodes.map(() => '?').join(',')})`, [character.id, ...materialCodes]);
  const retrainRemainingSeconds = done[0]
    ? Math.max(0, Math.ceil((new Date(done[0].completed_at).getTime() + advancedProfessionRetrainCooldownMs - Date.now()) / 1000))
    : 0;
  return { character, activeQuest: quests[0] ?? null, completed: done[0] ?? null, hiddenQuest: hidden[0]?.profession_code ?? null,
    retrainRemainingSeconds,
    materialQuantities: Object.fromEntries(materials.map(row => [row.code, Number(row.quantity)])), professions: worldTreeAdvancedProfessions };
};

export const advancedProfessionView = async (qqUserId: string, mentorCode?: string): Promise<AdvancedProfessionView> => {
  const pool = await getPool(); const character = await characterFor(qqUserId, pool);
  const profession = mentorCode ? advancedProfessionByMentor(mentorCode) : undefined;
  if (!profession) throw new Error('这位导师暂未开放二转试炼。');
  assertAtMentor(character, profession);
  const [activeQuests] = await pool.execute<Quest[]>('SELECT profession_code,stage,story_kills,proof_kills,completed_at FROM player_advanced_profession_quests WHERE character_id=? AND stage IN (1,2,3) ORDER BY stage DESC,profession_code ASC', [character.id]);
  const [done] = await pool.execute<CompletedProfession[]>('SELECT profession_code,completed_at FROM player_advanced_professions WHERE character_id=? LIMIT 1', [character.id]);
  const [cores] = await pool.execute<(RowDataPacket & { quantity: number })[]>('SELECT pi.quantity FROM player_inventory pi JOIN item_definitions i ON i.id=pi.item_id WHERE pi.character_id=? AND i.code=? LIMIT 1', [character.id, profession.route.materialCode]);
  const activeQuest = activeQuests[0] ?? null;
  const retrainRemainingSeconds = done[0]
    ? Math.max(0, Math.ceil((new Date(done[0].completed_at).getTime() + advancedProfessionRetrainCooldownMs - Date.now()) / 1000))
    : 0;
  return { profession, character, active: activeQuest?.profession_code === profession.code ? activeQuest : null, activeQuest, completedCode: done[0]?.profession_code ?? null, retrainRemainingSeconds, materialQuantity: Number(cores[0]?.quantity ?? 0) };
};

/** 接受新导师任务不会立刻替换当前职业；真正的二转替换仍在击败新导师后发生。 */
export const beginAdvancedProfessionInTransaction = async (connection: PoolConnection, qqUserId: string, code: string, replaceActiveQuest = false, preview = false) => {
  const profession = advancedProfessionByCode(code); if (!profession) throw new Error('未知的二转职业。');
  const character = await characterFor(qqUserId, connection); assertAtMentor(character, profession);
  if (Number(character.level) < 25) throw new Error('二转试炼将在 Lv.25 开放。');
  if (!character.profession) throw new Error('请先选择初始职业。');
  const [mapHiddenQuests] = await connection.execute<RowDataPacket[]>(`SELECT profession_code FROM player_map_hidden_advanced_quests
    WHERE character_id=? AND stage BETWEEN 2 AND 6 LIMIT 1 FOR UPDATE`, [character.id]);
  if (mapHiddenQuests.length) throw new Error('你正在进行地图隐藏二转任务，请先回原隐藏导师中断当前任务。');
  const [done] = await connection.execute<CompletedProfession[]>('SELECT profession_code,completed_at FROM player_advanced_professions WHERE character_id=? LIMIT 1 FOR UPDATE', [character.id]);
  const currentProfession = done[0];
  if (currentProfession?.profession_code === profession.code) throw new Error(`你当前已经是【${profession.name}】，无需重复接受这条试炼。`);
  if (currentProfession) {
    const remainingSeconds = Math.ceil((new Date(currentProfession.completed_at).getTime() + advancedProfessionRetrainCooldownMs - Date.now()) / 1000);
    if (remainingSeconds > 0) throw new Error(`重新二转仍在冷却中，请在 ${durationText(remainingSeconds)} 后再来。`);
  }
  const [activeQuests] = await connection.execute<Quest[]>('SELECT profession_code,stage,story_kills,proof_kills,completed_at FROM player_advanced_profession_quests WHERE character_id=? AND stage IN (1,2,3) FOR UPDATE', [character.id]);
  const currentQuest = activeQuests.find(quest => quest.profession_code === profession.code);
  const otherQuest = activeQuests.find(quest => quest.profession_code !== profession.code);
  const quote = { action: replaceActiveQuest ? 'switch_quest' : 'accept', professionCode: profession.code, professionName: profession.name,
    mentorCode: profession.mentor.code, stageBefore: Number(currentQuest?.stage ?? otherQuest?.stage ?? 0), stageAfter: 1,
    routeMapCodes: profession.route.maps,
    replacedQuestCode: otherQuest?.profession_code ?? null, replacedQuestStage: otherQuest ? Number(otherQuest.stage) : null,
    replacedStoryKills: otherQuest ? Number(otherQuest.story_kills) : null, replacedProofKills: otherQuest ? Number(otherQuest.proof_kills) : null,
    currentProfessionCode: currentProfession?.profession_code ?? null,
    currentProfessionCompletedAt: currentProfession ? new Date(currentProfession.completed_at).toISOString() : null,
    characterLevel: Number(character.level), baseProfession: character.profession };
  if (currentQuest && !otherQuest) {
    if (!preview) await (await import('./progression-map.service')).ensureProgressionMaps(connection,Number(character.id));
    return quote;
  }
  if (otherQuest && !replaceActiveQuest) {
    const activeProfession = advancedProfessionByCode(otherQuest.profession_code);
    throw new Error(`你正在进行【${activeProfession?.name ?? (otherQuest.profession_code === 'spirit_summoner' ? '唤灵师' : otherQuest.profession_code)}】的二转任务。确认中断当前进度后，才能开启新的试炼。`);
  }
  if (preview) return quote;
  if (otherQuest) {
    if (otherQuest.profession_code === 'spirit_summoner') {
      // 旧世界树唤灵师进度转为历史中断记录，不能自动兑换地图隐藏资格。
      await connection.execute(`UPDATE player_advanced_profession_quests SET stage=5,completed_at=NULL
        WHERE character_id=? AND profession_code='spirit_summoner' AND stage IN (1,2,3)`, [character.id]);
    } else await connection.execute('DELETE FROM player_advanced_profession_quests WHERE character_id=? AND stage IN (1,2,3)', [character.id]);
    await recordCharacterOperation(connection,{characterId:Number(character.id),kind:'profession.advanced_quest_abandoned',source:{system:'advanced_profession_quest',id:randomUUID(),step:'abandoned'},outcome:'中断',summary:`中断${otherQuest.profession_code === 'spirit_summoner' ? '唤灵师' : advancedProfessionByCode(otherQuest.profession_code)?.name??otherQuest.profession_code}试炼`,detail:{professionCode:otherQuest.profession_code,stage:Number(otherQuest.stage),legacyPreserved:otherQuest.profession_code === 'spirit_summoner'}});
  }
  await connection.execute(`INSERT INTO player_advanced_profession_quests (character_id,profession_code,stage,story_kills,proof_kills)
    VALUES (?,?,1,0,0) ON DUPLICATE KEY UPDATE stage=1,story_kills=0,proof_kills=0,completed_at=NULL`, [character.id, profession.code]);
  await (await import('./progression-map.service')).ensureProgressionMaps(connection,Number(character.id));
  await recordCharacterOperation(connection,{characterId:Number(character.id),kind:'profession.advanced_quest_accepted',source:{system:'advanced_profession_quest',id:randomUUID(),step:'accepted'},outcome:'接取',summary:`接取${profession.name}试炼`,detail:{professionCode:profession.code,replacedProfessionCode:otherQuest?.profession_code??null}});
  return quote;
};
export const beginAdvancedProfession = async (qqUserId: string, code: string, replaceActiveQuest = false) => withTransaction(async connection => {
  await beginAdvancedProfessionInTransaction(connection, qqUserId, code, replaceActiveQuest);
  return advancedProfessionByCode(code)!;
});

export const advanceAdvancedProfessionStageInTransaction = async (connection: PoolConnection, qqUserId: string, code: string, preview = false) => {
  const profession = advancedProfessionByCode(code); if (!profession) throw new Error('未知的二转职业。');
  const character = await characterFor(qqUserId, connection); assertAtMentor(character, profession);
  const [rows] = await connection.execute<Quest[]>('SELECT profession_code,stage,story_kills,proof_kills,completed_at FROM player_advanced_profession_quests WHERE character_id=? AND profession_code=? FOR UPDATE', [character.id, code]);
  const quest = rows[0]; if (!quest || Number(quest.stage) !== 1) throw new Error('当前不能提交第一段见闻。');
  if (Number(quest.story_kills) < profession.first.requiredKills) throw new Error(`还需完成 ${profession.first.requiredKills - Number(quest.story_kills)} 次【${profession.first.targetText}】战斗。`);
  const quote = { action: 'submit_story', professionCode: code, professionName: profession.name,
    stageBefore: 1, stageAfter: 2, storyKills: Number(quest.story_kills), requiredKills: profession.first.requiredKills,
    targetText: profession.first.targetText, routeName: profession.route.name };
  if (preview) return quote;
  await connection.execute('UPDATE player_advanced_profession_quests SET stage=2 WHERE character_id=? AND profession_code=?', [character.id, code]);
  await recordCharacterOperation(connection,{characterId:Number(character.id),kind:'profession.advanced_quest_stage',source:{system:'advanced_profession_quest',id:randomUUID(),step:'stage_2'},outcome:'推进',summary:`提交${profession.name}试炼第一段见闻`,detail:{professionCode:code,stage:2,storyKills:Number(quest.story_kills)}});return quote;
};
export const advanceAdvancedProfessionStage = async (qqUserId: string, code: string) => withTransaction(async connection => {
  await advanceAdvancedProfessionStageInTransaction(connection, qqUserId, code);
  return advancedProfessionByCode(code)!;
});

export const submitAdvancedProfessionProofInTransaction = async (connection: PoolConnection, qqUserId: string, code: string, preview = false) => {
  const profession = advancedProfessionByCode(code); if (!profession) throw new Error('未知的二转职业。');
  const character = await characterFor(qqUserId, connection); assertAtMentor(character, profession);
  const [rows] = await connection.execute<Quest[]>('SELECT profession_code,stage,story_kills,proof_kills,completed_at FROM player_advanced_profession_quests WHERE character_id=? AND profession_code=? FOR UPDATE', [character.id, code]);
  const quest = rows[0]; if (!quest || Number(quest.stage) !== 2) throw new Error('当前不能提交第二段凭证。');
  if (Number(quest.proof_kills) < profession.second.requiredKills) throw new Error(`还需完成 ${profession.second.requiredKills - Number(quest.proof_kills)} 次【${profession.second.targetText}】战斗。`);
  const [cores] = await connection.execute<(RowDataPacket & { item_id: number; quantity: number; trade_bound_quantity: number; personal_bound_quantity: number })[]>(
    'SELECT pi.item_id,pi.quantity,pi.trade_bound_quantity,pi.personal_bound_quantity FROM player_inventory pi JOIN item_definitions i ON i.id=pi.item_id WHERE pi.character_id=? AND i.code=? FOR UPDATE',
    [character.id, profession.route.materialCode]);
  if (Number(cores[0]?.quantity ?? 0) < profession.second.materialCount) throw new Error(`还需 ${profession.second.materialCount - Number(cores[0]?.quantity ?? 0)} 个【${profession.route.materialName}】。`);
  const materialBindingBefore: Binding = { unbound: Number(cores[0].quantity) - Number(cores[0].trade_bound_quantity) - Number(cores[0].personal_bound_quantity),
    trade: Number(cores[0].trade_bound_quantity), personal: Number(cores[0].personal_bound_quantity) };
  const materialBindingUsed = consumeBinding(materialBindingBefore, profession.second.materialCount);
  const quote = { action: 'submit_proof', professionCode: code, professionName: profession.name,
    stageBefore: 2, stageAfter: 3, proofKills: Number(quest.proof_kills), requiredKills: profession.second.requiredKills,
    targetText: profession.second.targetText, materialCode: profession.route.materialCode, materialName: profession.route.materialName,
    materialCount: profession.second.materialCount, materialOwnedBefore: Number(cores[0].quantity), materialBindingBefore, materialBindingUsed };
  if (preview) return quote;
  const consumed = await consumeInventory(connection, Number(character.id), Number(cores[0].item_id), profession.second.materialCount);
  if (JSON.stringify(consumed) !== JSON.stringify(materialBindingUsed)) throw new Error('凭证绑定状态已变化，请重新提交。');
  await connection.execute('UPDATE player_advanced_profession_quests SET stage=3 WHERE character_id=? AND profession_code=?', [character.id, code]);
  await recordCharacterOperation(connection,{characterId:Number(character.id),kind:'profession.advanced_quest_stage',source:{system:'advanced_profession_quest',id:randomUUID(),step:'stage_3'},outcome:'推进',summary:`提交${profession.name}试炼凭证`,detail:{professionCode:code,stage:3,proofKills:Number(quest.proof_kills),materialCode:profession.route.materialCode,consumedMaterial:profession.second.materialCount,materialBindingUsed}});return quote;
};
export const submitAdvancedProfessionProof = async (qqUserId: string, code: string) => withTransaction(async connection => {
  await submitAdvancedProfessionProofInTransaction(connection, qqUserId, code);
  return advancedProfessionByCode(code)!;
});

export const beginAdvancedProfessionTrialInTransaction = async (connection: PoolConnection, qqUserId: string, code: string) => {
  const profession = advancedProfessionByCode(code); if (!profession) throw new Error('未知的二转职业。');
  const character = await characterFor(qqUserId, connection); assertAtMentor(character, profession);
  const [quests] = await connection.execute<Quest[]>('SELECT profession_code,stage,story_kills,proof_kills,completed_at FROM player_advanced_profession_quests WHERE character_id=? AND profession_code=? FOR UPDATE', [character.id, code]);
  if (!quests[0] || Number(quests[0].stage) !== 3) throw new Error('请先完成前两段试炼。');
  const [templates] = await connection.execute<(RowDataPacket & { id: number })[]>('SELECT id FROM monster_templates WHERE code=? LIMIT 1', [profession.trial.code]);
  if (!templates[0]) throw new Error('导师试炼尚未完成初始化，请稍后重试。');
  const build = advancedMentorTrialBuild(profession, inheritancePassiveFor(profession.code));
  const traits = [
    { code: 'advanced_profession_trial', name: '二转导师试炼', owner_character_id: character.id, profession_code: profession.code },
    ...advancedMentorTrialTraits(build)
  ];
  const skillSequence = [...new Set([...build.rotation, 'boss_mana_charge'])];
  const [existing] = await connection.execute<(RowDataPacket & { id: number; traits_json: unknown })[]>(`SELECT s.id,s.traits_json FROM monster_spawns s JOIN monster_templates t ON t.id=s.template_id
    WHERE t.code=? AND s.region_id=? AND s.pos_x=? AND s.pos_y=? AND s.defeated_at IS NULL
      AND JSON_CONTAINS(COALESCE(s.traits_json,JSON_ARRAY()),JSON_OBJECT('code','advanced_profession_trial','owner_character_id',?))
    LIMIT 1 FOR UPDATE`, [profession.trial.code, character.current_region_id, character.pos_x, character.pos_y, character.id]);
  if (existing[0]) {
    const [active] = await connection.execute<RowDataPacket[]>("SELECT 1 FROM combat_targets ct JOIN combat_sessions cs ON cs.id=ct.session_id WHERE ct.spawn_id=? AND cs.state='active' LIMIT 1", [existing[0].id]);
    if (active.length) throw new Error('导师正在战斗，请先结束当前试炼。');
    if (Number((typeof existing[0].traits_json === 'string' ? JSON.parse(existing[0].traits_json) : existing[0].traits_json as any[]).find((trait: any) => trait.code === 'advanced_mentor_build')?.build?.version ?? 0) < build.version) await connection.execute(`UPDATE monster_spawns SET level=30,constitution=?,spirit=?,strength=?,intelligence=?,agility=?,perception=?,current_hp=?,skill_sequence=?,traits_json=? WHERE id=?`, [
      build.trainedAttributes.constitution, build.trainedAttributes.spirit, build.trainedAttributes.strength, build.trainedAttributes.intelligence, build.trainedAttributes.agility, build.trainedAttributes.perception,
      build.stats.hpMax, JSON.stringify(skillSequence), JSON.stringify(traits), existing[0].id
    ]);
    return { profession, spawnId: Number(existing[0].id) };
  }
  const [result] = await connection.execute<any>(`INSERT INTO monster_spawns (template_id,region_id,pos_x,pos_y,pos_z,level,constitution,spirit,strength,intelligence,agility,perception,current_hp,skill_sequence,traits_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    templates[0].id, character.current_region_id, character.pos_x, character.pos_y, 0, 30,
    build.trainedAttributes.constitution, build.trainedAttributes.spirit, build.trainedAttributes.strength, build.trainedAttributes.intelligence, build.trainedAttributes.agility, build.trainedAttributes.perception,
    build.stats.hpMax, JSON.stringify(skillSequence), JSON.stringify(traits)
  ]);
  await recordCharacterOperation(connection,{characterId:Number(character.id),kind:'profession.advanced_trial_started',source:{system:'advanced_profession_trial',id:Number(result.insertId),step:'started'},outcome:'开始',summary:`开始${profession.name}导师试炼`,detail:{professionCode:code,spawnId:Number(result.insertId)}});
  return { profession, spawnId: Number(result.insertId) };
};
export const beginAdvancedProfessionTrial = async (qqUserId: string, code: string) =>
  withTransaction(connection => beginAdvancedProfessionTrialInTransaction(connection, qqUserId, code));

export const recordAdvancedProfessionKills = async (connection: PoolConnection, characterId: number, targetCodes: string[]) => {
  if (!targetCodes.length) return;
  const [rows] = await connection.execute<Quest[]>('SELECT profession_code,stage,story_kills,proof_kills,completed_at FROM player_advanced_profession_quests WHERE character_id=? AND stage IN (1,2) LIMIT 1 FOR UPDATE', [characterId]);
  const quest = rows[0]; const profession = quest ? advancedProfessionByCode(quest.profession_code) : undefined; if (!quest || !profession) return;
  const phase = Number(quest.stage) === 1 ? profession.first : profession.second;
  const gained = targetCodes.filter(code => phase.targetCodes.includes(code)).length; if (!gained) return;
  const column = Number(quest.stage) === 1 ? 'story_kills' : 'proof_kills';
  const cap = phase.requiredKills;
  await connection.execute(`UPDATE player_advanced_profession_quests SET ${column}=LEAST(?,${column}+?) WHERE character_id=? AND profession_code=?`, [cap, gained, characterId, profession.code]);
};

export const completeAdvancedProfessionTrial = async (connection: PoolConnection, characterId: number, trialCode: string) => {
  const profession = advancedProfessionByCode(trialCode); if (!profession) return null;
  const [rows] = await connection.execute<Quest[]>('SELECT profession_code,stage,story_kills,proof_kills,completed_at FROM player_advanced_profession_quests WHERE character_id=? AND profession_code=? FOR UPDATE', [characterId, trialCode]);
  if (!rows[0] || Number(rows[0].stage) !== 3) return null;
  await connection.execute('UPDATE player_advanced_profession_quests SET stage=4,completed_at=NOW() WHERE character_id=? AND profession_code=?', [characterId, trialCode]);
  const reset = await resetSkillPointAllocation(connection, characterId);
  await revokeAdvancedProfessionSkills(connection, characterId);
  await connection.execute(`INSERT INTO player_advanced_professions (character_id,profession_code,mentor_code,completed_at) VALUES (?,?,?,NOW())
    ON DUPLICATE KEY UPDATE profession_code=VALUES(profession_code),mentor_code=VALUES(mentor_code),completed_at=VALUES(completed_at)`, [characterId, profession.code, profession.mentor.code]);
  for (const code of [profession.passive.code, advancedInheritanceSkillCode(profession.code)]) await connection.execute(`INSERT IGNORE INTO player_skills (character_id,skill_id,level,passive_linked)
    SELECT ?,id,1,0 FROM skill_definitions WHERE code=?`, [characterId, code]);
  const activeSkills = activeSkillCodesForAdvancedProfession(profession.code);
  for (const skillCode of activeSkills) await connection.execute(`INSERT IGNORE INTO player_skills (character_id,skill_id,level,passive_linked)
    SELECT ?,id,1,0 FROM skill_definitions WHERE code=?`, [characterId, skillCode]);
  await connection.execute(`INSERT INTO player_inventory (character_id,item_id,quantity)
    SELECT ?,id,1 FROM item_definitions WHERE code='resonance_crystal'
    ON DUPLICATE KEY UPDATE quantity=quantity+1`, [characterId]);
  await recalculateCharacterStats(connection, characterId);
  recordAchievement(connection,characterId,['ACH_A17'],'advanced:'+profession.code+':'+characterId);
  await recordCharacterOperation(connection,{characterId,kind:'profession.advanced_completed',source:{system:'advanced_profession_quest',id:randomUUID(),step:'completed'},outcome:'完成',summary:`完成${profession.name}二转`,detail:{professionCode:profession.code,mentorCode:profession.mentor.code},scoreKey:`advanced:${profession.code}`});
  return { ...profession, reset };
};

/** 只供已验证发现、位置与试炼的地图隐藏导师事务调用；再次核对永久资格和当前职业。 */
export const grantMapHiddenAdvancedProfession = async (connection: PoolConnection, characterId: number, professionCode: string) => {
  const profession = mapHiddenAdvancedProfessionByCode(professionCode);
  if (!profession) throw new Error('未知的地图隐藏二转。');
  const [characters] = await connection.execute<(RowDataPacket & { id: number; level: number; profession_code: string | null; adventurer_registered: number })[]>(
    'SELECT id,level,profession_code,adventurer_registered FROM characters WHERE id=? AND npc_id IS NULL FOR UPDATE', [characterId]);
  const character = characters[0];
  if (!character || Number(character.level) < 25 || !Number(character.adventurer_registered)) throw new Error('角色尚未达到地图隐藏二转资格。');
  const baseCodes: Record<AdvancedProfession['baseProfession'], string> = { 战士: 'warrior', 法师: 'mage', 盗贼: 'rogue', 牧师: 'priest', 射手: 'archer' };
  if (character.profession_code !== baseCodes[profession.baseProfession]) throw new Error('当前主职业与这条隐藏传承不符。');
  const [qualified] = await connection.execute<RowDataPacket[]>(`SELECT 1 FROM player_map_hidden_advanced_qualifications
    WHERE character_id=? AND profession_code=? LIMIT 1 FOR UPDATE`, [characterId, profession.code]);
  if (!qualified.length) throw new Error('尚未取得这条隐藏传承的永久资格。');
  const [mentorLocation] = await connection.execute<RowDataPacket[]>(`SELECT 1 FROM characters c
    JOIN map_regions r ON r.id=c.current_region_id AND r.is_enabled=1 AND r.is_owner_only=0
    JOIN map_hidden_advanced_mentors m ON m.profession_code=? AND m.mentor_code=? AND m.enabled=1
      AND m.region_id=c.current_region_id AND m.pos_x=c.pos_x AND m.pos_y=c.pos_y AND m.pos_z=c.pos_z
    JOIN player_map_hidden_advanced_discoveries d ON d.character_id=c.id AND d.mentor_code=m.mentor_code
    WHERE c.id=? LIMIT 1`, [profession.code, profession.mentor.code, characterId]);
  if (!mentorLocation.length) throw new Error('请在已发现的隐藏导师所在位置完成传承。');
  const [current] = await connection.execute<CompletedProfession[]>(
    'SELECT profession_code,completed_at FROM player_advanced_professions WHERE character_id=? LIMIT 1 FOR UPDATE', [characterId]);
  if (current[0]?.profession_code === profession.code) throw new Error(`你当前已经是【${profession.name}】。`);
  if (current[0]) {
    const remainingSeconds = Math.ceil((new Date(current[0].completed_at).getTime() + advancedProfessionRetrainCooldownMs - Date.now()) / 1000);
    if (remainingSeconds > 0) throw new Error(`重新二转仍在冷却中，请在 ${durationText(remainingSeconds)} 后再来。`);
  }
  await assertCombatLoadoutMutable(connection, characterId);
  const skillCodes = [profession.passive.code, advancedInheritanceSkillCode(profession.code), ...activeSkillCodesForAdvancedProfession(profession.code)];
  if (skillCodes.length !== 6) throw new Error('隐藏二转技能数量不正确。');
  const [skills] = await connection.execute<(RowDataPacket & { id: number; code: string })[]>(
    `SELECT id,code FROM skill_definitions WHERE code IN (${skillCodes.map(() => '?').join(',')})`, skillCodes);
  if (skills.length !== skillCodes.length) throw new Error('隐藏二转技能资料尚未完整载入。');
  const reset = await resetSkillPointAllocation(connection, characterId);
  await revokeAdvancedProfessionSkills(connection, characterId);
  await connection.execute(`INSERT INTO player_advanced_professions (character_id,profession_code,mentor_code,completed_at) VALUES (?,?,?,NOW())
    ON DUPLICATE KEY UPDATE profession_code=VALUES(profession_code),mentor_code=VALUES(mentor_code),completed_at=VALUES(completed_at)`, [characterId, profession.code, profession.mentor.code]);
  for (const skill of skills) await connection.execute('INSERT IGNORE INTO player_skills (character_id,skill_id,level,passive_linked) VALUES (?,?,1,0)', [characterId, skill.id]);
  await connection.execute(`INSERT INTO player_inventory (character_id,item_id,quantity)
    SELECT ?,id,1 FROM item_definitions WHERE code='resonance_crystal'
    ON DUPLICATE KEY UPDATE quantity=quantity+1`, [characterId]);
  await recalculateCharacterStats(connection, characterId);
  recordAchievement(connection, characterId, ['ACH_A17'], `advanced:${profession.code}:${characterId}`);
  await recordCharacterOperation(connection, { characterId, kind: 'profession.map_hidden_completed',
    source: { system: 'map_hidden_advanced_profession', id: randomUUID(), step: 'grant' }, outcome: '完成',
    summary: `完成${profession.name}隐藏二转`, detail: { professionCode: profession.code, mentorCode: profession.mentor.code },
    scoreKey: `advanced:${profession.code}` });
  return { profession, reset };
};
