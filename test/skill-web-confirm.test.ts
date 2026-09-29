import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

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
    upgradeSkillSpecializationInTransaction: async () => ({ name: '技能', level: 2, cost: 1 })
  };
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: uuid },
    '../database/pool': { withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work(connection) },
    '../game/alchemy-journal.service': craft,
    '../game/adventure.service': adventure,
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
    skill_kind: 'attack', element: 'none', range_type: 'melee', target_scope: 'enemy',
    required_weapon_type: null, actualPower: 100, actualManaCost: 2, actualCooldown: 1, actualChant: 0,
    specializations: {}, specializationChoices: [], specializationUpgradeCosts: {},
    specializationMaxLevel: 1, weaponMastery: false, passiveSpecializable: false,
    masteryProficiencyCost: null, masteryFocusCost: null, appraisal: null, effectDetails: []
  });
  adventure.upgradeSkillInTransaction = async () => { throw new Error('该技能已达到最高等级。'); };
  const detail = await service.skillDetailView('player', 4);
  assert.equal(detail.skill.quickSlot, 1);
  assert.deepEqual(detail.actions.map((action: any) => [action.action, action.enabled]), [['shortcut', true], ['upgrade', false]]);
  assert.match(detail.actions[1]?.reason ?? '', /最高等级/);
});
