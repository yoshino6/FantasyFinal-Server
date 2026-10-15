import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transformSync } from 'esbuild';
import {
  skillSpecialization, specializationMaximum, specializationOptions, specializationUpgradeCost,
  specializeControlChance, specializeEffectDuration, specializeEffectValue,
  type SkillSpecializations
} from '../src/game/skill-specialization';
import { canSpecializePassive, passiveSpecializationFactor } from '../src/game/passive-specialization';
import { tierLearningCost } from '../src/game/skill-access.config';
import { legacySpiritSummonerSkillCodes } from '../src/game/spirit-summoner.config';

// Execute the real detail reader without importing adventure.service's database
// or platform dependencies. Only its external reads are replaced; all growth,
// caps, rounding and returned metadata use the production implementation.
const source = readFileSync(new URL('../src/game/adventure.service.ts', import.meta.url), 'utf8');
const start = source.indexOf('export const skillDetail = ');
const end = source.indexOf('\nexport const learnSkillInTransaction', start);
assert.ok(start >= 0 && end > start, 'Cannot locate the real skillDetail declaration');
const helpers = ['activeSkillUpgradeCost', 'masteryUpgradeCost', 'weaponMasteryCodes'].map(name => {
  const declaration = source.match(new RegExp(`^const ${name} = .+;$`, 'm'))?.[0];
  assert.ok(declaration, `Missing production helper ${name}`);
  return declaration;
});
const compiled = transformSync([...helpers, source.slice(start, end).replace(/^export /, '')].join('\n'),
  { loader: 'ts', target: 'es2022', format: 'esm' }).code;

type Effect = {
  code: string; name: string; effect_type: string; value: number; duration: number;
  effect_level?: number | null; stackable: number; max_stacks: number;
  target_scope: 'enemy' | 'ally' | 'self'; trigger_timing: 'on_hit' | 'on_cast';
};
const effect = (overrides: Partial<Effect> = {}): Effect => ({
  code: 'slow', name: '减速', effect_type: 'stat_modifier', value: 20, duration: 2,
  effect_level: 1, stackable: 0, max_stacks: 1, target_scope: 'enemy', trigger_timing: 'on_hit', ...overrides
});
const fixture = (effects: Effect[], specializations: SkillSpecializations = {}) => {
  const queries: string[] = [];
  let poolReads = 0;
  const connection = { execute: async (sql: string) => {
    queries.push(sql);
    assert.match(sql, /^SELECT\s/, 'Detail reads must never write through the fake connection');
    if (sql.includes('FROM skill_definitions s LEFT JOIN player_skills')) return [[{
      id: 7, code: 'ordinary_test', name: '测试技能', category: 'magic', tier: '基础', learned: 1,
      level: 4, max_level: 100, learn_cost: 1, mana_cost: 300, cooldown_turns: 3,
      chant_turns: 1, power: 150, passive_effect_json: null
    }]];
    if (sql.includes('FROM skill_effects se JOIN effect_definitions')) return [structuredClone(effects)];
    if (sql.includes('FROM player_skill_specializations')) return [Object.entries(specializations)
      .map(([specialization, level]) => ({ specialization, level }))];
    throw new Error(`Unexpected isolated detail query: ${sql}`);
  } };
  const dependencies = {
    characterFor: async () => ({ id: 1, level: 12, skill_points: 20 }),
    getPool: async () => { poolReads++; return connection; },
    legacySpiritSummonerSkillCodes, skillSpecialization, specializationMaximum,
    specializationOptions, specializationUpgradeCost, specializeControlChance,
    specializeEffectDuration, specializeEffectValue, canSpecializePassive,
    passiveSpecializationFactor, tierLearningCost,
    jsonObject: (value: unknown) => value && typeof value === 'object' ? value : {}
  };
  const readDetail = new Function(...Object.keys(dependencies), `${compiled}\nreturn skillDetail;`)(...Object.values(dependencies)) as
    (user: string, skillId: number, selectedConnection?: typeof connection) => Promise<{
      effectDetails: Effect[]; actualPower: number; actualManaCost: number;
      specializationResult: ReturnType<typeof skillSpecialization>
    }>;
  return { connection, readDetail, queries, poolReads: () => poolReads };
};

