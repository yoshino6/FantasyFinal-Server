import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { consumeBinding, type Binding } from '../src/game/inventory-binding';

test('world tree profession task quotes enforce location, level, competing quests and bound proof payment', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/game/advanced-profession.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const profession = { code: 'war_lord', name: '战旗使', baseProfession: '战士', role: '增益',
    mentor: { code: 'mentor_warlord', name: '旌岚', title: '战旗领唱', x: -6, y: -8 },
    passive: { code: 'passive_banner', name: '旗语', description: '强化队伍' },
    route: { regionCode: 'dark_forest_deep', name: '幽暗密林深处', x: 0, y: -220,
      maps: ['dark_forest_deep'], materialCode: 'goblin_ear', materialName: '哥布林耳' },
    first: { title: '第一段', story: '见闻', targetText: '战鼓手', requiredKills: 3 },
    second: { title: '第二段', story: '凭证', targetText: '盾卫', requiredKills: 5, materialCount: 2 },
    trial: { code: 'mentor_trial_warlord', name: '战旗导师', description: '导师战' } };
  let level = 25;
  let atMentor = true;
  let hiddenQuest = false;
  let completedAt: Date | null = null;
  let quest: { profession_code: string; stage: number; story_kills: number; proof_kills: number; completed_at: null } | null = null;
  let material: Binding = { unbound: 1, trade: 0, personal: 1 };
  let operations = 0;
  const connection = {
    execute: async (sql: string, args: unknown[] = []) => {
      if (sql.includes('FROM characters c JOIN players p JOIN map_regions r')) throw new Error('Unexpected join order');
      if (sql.includes('FROM characters c JOIN players p') && sql.includes('JOIN map_regions r')) return [[{
        id: 7, level, profession: 'warrior', current_region_id: 1, region_code: 'world_tree',
        pos_x: atMentor ? -6 : 0, pos_y: -8 }]];
      if (sql.includes('FROM player_map_hidden_advanced_quests')) return [hiddenQuest ? [{ profession_code: 'hidden' }] : []];
      if (sql.includes('FROM player_advanced_professions WHERE character_id=')) return [completedAt ? [{ profession_code: 'other', completed_at: completedAt }] : []];
      if (sql.includes('FROM player_advanced_profession_quests') && sql.includes('stage IN (1,2,3)')) return [quest ? [quest] : []];
      if (sql.includes('FROM player_advanced_profession_quests') && sql.includes('profession_code=?')) return [quest?.profession_code === args[1] ? [quest] : []];
      if (sql.includes('FROM player_inventory pi JOIN item_definitions i') && sql.includes('FOR UPDATE')) return [[{
        item_id: 9, quantity: material.unbound + material.trade + material.personal,
        trade_bound_quantity: material.trade, personal_bound_quantity: material.personal }]];
      if (sql.includes('FROM player_inventory pi') && sql.includes('i.code IN')) return [[{
        code: 'goblin_ear', quantity: material.unbound + material.trade + material.personal }]];
      if (sql.startsWith('UPDATE player_advanced_profession_quests SET stage=2')) { quest!.stage = 2; return [{ affectedRows: 1 }]; }
      if (sql.startsWith('UPDATE player_advanced_profession_quests SET stage=3')) { quest!.stage = 3; return [{ affectedRows: 1 }]; }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const modules: Record<string, unknown> = {
    './achievement-events': { recordAchievement: () => undefined },
    'node:crypto': { randomUUID: () => 'uuid' },
    './character-operation.service': { recordCharacterOperation: async () => { operations++; } },
    '../database/pool': { getPool: async () => connection,
      withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work(connection) },
    './advanced-profession.config': {
      worldTreeAdvancedProfessions: [profession], mapHiddenAdvancedProfessions: [], advancedProfessionInheritanceCodes: [],
      activeSkillCodesForAdvancedProfession: () => [], advancedProfessionByCode: (code: string) => code === profession.code ? profession : undefined,
      advancedProfessionByMentor: (code: string) => code === profession.mentor.code ? profession : undefined,
      advancedInheritanceSkillCode: () => '', inheritancePassiveFor: () => null,
      mapHiddenAdvancedProfessionByCode: () => undefined
    },
    './spirit-summoner.config': { legacySpiritSummonerSkillCodes: [] },
    './advanced-mentor-trial.config': { advancedMentorTrialBuild: () => ({}), advancedMentorTrialTraits: () => [] },
    './skill-point-ledger.service': { resetSkillPointAllocation: async () => ({}) },
    './character.service': { recalculateCharacterStats: async () => undefined },
    './time-format': { durationText: (seconds: number) => `${seconds} 秒` },
    './hidden-profession.config': { hiddenProfessions: [], hiddenSkills: [], hiddenPassiveCode: () => '' },
    './combat-loadout-lock.service': { assertCombatLoadoutMutable: async () => undefined },
    './inventory-binding': { consumeBinding,
      consumeInventory: async (_connection: unknown, _owner: number, _item: number, amount: number) => {
        const used = consumeBinding(material, amount);
        material = { unbound: material.unbound - used.unbound, trade: material.trade - used.trade,
          personal: material.personal - used.personal };
        return used;
      } }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const core = loaded.exports;

  level = 24;
  await assert.rejects(core.beginAdvancedProfessionInTransaction(connection, 'player', 'war_lord', false, true), /Lv.25/);
  level = 25;
  atMentor = false;
  await assert.rejects(core.beginAdvancedProfessionInTransaction(connection, 'player', 'war_lord', false, true), /世界树/);
  atMentor = true;
  hiddenQuest = true;
  await assert.rejects(core.beginAdvancedProfessionInTransaction(connection, 'player', 'war_lord', false, true), /地图隐藏二转/);
  hiddenQuest = false;
  completedAt = new Date();
  await assert.rejects(core.beginAdvancedProfessionInTransaction(connection, 'player', 'war_lord', false, true), /冷却/);
  completedAt = null;
  quest = { profession_code: 'other', stage: 2, story_kills: 3, proof_kills: 1, completed_at: null };
  await assert.rejects(core.beginAdvancedProfessionInTransaction(connection, 'player', 'war_lord', false, true), /确认中断/);
  const switchQuote = await core.beginAdvancedProfessionInTransaction(connection, 'player', 'war_lord', true, true);
  assert.deepEqual([switchQuote.replacedQuestCode, switchQuote.replacedQuestStage, operations], ['other', 2, 0]);

  quest = { profession_code: 'war_lord', stage: 1, story_kills: 2, proof_kills: 0, completed_at: null };
  await assert.rejects(core.advanceAdvancedProfessionStageInTransaction(connection, 'player', 'war_lord', true), /还需完成 1 次/);
  quest.story_kills = 3;
  const storyQuote = await core.advanceAdvancedProfessionStageInTransaction(connection, 'player', 'war_lord', true);
  assert.deepEqual([storyQuote.stageBefore, storyQuote.stageAfter, quest.stage, operations], [1, 2, 1, 0]);
  await core.advanceAdvancedProfessionStageInTransaction(connection, 'player', 'war_lord');
  assert.deepEqual([quest.stage, operations], [2, 1]);
  quest.proof_kills = 5;
  const proofQuote = await core.submitAdvancedProfessionProofInTransaction(connection, 'player', 'war_lord', true);
  assert.deepEqual(proofQuote.materialBindingUsed, { personal: 1, trade: 0, unbound: 1 });
  assert.deepEqual([quest.stage, material, operations], [2, { unbound: 1, trade: 0, personal: 1 }, 1]);
  await core.submitAdvancedProfessionProofInTransaction(connection, 'player', 'war_lord');
  assert.deepEqual([quest.stage, material, operations], [3, { unbound: 0, trade: 0, personal: 0 }, 2]);
  const overview = await core.advancedProfessionOverview('player');
  assert.deepEqual([overview.activeQuest.stage, overview.professions[0].code], [3, 'war_lord']);
});
