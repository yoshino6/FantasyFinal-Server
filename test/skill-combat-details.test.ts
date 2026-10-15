import test from 'node:test';
import assert from 'node:assert/strict';
import { skillCombatDetails, type SkillCombatSource } from '../src/app-api/skill-combat-details';
import { residentSkills } from '../src/game/resident-skill.config';
import { folioSkills } from '../src/game/active-folio-skills.config';
import { hiddenSkills } from '../src/game/hidden-profession.config';
import { skillSpecialization } from '../src/game/skill-specialization';
import { CombatRules, emptyRuleState, type RuleUnit } from '../src/game/combat-rule-registry';
import { residentSkillByCode } from '../src/game/resident-skill.config';
import { advancedBoundSkillDefinitions, advancedProfessionActiveSkillCodes } from '../src/game/advanced-profession.config';
import { newAdvancedSkillDefinitions } from '../src/game/map-hidden-advanced-skills.config';
import { nativeSkillBalanceByCode } from '../src/game/combat-skill-balance.config';
import { talentDefinitions } from '../src/game/talent.config';
import { talentManaFactor } from '../src/game/talent-combat';
import { talentPanel } from '../src/game/talent-data';

const source = (patch: Partial<SkillCombatSource> = {}): SkillCombatSource => ({ code: 'fire_lance', category: 'magic', tier: '下位', power: 150, mana_cost: 55, cooldown_turns: 2, ...patch });
const text = (skill: SkillCombatSource) => skillCombatDetails(skill).combatEffects.map(effect => [effect.text, ...(effect.descriptions ?? []).map(item => item.text)].join(' ')).join('\n');

test('技能用途简介独立于旧描述与专精说明，不把未选择目标的伤害伪装成定值', () => {
  const detail = skillCombatDetails({ ...source(), description: '每级威力+6%，升级后更厉害。' } as SkillCombatSource);
  assert.equal(detail.summary, '攻击选定敌人。');
  assert.match(detail.combatEffects[0].text, /150%威力/);
  assert.doesNotMatch(JSON.stringify(detail), /每级|更厉害|升级后/);
});

test('数据库值已包含专精，脆弱仍只降低物防，暴击属性不冒充暴击率', () => {
  const detail = source({ specializations: { potent: 8 }, effectDetails: [
    { code: 'vulnerability', name: '脆弱', effect_type: 'stat_modifier', value: 31.5, duration: 3, target_scope: 'enemy', trigger_timing: 'on_hit' },
    { code: 'critical_focus', name: '会心', effect_type: 'stat_modifier', value: 50, duration: 2, target_scope: 'self', trigger_timing: 'on_cast' }
  ] });
  assert.match(text(detail), /物理防御降低31.5%/);
  assert.doesNotMatch(text(detail), /双防|双防降低|暴击率/);
  assert.match(text(detail), /暴击属性提高50%/);
});

test('原生技能的全队范围、指定友方例外与异械回充按真实分支展示', () => {
  const buff = { code: 'barrier', name: '护盾', effect_type: 'shield', value: 18, duration: 3, target_scope: 'ally', trigger_timing: 'on_cast' };
  assert.match(text(source({ code: 'blessing_aegis', category: 'utility', power: 0, target_scope: '全体', effectDetails: [buff] })), /全体存活友方/);
  const cleanse = { code: 'purify', name: '净化', effect_type: 'cleanse', value: 1, duration: 0, target_scope: 'self', trigger_timing: 'on_cast' };
  assert.match(text(source({ code: 'purifying_light', category: 'utility', power: 0, target_scope: '单体', effectDetails: [cleanse] })), /选定友方（未选择时为自身）最多2个/);
  const machine = skillCombatDetails(source({ code: 'machine_echo', category: 'special', power: 0, target_scope: '自身', effectDetails: [buff] }));
  assert.equal(machine.summary, '为自身生效中的主动异械补充充能。');
  assert.equal(machine.combatEffects.length, 1);
  assert.match(machine.combatEffects[0].text, /每件已生效主动异械恢复最多25点充能/);
  assert.doesNotMatch(machine.combatEffects[0].text, /自动机|执行.*指令/);
  assert.match(text(source({ code: 'warrior_taunt_player', category: 'utility', power: 0 })), /其他队友当前仇恨的一半/);
});

