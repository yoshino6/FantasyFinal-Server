import assert from 'node:assert/strict';
import test from 'node:test';
import { skillAdvancedCombatDetails, advancedSkillSkipsDatabaseEffects } from '../src/app-api/skill-advanced-combat-details';
import { advancedProfessionActiveSkillCodes } from '../src/game/advanced-profession.config';
import { newAdvancedSkillDefinitions } from '../src/game/map-hidden-advanced-skills.config';
import { skillSpecialization } from '../src/game/skill-specialization';
import type { SkillCombatSource } from '../src/app-api/skill-combat-details';

const details = (code: string, overrides: Partial<SkillCombatSource> = {}) => skillAdvancedCombatDetails({
  code, category: 'physical', actualPower: 100, ...overrides
});
const text = (code: string, overrides: Partial<SkillCombatSource> = {}) => details(code, overrides)!
  .flatMap(effect => [effect.text, ...(effect.descriptions ?? []).map(description => description.text)]).join('\n');

test('覆盖当前21职业84项主动，未知技能及被动交给通用展示', () => {
  const codes = Object.values(advancedProfessionActiveSkillCodes).flat().filter(code => !code.startsWith('hidden_'));
  assert.equal(codes.length, 84);
  for (const code of codes) assert.ok(details(code), code);
  assert.equal(details('ordinary_unknown'), undefined);
  assert.equal(details('passive_spirit_breath', { category: 'passive' }), undefined);
});

test('三种林伴召唤在真实早退分支中不造成威力攻击或DB命中效果', () => {
  for (const code of ['ranger_hunters_mark', 'ranger_trap_barrage', 'ranger_flanking_shot']) {
    assert.equal(advancedSkillSkipsDatabaseEffects(code), true);
    assert.match(text(code), /召唤林伴/);
    assert.match(text(code), /恢复其全部生命/);
    assert.doesNotMatch(text(code), /造成100%|施加.*雾标|施加.*束缚|施加.*青鳞毒/);
  }
  for (const skill of newAdvancedSkillDefinitions) {
    assert.equal(advancedSkillSkipsDatabaseEffects(skill.code), skill.category === 'utility', skill.code);
    if (skill.category === 'utility') assert.doesNotMatch(text(skill.code, { category: skill.category, actualPower: skill.power }), /对.*造成.*%威力/);
  }
});

test('基础威力使用当前实际值，缺失时使用AoE配置而非旧描述', () => {
  assert.match(text('elementalist_storm_chain', { category: 'magic', actualPower: 88 }), /造成88%威力/);
  assert.match(text('elementalist_storm_chain', { category: 'magic', actualPower: undefined, power: 80 }), /造成88%威力/);
  assert.match(text('sword_shadow_storm', { actualPower: undefined, power: undefined }), /造成95%威力/);
});

test('新高级机制使用真实状态值，保持18%穿防与1.10/1.25弦锋交替', () => {
  assert.match(text('arcane_pierce', { category: 'magic' }), /18%魔法防御.*30奥术负荷/);
  assert.match(text('arcane_precast', { category: 'utility' }), /威力×1\.12.*魔力×1\.2/);
  assert.match(text('stringblade_cross'), /55%.*非递归/);
  assert.match(text('stringblade_cross'), /×1\.10.*×1\.25/);
  assert.match(text('sword_shadow_chase'), /限制在5%～35%/);
  assert.match(text('sword_shadow_storm'), /首个实际命中的目标/);
});

test('泰坦伤势延期和探囊真实概率不伪装成直接减伤或新增掉落', () => {
  assert.match(text('titan_defer', { category: 'utility' }), /15%.*8%.*延后一回合/);
  assert.match(text('titan_defer', { category: 'utility' }), /没有消除伤势/);
  assert.match(text('thief_pickpocket', { category: 'utility' }), /55%.*12个百分点.*最低15%、最高85%/);
  assert.match(text('thief_pickpocket', { category: 'utility' }), /胜利掉落真实生成且可扣减时兑现/);
});

test('资源费用与目标条件完整，配合剩余毒伤公式和首领上限', () => {
  assert.match(text('venomancer_venom_burst', { category: 'magic' }), /额外消耗50毒性/);
  assert.match(text('venomancer_venom_burst', { category: 'magic' }), /剩余回合之和×60%/);
  assert.match(text('venomancer_venom_burst', { category: 'magic' }), /40%.*6%首领最大生命/);
  assert.match(text('venomancer_thousand_throat', { category: 'magic' }), /合计三次/);
  assert.match(text('ranger_hundred_hunt'), /已有追猎标定/);
  assert.match(text('ranger_hundred_hunt'), /70%.*35%/);
  assert.match(text('nightblade_silent_finale'), /击杀返还50 MP/);
});

test('普通可成长状态复用真实专精公式，机制次数与守护比例不成长', () => {
  const specializationResult = skillSpecialization({ code: 'aegis_undying_dome', category: 'utility', tier: '基础',
    power: 0, mana_cost: 650, cooldown_turns: 7 }, { potent: 3 });
  assert.match(text('aegis_undying_dome', { category: 'utility', specializationResult }), /降低22\.472%/);
  assert.match(text('aegis_undying_dome', { category: 'utility', specializationResult }), /第一次受到致命伤害后保留1生命/);
  assert.match(text('bulwark_vicarious_guard', { category: 'utility', specializationResult }), /单体伤害中35%/);
});

test('不动如山反击有90%触发概率与独立命中，随场林伴不伪造当前状态', () => {
  assert.match(text('bulwark_immovable_mountain', { category: 'utility' }), /90%概率尝试90%物攻/);
  assert.match(text('ranger_eagle_eye', { category: 'utility' }), /不在场则该部分不生效/);
  assert.match(text('ranger_eagle_eye', { category: 'utility' }), /雾标仍为12%/);
  assert.match(text('summoner_reassign', { category: 'utility' }), /下一次职责数值×1\.15/);
  assert.match(text('summoner_triad', { category: 'utility' }), /至少两种不同职责/);
});
