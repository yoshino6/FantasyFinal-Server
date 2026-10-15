import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { skillSpecializationDetails } from '../src/app-api/skill-specialization-details';
import { skillCombatDetails } from '../src/app-api/skill-combat-details';
import { aoeSkillPower } from '../src/game/aoe-damage.config';

test('skill preview uses Core validation and confirms one transactionally settled action', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/skill.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const requests = new Map<string, { owner: number; kind: string; snapshot: any; result: any }>();
  let nextId = 0;
  let skillPoints = 3;
  let mutations = 0;
  let fighting = false;
  const uuid = () => `00000000-0000-0000-0000-${String(++nextId).padStart(12, '0')}`;
  const connection = {
    execute: async (sql: string) => {
      if (sql.includes('SELECT skill_points FROM characters')) return [[{ skill_points: skillPoints }]];
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const craft = {
    craftCharacterId: async () => 1,
    createCraftRequest: async (_connection: unknown, owner: number, kind: string, snapshot: any) => {
      const token = uuid(); requests.set(token, { owner, kind, snapshot, result: null }); return token;
    },
    craftRequestFor: async (_connection: unknown, owner: number, kind: string, token: string) => {
      const request = requests.get(token);
      if (!request || request.owner !== owner || request.kind !== kind) throw new Error('Invalid request');
      return request;
    },
    completeCraftRequest: async (_connection: unknown, _owner: number, token: string, result: any) => {
      requests.get(token)!.result = result;
    }
  };
  const adventure = {
    learnSkillInTransaction: async (_connection: unknown, _user: string, _skillId: number, preview: boolean) => {
      if (!preview) { mutations++; skillPoints--; }
      return { name: '新技能', cost: 1 };
    },
    skillDetail: async () => ({ code: 'appraisal', learned: true }),
    skillList: async () => ({
      skills: [{ id: 4, code: 'skill_a', name: '已学技能', category: 'physical', tier: '基础', level: 1, quick_slot: 1, passive_linked: 0 }],
      discoveries: [{ id: 5, name: '待学技能', category: 'magic', tier: '基础', learn_cost: 1 }],
      skillPoints, passiveLinkLimit: 2
    }),
    togglePassiveLinkInTransaction: async () => ({ name: '被动', linked: true, limit: 2 }),
    toggleSkillShortcutInTransaction: async () => ({ name: '技能', slot: 1 }),
    upgradeAppraisalInTransaction: async () => ({ name: '鉴识', cost: 1 }),
    upgradeSkillInTransaction: async () => ({ name: '技能', level: 2, cost: 1 }),
    upgradeSkillSpecializationInTransaction: async (..._args: unknown[]) => ({ name: '技能', skillLevel: 2, specialization: 'overcharge', level: 2, cost: 1 })
  };
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: uuid },
    'node:util': { isDeepStrictEqual },
    '../database/pool': { withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work(connection) },
    '../game/alchemy-journal.service': craft,
    '../game/adventure.service': adventure,
    './skill-specialization-details': { skillSpecializationDetails },
    './skill-combat-details': { skillCombatDetails },
    '../game/aoe-damage.config': { aoeSkillPower },
    '../game/blacksmith.service': { craftsmanshipEffect: async () => ({ kind: 'durability', percent: 30, level: 3 }) },
    '../game/combat-loadout-lock.service': { assertCombatLoadoutMutable: async () => {
      if (fighting) throw new Error('战斗中不能调整配置。');
    } }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const service = loaded.exports;

  fighting = true;
  await assert.rejects(service.previewSkillAction('player', { action: 'learn', skillId: 4 }), /战斗中/);
  assert.equal(requests.size, 0);
  fighting = false;
  const preview = await service.previewSkillAction('player', { action: 'learn', skillId: 4 });
  assert.equal(preview.quote.skillPointsBefore, 3);
  assert.equal(preview.quote.skillPointsAfter, 2);
  assert.equal(mutations, 0);
  await assert.rejects(service.confirmSkillAction('player', preview.token, uuid()), /凭据不匹配/);
  skillPoints = 2;
  await assert.rejects(service.confirmSkillAction('player', preview.token, preview.idempotencyKey), /状态已变化/);
  assert.equal(mutations, 0);
  skillPoints = 3;
  const first = await service.confirmSkillAction('player', preview.token, preview.idempotencyKey);
  const replay = await service.confirmSkillAction('player', preview.token, preview.idempotencyKey);
  assert.deepEqual(replay, first);
  assert.equal(mutations, 1);
  assert.equal(skillPoints, 2);
  const learned = await service.skillPage('player', 'learned');
  assert.equal(learned.items[0]?.quickSlot, 1);
  assert.equal(learned.quickSlots[0]?.skillId, 4);
  const available = await service.skillPage('player', 'available');
  assert.equal(available.items[0]?.canLearn, true);
  assert.equal(available.items[0]?.remainingSkillPoints, 1);
  fighting = true;
  const blocked = await service.skillPage('player', 'available');
  assert.equal(blocked.items[0]?.canLearn, false);
  assert.match(blocked.items[0]?.reason ?? '', /战斗中/);
  fighting = false;
  adventure.skillDetail = async () => ({
    id: 4, code: 'skill_a', name: '已学技能', category: 'physical', tier: '基础', description: '',
    learned: true, level: 1, max_level: 2, skillPoints, learn_cost: 1, nextUpgradeCost: 1,
    skill_kind: 'attack', element: '无', range_type: '近战', target_scope: '单体',
    power: 100, mana_cost: 2, cooldown_turns: 1, chant_turns: 0, characterLevel: 12,
    required_weapon_type: null, actualPower: 100, actualManaCost: 2, actualCooldown: 1, actualChant: 0,
    specializations: {}, specializationChoices: [], specializationUpgradeCosts: {},
    specializationMaxLevel: 1, weaponMastery: false, passiveSpecializable: false,
    masteryProficiencyCost: null, masteryFocusCost: null, appraisal: null,
    effectDetails: [{ code: 'vulnerability', name: '脆弱', effect_type: 'stat_modifier', value: 25, duration: 3,
      target_scope: 'enemy', trigger_timing: 'on_hit', stackable: 0, max_stacks: 1, effect_level: 1 }]
  });
  adventure.upgradeSkillInTransaction = async () => { throw new Error('该技能已达到最高等级。'); };
  const detail = await service.skillDetailView('player', 4);
  assert.equal(detail.skill.quickSlot, 1);
  assert.equal(detail.skill.summary, '攻击选定敌人并触发附加效果。');
  assert.match(detail.skill.combatEffects[0].text, /100%威力的物理伤害/);
  assert.deepEqual(detail.skill.combatEffects[1].descriptions, [{ name: '脆弱', text: '物理防御降低25%；强度和持续时间按破韧与韧性对抗结算' }]);
  assert.deepEqual([detail.skill.rangeType, detail.skill.targetScope, detail.skill.requiredWeaponType,
    detail.skill.actualPower, detail.skill.actualManaCost, detail.skill.actualCooldown, detail.skill.actualChant],
  ['近战', '单体', null, 100, 2, 1, 0]);
  assert.deepEqual([detail.skill.basePower, detail.skill.baseManaCost, detail.skill.baseCooldown, detail.skill.baseChant], [100, 2, 1, 0]);
  assert.deepEqual(detail.skill.passiveEffect, {});
  assert.equal(detail.skill.weaponMastery, false);
  assert.equal(detail.skill.characterLevel, 12);
  assert.deepEqual(detail.skill.specializationDetails, []);
  assert.deepEqual(detail.actions.map((action: any) => [action.action, action.enabled]), [['shortcut', true], ['upgrade', false]]);
  assert.match(detail.actions[1]?.reason ?? '', /最高等级/);
  const basicDetail = await adventure.skillDetail();
  skillPoints = 0;
  adventure.skillDetail = async () => ({ ...basicDetail, code: 'appraisal', category: 'bound', characterLevel: 12,
    skillPoints, appraisal: { rangeLevel: 2, informationLevel: 1 }, effectDetails: [] });
  adventure.upgradeAppraisalInTransaction = async () => { throw new Error('技能点不足，升级需要 2 点。'); };
  const appraisal = await service.skillDetailView('player', 4);
  assert.equal(appraisal.skill.specializationDetails[0].cost, 2);
  assert.match(appraisal.skill.specializationDetails[0].currentEffect, /6 级以内/);
  assert.match(appraisal.skill.specializationDetails[0].nextEffect, /9 级以内/);
  assert.equal(appraisal.actions[0].enabled, false);
  assert.match(appraisal.actions[0].reason, /技能点不足/);

  adventure.skillDetail = async () => ({ ...basicDetail, code: 'craftsmanship', category: 'bound', power: 0,
    nextUpgradeCost: null, passive_effect_json: '{"secondaryProfessionScaling":"craftsmanship"}', effectDetails: [] });
  const craftDetail = await service.skillDetailView('player', 4);
  assert.equal(craftDetail.skill.summary, '借助副职业技艺改善打造与炼金收益。');
  assert.match(craftDetail.skill.combatEffects[0].text, /耐久损耗降低30%.*锻造师Lv.3/);
  assert.deepEqual(craftDetail.skill.passiveEffect, { secondaryProfessionScaling: 'craftsmanship' });

  // A single + click still obtains a server quote and immediately confirms it.
  // Only the browser confirmation dialog is removed; server validation remains.
  skillPoints = 3;
  let specializationLevel = 1;
  const specializationCalls: boolean[] = [];
  adventure.upgradeSkillSpecializationInTransaction = async (...args: unknown[]) => {
    const preview = Boolean(args[4]);
    specializationCalls.push(preview);
    if (args[3] !== 'overcharge') throw new Error('请选择有效的专精方向。');
    const cost = specializationLevel;
    if (skillPoints < cost) throw new Error(`技能点不足，升级需要 ${cost} 点。`);
    const result = { name: '技能', skillLevel: specializationLevel + 1, specialization: 'overcharge', level: specializationLevel + 1, cost };
    if (!preview) { specializationLevel++; skillPoints -= cost; mutations++; }
    return result;
  };
  const beforeSpecialization = mutations;
  const plusPreview = await service.previewSkillAction('player', { action: 'specialization', skillId: 4, specialization: 'overcharge' });
  assert.equal(plusPreview.quote.skillPointsBefore, 3);
  assert.equal(plusPreview.quote.skillPointsAfter, 2);
  assert.equal(mutations, beforeSpecialization);
  const plusResult = await service.confirmSkillAction('player', plusPreview.token, plusPreview.idempotencyKey);
  assert.deepEqual(plusResult, { name: '技能', skillLevel: 2, specialization: 'overcharge', level: 2, cost: 1 });
  assert.deepEqual(specializationCalls, [true, true, false]);
  assert.equal(specializationLevel, 2);
  assert.equal(skillPoints, 2);
  const replayPlus = await service.confirmSkillAction('player', plusPreview.token, plusPreview.idempotencyKey);
  assert.deepEqual(replayPlus, plusResult);
  assert.equal(mutations, beforeSpecialization + 1);
  const requestCount = requests.size;
  skillPoints = 0;
  await assert.rejects(service.previewSkillAction('player', { action: 'specialization', skillId: 4, specialization: 'overcharge' }), /技能点不足/);
  assert.equal(requests.size, requestCount);
  assert.equal(mutations, beforeSpecialization + 1);
  fighting = true;
  await assert.rejects(service.previewSkillAction('player', { action: 'specialization', skillId: 4, specialization: 'overcharge' }), /战斗中/);
  assert.equal(requests.size, requestCount);
});