test('普通打击和背刺不凭旧简介增添暴击、格挡或吸蓝；多目标书店用途识别实际目标数', () => {
  for (const code of ['heavy_strike', 'backstab']) {
    const actual = text(source({ code, category: 'physical', power: code === 'heavy_strike' ? 125 : 155 }));
    assert.match(actual, /威力的物理伤害/);
    assert.doesNotMatch(actual, /必定暴击|暴击.*50%|格挡|吸.*魔力|穿透/);
  }
  assert.equal(skillCombatDetails(source({ code: 'folio_p03', category: 'physical', power: 95, target_scope: '单体' })).summary, '攻击多个敌人。');
});

test('四种原生疗术与高级祷言机制组合后，每次施放只显示一条直接治疗', () => {
  for (const [code, coefficient] of [['healing_light', 100], ['healing_prayer', 135], ['saint_healer_mending_prayer', 90], ['saint_healer_absolution_hand', 60]] as const) {
    const actual = skillCombatDetails(source({ code, category: 'utility', power: 0, effectDetails: [] }));
    const directHeals = actual.combatEffects.filter(effect => effect.text.startsWith('恢复选定友方'));
    assert.equal(directHeals.length, 1, code);
    assert.match(directHeals[0].text, new RegExp(`${coefficient}%魔法攻击`));
    if (code.startsWith('saint_healer_')) assert.ok(actual.combatEffects.some(effect => effect.text.includes('祷言')));
    if (code === 'saint_healer_mending_prayer') assert.match(directHeals[0].text, /目标8%最大生命/);
  }
});

test('盾击易伤只能在眩晕成功后施加；普通净化保留有限数量', () => {
  assert.match(text(source({ code: 'guard_break', effectDetails: [{ code: 'exposed', name: '易伤', effect_type: 'stat_modifier', value: 10, duration: 2, target_scope: 'enemy', trigger_timing: 'on_hit' }] })), /眩晕成功后/);
  assert.match(text(source({ code: 'purifying_light', category: 'utility', power: 0, effectDetails: [{ code: 'purify', name: '净化', effect_type: 'cleanse', value: 0, duration: 0, target_scope: 'ally', trigger_timing: 'on_cast' }] })), /最多2个/);
});

test('生命护盾与剧毒层数、Boss上限按执行器区分', () => {
  const detail = source({ effectDetails: [{ code: 'poison', name: '剧毒', effect_type: 'damage_over_time', value: 5, duration: 3, target_scope: 'enemy', trigger_timing: 'on_hit', stackable: 1, max_stacks: 5 }] });
  assert.match(text(detail), /1层\[剧毒\]/);
  assert.match(text(detail), /每层每回合损失5%最大生命，最多5层/);
  assert.match(text(detail), /首领每层每回合最多损失1.5%最大生命，最多3层有效/);
});

test('书店多段威力跟随超限、普通效果遵守自身上限且属性值单位正确', () => {
  const skill = folioSkills.find(skill => skill.code === 'folio_p04')!;
  const actual = source({ code: skill.code, category: skill.category, power: skill.power, specializations: { overcharge: 4, potent: 20 } });
  const spec = skillSpecialization(actual as Required<Pick<SkillCombatSource, 'code' | 'category' | 'power' | 'mana_cost' | 'cooldown_turns'>>, actual.specializations);
  assert.match(text(actual), new RegExp(String(Number((skill.parts[0] * spec.powerFactor).toFixed(2))) + '%'));
  assert.match(text(actual), /命中修正系数提高20%/);
  assert.match(text(source({ code: 'folio_m23', category: 'magic', power: 100, specializations: { potent: 20 } })), /闪避值降低15点/);
});

test('通用被动与武器精通分别使用自己的专精公式，副手折算不重复', () => {
  const passive = source({ code: 'passive_damage', category: 'passive', power: 0, specializations: { potent: 10 }, passive_effect_json: { damageBonusPct: 10 } });
  assert.match(text(passive), /造成的伤害提高10\./);
  const mastery = source({ code: 'longsword_mastery', category: 'passive', power: 0, specializations: { overcharge: 3, instant: 4 }, passive_effect_json: { weaponType: '长剑', critRatePct: 5, masteryStepPct: 2 } });
  assert.match(text(mastery), /主手暴击属性提高9%；副手为7.2%/);
  assert.match(text(mastery), /属性词条按80%生效/);
});

