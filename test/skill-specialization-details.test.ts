import assert from 'node:assert/strict';
import test from 'node:test';
import { skillSpecializationDetails } from '../src/app-api/skill-specialization-details';
import { passiveSpecializationFactor } from '../src/game/passive-specialization';
import { skillSpecialization } from '../src/game/skill-specialization';

type Source = Parameters<typeof skillSpecializationDetails>[0];
const fixture = (overrides: Partial<Source> = {}): Source => ({
  code: 'test', category: 'magic', tier: '基础', learned: true, characterLevel: 12,
  power: 150, mana_cost: 300, cooldown_turns: 3, chant_turns: 1,
  specializations: {}, specializationChoices: ['overcharge', 'potent', 'instant', 'efficient'],
  specializationMaxLevel: 10, specializationUpgradeCosts: {}, specializationUpgradeCost: null,
  weaponMastery: false, passiveSpecializable: false, masteryProficiencyCost: null, masteryFocusCost: null,
  ...overrides
});
const rows = (overrides: Partial<Source> = {}) => {
  const source = fixture(overrides);
  return skillSpecializationDetails({ ...source, specializationChoices: [...source.specializationChoices] });
};

test('鉴识慧眼 Lv.2 返回真实当前、下级范围、SP与方向，识珠信息逐级累积', () => {
  const [eye, pearl] = rows({ code: 'appraisal', category: 'bound', appraisal: { rangeLevel: 2, informationLevel: 2 }, specializationChoices: [] });
  assert.deepEqual(eye, {
    key: 'range', name: '慧眼', level: 2, maxLevel: 10,
    currentEffect: '可鉴识高于自身 6 级以内的目标。',
    nextEffect: '可鉴识高于自身 9 级以内的目标。',
    cost: 2, action: 'appraisal', direction: 'range'
  });
  assert.equal(pearl.cost, 3);
  assert.equal(pearl.direction, 'information');
  assert.match(pearl.currentEffect, /名称、生命、魔力、技能；词条、详细属性/);
  assert.doesNotMatch(pearl.currentEffect, /目标仇恨/);
  assert.match(pearl.nextEffect!, /当前状态、目标仇恨、域民资料/);
});

test('满级鉴识、普通、被动、武器仍显示当前效果但没有下级与消耗', () => {
  const sources: Array<Partial<Source>> = [
    { code: 'appraisal', category: 'bound', appraisal: { rangeLevel: 10, informationLevel: 4 } },
    { specializations: { overcharge: 10, potent: 10, instant: 10, efficient: 10 } },
    { category: 'passive', passiveSpecializable: true, specializations: { potent: 10 } },
    { category: 'bound', weaponMastery: true, specializations: { overcharge: 5, instant: 6 }, passive_effect_json: { weaponType: '长剑', critRatePct: 40, masteryStepPct: 10 } }
  ];
  for (const source of sources) for (const item of rows(source)) {
    assert.ok(item.currentEffect.length > 0);
    assert.equal(item.nextEffect, null);
    assert.equal(item.cost, null);
  }
});

test('普通专精保留其他方向组合，单独预览所选方向，消耗与是否能支付无关', () => {
  const specializations = { overcharge: 2, potent: 2, instant: 2, efficient: 2 };
  const source = fixture({ specializations, specializationUpgradeCosts: { overcharge: 2, potent: 2, instant: 2, efficient: 2 } });
  const before = JSON.stringify(source);
  const items = rows(source);
  const current = skillSpecialization(source, specializations);
  const overchargeNext = skillSpecialization(source, { ...specializations, overcharge: 3 });
  assert.equal(items[0].currentEffect, `威力 ${Math.floor(current.power)}；蓝耗 ${current.mana} MP。`);
  assert.equal(items[0].nextEffect, `威力 ${Math.floor(overchargeNext.power)}；蓝耗 ${overchargeNext.mana} MP。`);
  assert.equal(items[0].cost, 2);
  assert.deepEqual(items.map(item => item.specialization), ['overcharge', 'potent', 'instant', 'efficient']);
  assert.match(items[1].currentEffect, /普通效果×1\.06；可成长时长×1\.06；控制概率系数×1\.06/);
  assert.match(items[1].nextEffect!, /普通效果×1\.1236；可成长时长×1\.1236；控制概率系数×1\.1236/);
  const efficientNext = skillSpecialization(source, { ...specializations, efficient: 3 });
  assert.equal(items[3].nextEffect, `蓝耗 ${efficientNext.mana} MP。`);
  assert.equal(JSON.stringify(source), before);
});

test('瞬息按实际整回合规则显示，魔力转赠保留额外当前MP消耗', () => {
  const item = rows({ specializationChoices: ['instant'], specializations: { instant: 1 } })[0];
  assert.match(item.currentEffect, /冷却 3 回合；吟唱 1 回合；时间基数×1；/);
  assert.match(item.nextEffect!, /冷却 3 回合；吟唱 1 回合；时间基数×0\.94；/);
  const transfer = rows({ code: 'resident_d01', specializationChoices: ['instant'], mana_cost: 500 })[0];
  assert.match(transfer.currentEffect, /500 MP＋施法前当前 MP 的8%/);
  assert.match(transfer.nextEffect!, /500 MP＋施法前当前 MP 的8%/);
});

test('被动强效复用衰减公式与费用，不套用主动6%规则', () => {
  const item = rows({ category: 'bound', passiveSpecializable: true, specializations: { potent: 3 }, specializationUpgradeCost: 1 })[0];
  const current = Number(((passiveSpecializationFactor(3, '基础') - 1) * 100).toFixed(4));
  const next = Number(((passiveSpecializationFactor(4, '基础') - 1) * 100).toFixed(4));
  assert.equal(item.currentEffect, `可成长数值 +${current}%；次数、时长与机制保持不变。`);
  assert.equal(item.nextEffect, `可成长数值 +${next}%；次数、时长与机制保持不变。`);
  assert.equal(item.cost, 1);
  assert.equal(item.specialization, 'potent');
});

test('武器娴熟只展示真实JSON声明的非零属性，随心50%升至60%', () => {
  const [proficiency, focus] = rows({
    code: 'custom_mastery', category: 'bound', weaponMastery: true, masteryProficiencyCost: 2, masteryFocusCost: 2,
    passive_effect_json: JSON.stringify({ weaponType: '长剑', critRatePct: 40, physicalAttackPct: 0, masteryStepPct: 10 })
  });
  assert.equal(proficiency.currentEffect, '每把长剑：暴击+40%；副手按随心比例发挥。');
  assert.equal(proficiency.nextEffect, '每把长剑：暴击+50%；副手按随心比例发挥。');
  assert.doesNotMatch(proficiency.nextEffect!, /物攻/);
  assert.match(focus.currentEffect, /发挥 50%/);
  assert.match(focus.nextEffect!, /发挥 60%/);
  assert.equal(focus.specialization, 'instant');
  assert.equal(proficiency.cost, 2);
});

test('只展示可用方向，未学习与固定被动不生成专精条目', () => {
  assert.deepEqual(rows({ learned: false }), []);
  assert.deepEqual(rows({ category: 'passive', passiveSpecializable: false }), []);
  assert.deepEqual(rows({ specializationChoices: [] }), []);
  assert.deepEqual(rows({ specializationChoices: ['efficient'] }).map(item => item.key), ['efficient']);
});
