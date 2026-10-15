import { armorPieceDescription } from './armor-class';
import { equipmentQualityMultiplier } from './constants';
import { forgePrimaryKeys } from './equipment-primary';

const own = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);

export const equipmentEffectObject = (value: unknown): Record<string, unknown> => {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
};

const artifactEffects: Record<string, string[]> = {
  holy_sword: ['普攻与斩击技能恒为物理伤害。', '普攻或斩击技能暴击时，给予目标1层[破甲剑痕]。', '$破甲剑痕$目标物理防御降低16%，持续3回合，可叠加。'],
  demon_sword: ['普攻与斩击技能恒为魔法伤害。', '普攻或斩击技能命中时，给予自身1层[魔剑激涌]。', '#魔剑激涌#自身伤害提高16%，持续3回合，可叠加。'],
  saint_staff: ['光属性技能威力提高33%。'],
  death_dagger: ['暴击时，本次攻击最终伤害提高50%。'],
  godfist: ['物攻与魔攻恒取较高的一项。'],
  oracle_grimoire: ['所有技能吟咏-1。'],
  prayer_orb: ['释放辅助类技能时，给予全部受益对象1层[祈祷圣音]。', '#祈祷圣音#每回合恢复3%生命与魔力，持续3回合，可叠加。'],
  immortal_shield: ['受到物理伤害降低40%。'],
  star_crown: ['魔法技能威力提高16%。'],
  sky_robe: ['受到魔法伤害降低40%。'],
  wind_girdle: ['移动速度+3，且无视负重带来的移速降低。'],
  time_greaves: ['濒死时保留1 HP，清除异常与减益，并在下次出手前无敌；每场战斗限一次。'],
  gale_boots: ['命中时有33%概率追击，再次造成相同的一次攻击。'],
  oath_necklace: ['每回合恢复3%最大生命。'],
  fate_bracelet: ['魔力不足时，会以 1:1 的生命补足魔力；生命不足以支付时，无法释放技能。'],
  eternal_ring: ['每回合恢复3%最大魔力。']
};