test('旧说明与运行结果不同时优先展示真实运行规则', () => {
  assert.match(text(source({ code: 'resident_a02', category: 'utility', power: 0 })), /追加本次伤害50%/);
  assert.doesNotMatch(text(source({ code: 'resident_f01', category: 'utility', power: 0 })), /抵消|免伤/);
  assert.match(text(source({ code: 'resident_k05', category: 'utility', power: 0 })), /命中修正提高30%/);
  assert.match(text(source({ code: 'resident_i07', category: 'passive', power: 0 })), /魔力消耗降低20%/);
});

test('域民、书店与四隐藏职业所有已注册技能均有真实效果条目', () => {
  for (const skill of [...residentSkills, ...folioSkills]) {
    const output = skillCombatDetails(source({ code: skill.code, category: skill.category, power: skill.power, element: skill.element }));
    assert.ok(output.combatEffects.length > 0, skill.code);
    assert.doesNotMatch(output.combatEffects.map(effect => effect.text).join(' '), /NaN|Infinity|undefined|待服务器/);
  }
  for (const skill of hiddenSkills) assert.ok(skillCombatDetails(source({ code: skill.code, category: 'utility', power: skill.power })).combatEffects.length > 0, skill.code);
  for (const skill of advancedBoundSkillDefinitions) assert.ok(skillCombatDetails(source({ code: skill.code, category: 'bound', power: 0, passive_effect_json: skill.effect })).combatEffects.length > 0, skill.code);
  for (const code of Object.values(advancedProfessionActiveSkillCodes).flat().filter(code => !code.startsWith('hidden_'))) {
    const skill = newAdvancedSkillDefinitions.find(skill => skill.code === code); const native = nativeSkillBalanceByCode.get(code);
    const output = skillCombatDetails(source({ code, category: skill?.category ?? (Number(native?.power) > 0 ? 'physical' : 'utility'), power: skill?.power ?? native?.power ?? 0 }));
    assert.ok(output.combatEffects.length > 0, code);
  }
});

test('林巡召唤与新职业辅助的提前返回分支，不显示不可达的旧数据库命中效果', () => {
  const oldEffect = { code: 'poison', name: '旧技能中毒', effect_type: 'damage_over_time', value: 3, duration: 3, target_scope: 'enemy', trigger_timing: 'on_hit' };
  const summoned = text(source({ code: 'ranger_hunters_mark', category: 'physical', power: 105, effectDetails: [oldEffect] }));
  assert.match(summoned, /召唤林伴/);
  assert.doesNotMatch(summoned, /105%威力|旧技能中毒/);
  assert.doesNotMatch(text(source({ code: 'titan_anchor', category: 'utility', power: 0, effectDetails: [oldEffect] })), /旧技能中毒/);
});

test('天赋按真实战斗或生产环节展示；未开放成长路线不伪造效果', () => {
  for (const talent of talentDefinitions) {
    const output = skillCombatDetails(source({ code: talent.code, category: 'bound', power: 0 }));
    assert.ok(output.combatEffects.length > 0, talent.code);
    assert.doesNotMatch(JSON.stringify(output), /NaN|Infinity|待服务器|待配置/);
    if (!talent.implemented) assert.match(output.combatEffects[0].text, /尚未开放/);
  }
  const mana = talentDefinitions.find(talent => talent.number === 'A03')!;
  assert.equal(talentManaFactor({ opening: { divines: [mana.code], weapons: [], crimson: 0, pve: true } }), 2 / 3);
  assert.match(text(source({ code: mana.code, category: 'bound', power: 0 })), /2\/3/);
  const glass = talentDefinitions.find(talent => talent.number === 'H01')!;
  assert.equal(talentPanel(glass.number).hp, .6);
  assert.match(text(source({ code: glass.code, category: 'bound', power: 0 })), /最大生命为60%/);
  const insight = talentDefinitions.find(talent => talent.number === 'C07')!;
  assert.match(text(source({ code: insight.code, category: 'bound', power: 0 })), /前4次平均基础经验6倍中的较小值/);
});

