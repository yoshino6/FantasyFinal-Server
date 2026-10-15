import { equipmentEffectObject } from './equipment-detail-format';

// Inverse display of the stored keys parsed by config/monster-cards.ts; never look up a newer card definition.
const flatLabels: Record<string, string> = {
  hpMax: '生命上限', mpMax: '魔力上限', physicalAttack: '物理攻击', magicAttack: '魔法攻击',
  physicalDefense: '物理防御', magicDefense: '魔法防御', accuracy: '命中', evasion: '闪避', speed: '速度',
  critRateBp: '暴击', critDamageBp: '暴伤', critResistBp: '暴免', critDamageReductionBp: '暴抗', tenacity: '韧性', tenacityPierce: '破韧'
};
const numericText: Record<string, (value: number) => string> = {
  hitCorrectionPct: value => `命中修正 +${value}%`, evasionCorrectionPct: value => `闪避修正 +${value}%`,
  critAvoidanceCorrectionPct: value => `暴免修正 +${value}%`, critDamageCorrectionPct: value => `暴抗修正 +${value}%`,
  actualHitRatePct: value => `实际命中 +${value} 个百分点`, actualCritRatePct: value => `实际暴击 +${value} 个百分点`,
  cardDamageReductionPct: value => `承受伤害降低 ${value}%`, cardPhysicalDamageReductionPct: value => `承受物理伤害降低 ${value}%`,
  cardMagicDamageReductionPct: value => `承受魔法伤害降低 ${value}%`, activeHealingBonusPct: value => `主动治疗量 +${value}%`,
  hpIndependentPct: value => `生命上限提高 ${value}%`, mapMoveBonus: value => `地图单次移动上限 +${value}格`,
  mapBurdenPenaltyReductionPct: value => `负重导致的移动惩罚减少${value}%`, negotiationActualBonusPct: value => `合法怪物交涉成功率 +${value}个百分点`,
  mapPerceptionBonus: value => `普通感知半径 +${value}格`, neutralGiftAggressionReductionPct: value => `中性礼物引发的敌意概率降低${value}%`,
  mapRandomEncounterReductionPct: value => `普通随机野外遭遇概率降低${value}%`,
  moderateTerrainStaminaReductionPct: value => `中度以下地形额外移动体力消耗降低${value}%`, npcTalkRangeBonus: value => `与NPC普通交谈距离 +${value}格`
};
const booleanText: Record<string, string> = {
  revealMonsterMovementState: '显示范围内怪物的移动/静止状态',
  revealHighestElementResistance: '每个怪物实例首次鉴识额外揭示其最高元素抗性对应元素及数值',
  revealNegotiationMoodBand: '交涉页面揭示当前心情所属区间',
  ignoreFirstProbeFailureEscalation: '每场交涉首次试探不因“连续失败计数”额外提高敌意概率',
  revealPreferenceCategory: '每场首次非讨厌礼物揭示一个喜好类别',
  neutralGiftAggressionRetry: '每场首次中性礼物的敌意判定失败后，允许一次原概率重判，第二次仍失败才开战',
  revealNegotiationMoodDirection: '额外显示一次送礼后心情上升/下降方向',
  talkAggressionRetry: '每场首次因普通交谈触发开战时作一次原敌意概率重判，第二次仍触发才开战'
};
const own = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);

/** Exact snapshot values: enchantments are independent of equipment quality and retain decimal rolls. */
export const equipmentEnchantmentLines = (snapshot: unknown): string[] => {
  const effect = equipmentEffectObject(snapshot), consumed = new Set<string>(), lines: string[] = [];
  const add = (line: string, ...keys: string[]) => { lines.push(line); keys.forEach(key => consumed.add(key)); };
  if (typeof effect.attackElement === 'string' && (effect.attackElementAll === true || effect.attackElementOnlyIfNeutral === true)) {
    add(effect.attackElementAll === true ? `攻击赋予${effect.attackElement}属性` : `无元素普通攻击赋予${effect.attackElement}属性`,
      'attackElement', effect.attackElementAll === true ? 'attackElementAll' : 'attackElementOnlyIfNeutral');
  }
  if (typeof effect.trackingMaxTargets === 'number' && typeof effect.trackingMoveDuration === 'number') {
    const targets = effect.trackingMaxTargets, moves = effect.trackingMoveDuration;
    if (effect.trackingMaxTier === 'large') add(`标记${targets}只已感知的普通/大怪，记录其最后确认位置${moves}次本人移动`, 'trackingMaxTargets', 'trackingMaxTier', 'trackingMoveDuration');
    if (effect.trackingMaxTier === 'elite') add(`可标记${targets}只普通/大怪/精英，最后确认位置保留${moves}次本人移动`, 'trackingMaxTargets', 'trackingMaxTier', 'trackingMoveDuration');
    if (effect.trackingMaxTier === 'boss') add(`可标记${targets}只含BOSS的怪物，最后确认位置保留${moves}次本人移动`, 'trackingMaxTargets', 'trackingMaxTier', 'trackingMoveDuration');
  }
  if (typeof effect.moveChargeRequired === 'number' && typeof effect.moveChargeBonus === 'number') {
    add(`无战斗且本次移动不触发强制事件时，连续${effect.moveChargeRequired}次合法移动后下次移动上限临时 +${effect.moveChargeBonus}格，随后重置`, 'moveChargeRequired', 'moveChargeBonus');
  }
  for (const [key, value] of Object.entries(effect)) {
    if (consumed.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (own(flatLabels, key)) { add(`${flatLabels[key]} +${value}`, key); continue; }
      if (own(numericText, key)) { add(numericText[key]!(value), key); continue; }
      const elemental = /^(elementMastery|elementResistance|elementDamageReductionPct|elementDamageBonusPct)_([金木水火土风雷冰光暗])$/u.exec(key);
      if (elemental) {
        const element = elemental[2];
        add(elemental[1] === 'elementMastery' ? `${element}元素精通 +${value}` : elemental[1] === 'elementResistance' ? `${element}元素抗性 +${value}`
          : elemental[1] === 'elementDamageReductionPct' ? `承受${element}元素伤害降低 ${value}%` : `${element}元素伤害提高 ${value}%`, key);
        continue;
      }
    }
    if (value === true && own(booleanText, key)) { add(booleanText[key]!, key); continue; }
    // Preserve future/legacy stored keys without guessing a current-definition effect.
    lines.push(`快照词条 ${key}：${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  }
  return lines;
};