test('effect_level先放大原始值，再结算普通强效与上限，避免顺序颠倒', async () => {
  const input = [effect({ code: 'exposed', name: '易伤', value: 40, effect_level: 3 })];
  const before = JSON.stringify(input);
  const f = fixture(input, { potent: 3 });
  const detail = await f.readDetail('test', 7, f.connection);
  const raw = 40 * 1.5;
  assert.equal(detail.effectDetails[0].value, specializeEffectValue('exposed', raw, detail.specializationResult.effectFactor));
  assert.equal(detail.effectDetails[0].value, 60);
  assert.notEqual(detail.effectDetails[0].value, specializeEffectValue('exposed', 40, detail.specializationResult.effectFactor) * 1.5);
  assert.equal(JSON.stringify(input), before);
  assert.equal(f.poolReads(), 0, 'Explicit connection must remain inside the same isolated read');
});

test('控制概率在效果等级放大后走控制上限，不套普通数值分支', async () => {
  const f = fixture([
    effect({ code: 'stun', name: '眩晕', effect_type: 'control', value: 60, effect_level: 2 }),
    effect({ code: 'silence', name: '沉默', effect_type: 'control', value: 80, effect_level: 2 })
  ], { potent: 3 });
  const detail = await f.readDetail('test', 7, f.connection);
  const factor = detail.specializationResult.controlChanceFactor;
  assert.equal(detail.effectDetails[0].value, specializeControlChance(75, factor));
  assert.equal(detail.effectDetails[0].value, 75);
  assert.equal(detail.effectDetails[1].value, 100, 'High native chance must not be weakened by the 75% cap');
  assert.equal(detail.effectDetails[0].duration, 2, 'Hard control duration never receives potency growth');
});

test('普通持续时间按真实强效取整与4回合上限，effect_level不放大时长', async () => {
  const f = fixture([
    effect({ duration: 2, effect_level: 4 }),
    effect({ code: 'shield', name: '护盾', duration: 3 }),
    effect({ code: 'slow', duration: 4 }),
    effect({ code: 'stun', effect_type: 'control', value: 50, duration: 2 })
  ], { potent: 10 });
  const detail = await f.readDetail('test', 7, f.connection);
  assert.deepEqual(detail.effectDetails.map(row => row.duration), [3, 4, 4, 2]);
  assert.equal(detail.effectDetails[0].duration,
    specializeEffectDuration('slow', 2, detail.specializationResult.durationChange));
});

test('等级1与无专精保持原始数值、时长，缺失旧effect_level按1兼容', async () => {
  const inputs = [effect(), effect({ code: 'stun', effect_type: 'control', value: 65 }),
    effect({ code: 'barrier', name: '壁垒', value: 18, duration: 3, effect_level: undefined }),
    effect({ code: 'regeneration', name: '再生', value: 5, duration: 3, effect_level: null })];
  const f = fixture(inputs);
  const detail = await f.readDetail('test', 7);
  assert.deepEqual(detail.effectDetails.map(row => [row.value, row.duration]), inputs.map(row => [row.value, row.duration]));
  assert.equal(f.poolReads(), 1, 'Fallback pool is the fake pool, never a real database');
});

test('详情查询并保留叠层字段与效果等级，不丢失来源、施放时机和目标', async () => {
  const input = effect({ code: 'poison', name: '剧毒', effect_type: 'damage_over_time', value: 5,
    duration: 3, stackable: 1, max_stacks: 5, effect_level: 2 });
  const f = fixture([input], { potent: 2 });
  const detail = await f.readDetail('test', 7, f.connection);
  const result = detail.effectDetails[0];
  assert.equal(result.stackable, 1);
  assert.equal(result.max_stacks, 5);
  assert.equal(result.effect_level, 2);
  assert.equal(result.target_scope, 'enemy');
  assert.equal(result.trigger_timing, 'on_hit');
  assert.equal(result.code, 'poison');
  assert.equal(result.name, '剧毒');
  const sql = f.queries.find(query => query.includes('FROM skill_effects'))!;
  for (const selected of ['e.stackable', 'e.max_stacks', 'se.effect_level']) assert.ok(sql.includes(selected), `Missing SELECT ${selected}`);
  assert.equal(result.value, specializeEffectValue('poison', 6.25, 1.06));
});