test('高强效护盾、折光及首领控制时长与真正的战斗执行器一致', async () => {
  const unit = (key: string, side: string): RuleUnit => ({ key, side, name: key, level: 30, boss: false, hp: 10000, hpMax: 10000,
    mp: 10000, mpMax: 10000, attack: 1000, magic: 1000, defense: 100, magicDefense: 100, accuracy: 1000, evasion: 1,
    speed: 100, crit: 0, critResist: 100, critDamage: 100, critReduction: 0, pierce: 0, tenacity: 0,
    state: emptyRuleState(), cooldowns: {}, passives: [], resistance: {}, mastery: {} });
  const caster = unit('member:1', 'member'); const ally = unit('member:2', 'member'); const enemy = unit('target:1', 'target');
  const rules = new CombatRules([caster, ally, enemy], 1, [], { absorb: async () => 0, legacyEffects: () => [], removeLegacy: async () => {}, extraAction: () => {}, swapThreat: async () => {} }, '', undefined, () => 0);
  for (const code of ['resident_f03', 'resident_a06']) {
    const skill = residentSkillByCode(code)!;
    const detailSource = source({ code, category: skill.category, tier: skill.tier, power: skill.power, specializations: { potent: 40 } });
    caster.castSpecialization = skillSpecialization(detailSource as Required<Pick<SkillCombatSource, 'code' | 'category' | 'power' | 'mana_cost' | 'cooldown_turns'>>, detailSource.specializations);
    await rules.cast(caster, ally, skill, skill.mana);
    if (code === 'resident_f03') {
      assert.equal(rules.status(ally, 'shield')?.value, ally.hpMax);
      assert.match(text(detailSource), /100%最大生命护盾/);
    } else {
      const actual = rules.status(ally, 'refraction')!.value;
      assert.equal(actual, 50);
      assert.match(text(detailSource), /减伤50%/);
    }
  }
  enemy.boss = true;
  caster.pierce = 100;
  await rules.cast(caster, enemy, residentSkillByCode('resident_b05')!, 0);
  assert.equal(rules.status(enemy, 'silence')!.until - rules.turn + 1, 3);
  const silence = text(source({ code: 'resident_b05', category: 'physical', power: 90 }));
  assert.match(silence, /基础持续3回合/);
  assert.doesNotMatch(silence, /首领最多1回合/);
  await rules.cast(caster, enemy, residentSkillByCode('resident_b02')!, 0);
  assert.equal(rules.status(enemy, 'petrify')!.until - rules.turn + 1, 1);
  assert.match(text(source({ code: 'resident_b02', category: 'utility', power: 0 })), /首领石化最多1回合/);
});

test('援护回响当前结算未产生复制时，详情不谎报75%治疗或增益', async () => {
  const unit = (key: string, hp: number): RuleUnit => ({ key, side: 'member', name: key, level: 30, boss: false, hp, hpMax: 10000,
    mp: 10000, mpMax: 10000, attack: 1000, magic: 1000, defense: 100, magicDefense: 100, accuracy: 1000, evasion: 1,
    speed: 100, crit: 0, critResist: 100, critDamage: 100, critReduction: 0, pierce: 0, tenacity: 0,
    state: emptyRuleState(), cooldowns: {}, passives: [], resistance: {}, mastery: {} });
  const caster = unit('member:1', 1000); const ally = unit('member:2', 5000);
  const rules = new CombatRules([caster, ally], 1, [], { absorb: async () => 0, legacyEffects: () => [], removeLegacy: async () => {}, extraAction: () => {}, swapThreat: async () => {} }, '', undefined, () => 0);
  await rules.cast(caster, caster, residentSkillByCode('resident_m02')!, 0);
  await rules.cast(caster, ally, residentSkillByCode('resident_k02')!, 0);
  assert.equal(ally.hp, 6500);
  assert.equal(caster.hp, 1000);
  assert.equal(rules.status(caster, 'echo'), undefined);
  assert.match(text(source({ code: 'resident_m02', category: 'utility', power: 0 })), /未产生额外复制/);
  assert.doesNotMatch(text(source({ code: 'resident_m02', category: 'utility', power: 0 })), /75%/);
});