export const equipmentSections = (effectJson: unknown, quality: number, primaryJson: unknown, category: string, subtype: string | null, actualLabel = '实际') => {
  const effect = equipmentEffectObject(effectJson);
  const primaryKeys = (() => {
    try {
      const raw = typeof primaryJson === 'string' ? JSON.parse(primaryJson) : primaryJson;
      return Array.isArray(raw) ? new Set(raw.filter(key => typeof key === 'string')) : new Set<string>();
    } catch { return new Set<string>(); }
  })();
  if (!primaryKeys.size) for (const key of forgePrimaryKeys(category, subtype)) primaryKeys.add(key);
  const scale = equipmentQualityMultiplier(Number.isFinite(quality) ? quality : 100);
  const labels: Record<string, string> = {
    hpMax: '生命', mpMax: '魔力', physicalAttack: '物攻', magicAttack: '魔攻', physicalDefense: '物防', magicDefense: '魔防', accuracy: '命中', evasion: '闪避', speed: '速度', critRateBp: '暴击', critDamageBp: '暴伤', critResistBp: '暴免', critDamageReductionBp: '暴抗', physicalAttackPct: '物攻',
    magicAttackPct: '魔攻', physicalDefensePct: '物防', magicDefensePct: '魔防', critRatePct: '暴击', critDamagePct: '暴伤', accuracyPct: '命中', evasionPct: '闪避', speedPct: '速度', mpPct: '魔力', hpPct: '生命', tenacity: '韧性', tenacityPct: '韧性', tenacityPierce: '破韧', tenacityPiercePct: '破韧', constitution: '体质', spirit: '精神', strength: '力量', intelligence: '智力', agility: '敏捷', perception: '感知', critResistPct: '暴免', critDamageReductionPct: '暴抗', constitutionPct: '体质', spiritPct: '精神', strengthPct: '力量', intelligencePct: '智力', agilityPct: '敏捷', perceptionPct: '感知'
  };
  const attributeLabel = (key: string) => own(labels, key) ? labels[key]! : key.startsWith('elementMastery_') ? `${key.slice('elementMastery_'.length)}元素精通` : key.startsWith('elementResistance_') ? `${key.slice('elementResistance_'.length)}元素抗性` : '';
  const normalOrder = ['hpMax', 'mpMax', 'physicalAttack', 'magicAttack', 'physicalDefense', 'magicDefense', 'accuracy', 'evasion', 'speed', 'critRateBp', 'critDamageBp', 'critResistBp', 'critDamageReductionBp', 'tenacity', 'tenacityPierce', 'hpPct', 'mpPct', 'physicalAttackPct', 'magicAttackPct', 'physicalDefensePct', 'magicDefensePct', 'accuracyPct', 'evasionPct', 'speedPct', 'critRatePct', 'critDamagePct', 'tenacityPct', 'tenacityPiercePct'];
  const elementalOrder = ['金', '木', '水', '火', '土', '风', '雷', '冰', '光', '暗'];
  const attributes = Object.entries(effect)
    .filter(([key, value]) => attributeLabel(key) && Number(value))
    .map(([key, value]) => {
      const raw = key.endsWith('Pct') ? `${Number(value).toFixed(1)}%` : key.startsWith('element') ? Number(value).toFixed(1) : String(Math.round(Number(value)));
      const armorScale = 1;
      const actual = key.endsWith('Pct') ? `${(Number(value) * scale).toFixed(1)}%` : key.startsWith('element') ? (Number(value) * scale).toFixed(1) : String(Math.floor(Number(value) * scale * armorScale));
      const group = primaryKeys.has(key) ? 0 : key.startsWith('elementMastery_') || key.startsWith('elementResistance_') ? 2 : 1;
      const order = group === 2 ? elementalOrder.indexOf(key.split('_')[1] ?? '') * 2 + (key.startsWith('elementResistance_') ? 1 : 0) : normalOrder.indexOf(key);
      return { group, order: order < 0 ? Number.MAX_SAFE_INTEGER : order, text: `${attributeLabel(key)} 原始+${raw}｜${actualLabel}+${actual}${primaryKeys.has(key) ? '(主)' : '(副)'}` };
    })
    .sort((left, right) => left.group - right.group || left.order - right.order || left.text.localeCompare(right.text, 'zh-CN'))
    .map(attribute => attribute.text);
  const effectLabels: Record<string, string> = {
    chantReduction: '所有技能吟唱降低', hpRegenPct: '每回合生命恢复', mpRegenPct: '每回合魔力恢复', physicalDamageReductionPct: '受到物理伤害降低', magicDamageReductionPct: '受到魔法伤害降低', lightSkillBonusPct: '光属性技能威力提高', criticalDamageBonusPct: '暴击额外伤害提高', pursuitChancePct: '追击概率', hitCorrectionPct: '命中修正', evasionCorrectionPct: '闪避修正', critRateCorrectionPct: '暴击修正', critAvoidanceCorrectionPct: '暴免修正', critDamageCorrectionPct: '暴伤修正', rangedSkillDamagePct: '远程技能伤害提高', aoeSkillDamagePct: '范围技能伤害提高', actualCritRatePct: '实际暴击率', healingBonusPct: '治疗效果提高', ignoreDefensePct: '无视目标物理防御', lifestealPct: '造成伤害后恢复生命', magicDamagePct: '魔法伤害提高', manaCostReduction: '技能魔力消耗降低', damageBonusPct: '造成伤害提高', damageReductionPct: '受到伤害降低', minimumHitRatePct: '攻击命中率最低',
    actualHitRatePct: '实际命中率', physicalActualHitRatePct: '物理攻击实际命中率', physicalSkillDamagePct: '物理技能威力提高', magicSkillDamagePct: '魔法技能增伤', magicChantBonus: '魔法技能吟咏增加', physicalCriticalFinalDamagePct: '物理攻击暴击时最终伤害降低'
  };
  const effects = Object.entries(effect)
    .filter(([key, value]) => own(effectLabels, key) && Number(value))
    .map(([key, value]) => {
      const prefix = key === 'damageBonusPct' || key === 'damageReductionPct' ? '⭐️' : '';
      if (['actualHitRatePct', 'actualCritRatePct', 'physicalActualHitRatePct'].includes(key)) return `${effectLabels[key]} +${value} 个百分点`;
      return key === 'physicalCriticalFinalDamagePct'
        ? `${prefix}${effectLabels[key]} ${Math.abs(Number(value))}%`
        : `${prefix}${effectLabels[key]} ${key === 'manaCostReduction' || key === 'magicChantBonus' || key === 'chantReduction' ? value : `${value}%`}`;
    });
  const armorText = armorPieceDescription(subtype, String(effect.slot ?? category), quality);
  if (armorText) effects.unshift('甲类逐件乘算：' + armorText);
  if (effect.physicalForceCrit) effects.unshift('你的物理攻击必定暴击。');
  const artifact = String(effect.artifact ?? '');
  if (own(artifactEffects, artifact)) effects.unshift(...artifactEffects[artifact]!);
  return { attributes, effects };
};
