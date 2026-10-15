import {
  skillSpecialization, specializationMaximum, specializationUpgradeCost,
  type Specialization, type SpecializationBase, type SkillSpecializations, type SkillSpecializationResult
} from '../game/skill-specialization';
import { passiveSpecializationFactor } from '../game/passive-specialization';
import { offhandAttributeMultiplier } from '../game/weapon-mastery.service';

export type SkillSpecializationDetail = {
  key: string; name: string; level: number; maxLevel: number;
  currentEffect: string; nextEffect: string | null; cost: number | null;
  action: 'specialization' | 'appraisal'; specialization?: Specialization; direction?: 'range' | 'information';
};

type DetailSource = SpecializationBase & {
  learned: boolean; characterLevel?: number; specializations: SkillSpecializations;
  specializationChoices: Specialization[]; specializationMaxLevel: number;
  specializationUpgradeCosts: Partial<Record<Specialization, number | null>>;
  specializationUpgradeCost?: number | null; weaponMastery: boolean; passiveSpecializable: boolean;
  masteryProficiencyCost: number | null; masteryFocusCost: number | null;
  passive_effect_json?: unknown; appraisal?: { rangeLevel: number; informationLevel: number } | null;
};

const numberText = (value: number) => String(Number(value.toFixed(4)));
const names: Record<Specialization, string> = { overcharge: '过充', potent: '强效', instant: '瞬息', efficient: '节能' };
const masteryLabels: Record<string, string> = {
  physicalAttackPct: '物攻', magicAttackPct: '魔攻', physicalDefensePct: '物防', magicDefensePct: '魔防',
  accuracyPct: '命中', critRatePct: '暴击', critDamagePct: '暴伤', critResistPct: '暴免',
  critDamageReductionPct: '暴抗', mpPct: '魔力上限', chantSpeedPct: '吟唱速度'
};
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') { try { return record(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
};
const currentLevel = (value: unknown, maximum: number) => Math.min(maximum, Math.max(1, Math.floor(Number(value) || 1)));
const row = (input: Omit<SkillSpecializationDetail, 'nextEffect' | 'cost'>, nextEffect: string, cost: number): SkillSpecializationDetail => ({
  ...input, nextEffect: input.level < input.maxLevel ? nextEffect : null, cost: input.level < input.maxLevel ? cost : null
});

const activeEffect = (source: DetailSource, key: Specialization, value: SkillSpecializationResult) => {
  const mana = source.code === 'resident_d01'
    ? '蓝耗 500 MP＋施法前当前 MP 的8%'
    : `蓝耗 ${value.mana} MP`;
  if (key === 'overcharge') return `威力 ${Math.floor(value.power)}；${mana}。`;
  if (key === 'potent') return `普通效果×${numberText(value.effectFactor)}；可成长时长×${numberText(value.durationChange + 1)}；控制概率系数×${numberText(value.controlChanceFactor)}；${mana}（受各效果适用范围与上限限制）。`;
  if (key === 'instant') return `冷却 ${value.cooldown} 回合；吟唱 ${value.chant} 回合；时间基数×${numberText(value.timeFactor)}；${mana}。`;
  return `${mana}。`;
};

/** 只读展示；下级仅增加所选方向，保留其他方向的实际组合与取整规则。 */
export const skillSpecializationDetails = (source: DetailSource): SkillSpecializationDetail[] => {
  if (!source.learned) return [];
  const levels = source.specializations;
  if (source.code === 'appraisal') {
    const range = currentLevel(source.appraisal?.rangeLevel, 10);
    const information = currentLevel(source.appraisal?.informationLevel, 4);
    const rangeEffect = (level: number) => `可鉴识高于自身 ${level * 3} 级以内的目标。`;
    const informationEffect = (level: number) => [
      '名称、生命、魔力、技能', '词条、详细属性', '当前状态、目标仇恨、域民资料', '弱点、抗性、完整怪物图鉴'
    ].slice(0, level).join('；') + '。';
    return [
      row({ key: 'range', name: '慧眼', level: range, maxLevel: 10, currentEffect: rangeEffect(range), action: 'appraisal', direction: 'range' }, rangeEffect(range + 1), range),
      row({ key: 'information', name: '识珠', level: information, maxLevel: 4, currentEffect: informationEffect(information), action: 'appraisal', direction: 'information' }, informationEffect(information + 1), information + 1)
    ];
  }
  if (source.weaponMastery) {
    const effect = record(source.passive_effect_json);
    const proficiency = currentLevel(levels.overcharge, 5); const focus = currentLevel(levels.instant, 6);
    const proficiencyEffect = (level: number) => {
      const values = Object.keys(masteryLabels).filter(key => Number(effect[key] ?? 0) !== 0).map(key => {
        const value = Number(effect[key]) + Number(effect.masteryStepPct ?? 0) * (level - 1);
        return `${masteryLabels[key]}${value >= 0 ? '+' : ''}${numberText(value)}%`;
      });
      return `每把${String(effect.weaponType ?? '对应武器')}：${values.join('、') || '无声明的数值加成'}；副手按随心比例发挥。`;
    };
    const focusEffect = (level: number) => `对应副手精通与主、副词条发挥 ${numberText(offhandAttributeMultiplier(level) * 100)}%；装备特殊效果保持完整。`;
    return [
      row({ key: 'overcharge', name: '娴熟', level: proficiency, maxLevel: 5, currentEffect: proficiencyEffect(proficiency), action: 'specialization', specialization: 'overcharge' }, proficiencyEffect(proficiency + 1), source.masteryProficiencyCost ?? proficiency * 2),
      row({ key: 'instant', name: '随心', level: focus, maxLevel: 6, currentEffect: focusEffect(focus), action: 'specialization', specialization: 'instant' }, focusEffect(focus + 1), source.masteryFocusCost ?? focus * 2)
    ];
  }
  const maximum = Number(source.specializationMaxLevel) || specializationMaximum(source.tier);
  if (source.passiveSpecializable) {
    const level = currentLevel(levels.potent, maximum);
    const effect = (value: number) => `可成长数值 +${numberText((passiveSpecializationFactor(value, source.tier) - 1) * 100)}%；次数、时长与机制保持不变。`;
    return [row({ key: 'potent', name: '强效', level, maxLevel: maximum, currentEffect: effect(level), action: 'specialization', specialization: 'potent' }, effect(level + 1), source.specializationUpgradeCost ?? 1)];
  }
  if (['passive', 'bound'].includes(source.category)) return [];
  const current = skillSpecialization(source, levels);
  return source.specializationChoices.map(key => {
    const level = currentLevel(levels[key], maximum);
    const next = skillSpecialization(source, { ...levels, [key]: level + 1 });
    return row({ key, name: names[key], level, maxLevel: maximum, currentEffect: activeEffect(source, key, current), action: 'specialization', specialization: key }, activeEffect(source, key, next), source.specializationUpgradeCosts[key] ?? specializationUpgradeCost(level));
  });
};
