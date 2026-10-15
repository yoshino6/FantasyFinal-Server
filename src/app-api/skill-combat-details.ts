import { folioSkillByCode } from '../game/active-folio-skills.config';
import { folioBuffs, folioDebuffs } from '../game/folio-effect.config';
import { residentSkillByCode } from '../game/resident-skill.config';
import { passiveSpecializationFactor, residentScalablePassives, specializedPassiveValue } from '../game/passive-specialization';
import { skillSpecialization, specializeControlChance, specializeEffectDuration, specializeEffectValue, type SkillSpecializations } from '../game/skill-specialization';
import { nativeCleanseLimit } from '../game/combat-dispel-policy';
import { hiddenSkill, hiddenWeaponAttackPower } from '../game/hidden-profession.config';
import { offhandAttributeMultiplier } from '../game/weapon-mastery.service';
import { advancedBoundSkillDefinitions, inheritancePassiveFor } from '../game/advanced-profession.config';
import { skillAdvancedCombatDetails, advancedSkillSkipsDatabaseEffects } from './skill-advanced-combat-details';
import { talentByCode } from '../game/talent.config';

export type CombatEffectDetail = { text: string; descriptions?: Array<{ name: string; text: string }> };
export type SkillCombatSource = {
  code: string; name?: string; category: string; tier?: string; power?: number; actualPower?: number;
  mana_cost?: number; cooldown_turns?: number; chant_turns?: number; element?: string; damage_type?: string;
  target_scope?: string; level?: number; passive_effect_json?: unknown; passiveFactor?: number;
  specializations?: SkillSpecializations; specializationResult?: ReturnType<typeof skillSpecialization>;
  effectDetails?: Array<{ code: string; name: string; effect_type: string; value: number; duration: number;
    target_scope: string; trigger_timing: string; stackable?: number | boolean; max_stacks?: number }>;
  appraisal?: { rangeLevel: number; informationLevel: number };
  craftsmanship?: { kind: string; percent: number; level: number };
};
const number = (value: number) => String(Number(value.toFixed(2)));
const record = (value: unknown): Record<string, unknown> => {
  try { const parsed = typeof value === 'string' ? JSON.parse(value) : value; return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}; } catch { return {}; }
};
const row = (text: string): CombatEffectDetail => ({ text });
const state = (text: string, name: string, description: string): CombatEffectDetail => ({ text, descriptions: [{ name, text: description }] });
const allTargets = (scope: string | undefined) => ['全体', 'all_enemies', 'all_allies', 'enemies', 'allies'].includes(String(scope));

/** Values arriving from skillDetail already include the selected specialization. */
const databaseEffects = (source: SkillCombatSource): CombatEffectDetail[] => (source.effectDetails ?? []).map(effect => {
  const value = number(Number(effect.value)); const turns = Number(effect.duration);
  const selectableSelf = ['purifying_light', 'frost_barrier'].includes(source.code) && effect.target_scope === 'self';
  const target = selectableSelf ? '选定友方（未选择时为自身）' : effect.target_scope === 'self' ? '自身'
    : effect.target_scope === 'ally' ? allTargets(source.target_scope) ? '全体存活友方' : '友方目标'
      : allTargets(source.target_scope) ? '全体敌方目标' : '目标';
  const timing = effect.trigger_timing === 'on_hit' ? '命中时' : '施放后';
  const stacked = Boolean(effect.stackable) || effect.code === 'poison';
  const application = `${timing}对${target}施加${stacked ? '1层' : ''}[${effect.name}]${turns > 0 ? `，持续${turns}回合` : ''}`;
  const percent: Record<string, string> = {
    vulnerability: `物理防御降低${value}%`, armor_shatter: `物理防御降低${value}%`, sword_break: `物理防御降低${value}%`,
    magic_shatter: `魔法防御降低${value}%`, exposed: `受到的直击伤害提高${value}%`, slow: `速度降低${value}%`,
    bind: `速度、闪避属性降低${value}%`, evasion_down: `闪避属性降低${value}%`, imbalance: `命中、闪避属性降低${value}%`,
    sprint: `速度提高${value}%`, precision: `命中属性提高${value}%`, critical_focus: `暴击属性提高${value}%`,
    battle_cry: `物理、魔法攻击提高${value}%`, barrier: `受到的伤害降低${value}%`,
    regeneration: `每回合恢复${value}%最大生命`, mana_regeneration: `每回合恢复${value}%最大魔力`,
    shield_guard: `自身下次行动前受到的伤害降低${value}%`, demon_surge: `伤害提高${value}%`,
    attack: `物理攻击提高${value}%`, magic: `魔法攻击提高${value}%`, defense: `物理防御提高${value}%`,
    magic_defense: `魔法防御提高${value}%`, accuracy: `命中属性提高${value}%`, speed: `速度提高${value}%`,
    attack_down: `物理攻击降低${value}%`, magic_down: `魔法攻击降低${value}%`, accuracy_down: `命中属性降低${value}%`,
    advanced_healing_cut: `受到的治疗降低${value}%`, advanced_corrosion: `物理、魔法防御各降低${value}%`, alchemy_evasion: `闪避属性提高${value}%`,
    advanced_mapping: `全队对该目标的命中属性提高${value}%，暴击属性额外提高8%`, advanced_hunt: `施加者下一次对该目标的直击伤害提高${value}%`,
    advanced_formation: `下一次队友技能直击伤害提高${value}%`, advanced_light_mark: `下一次元素使冰、火、风、雷技能伤害提高${value}%`,
    inheritance_control_resist: `控制抗性修正提高${value}%`, alchemy_antiheal: `受到的治疗降低${value}%`
  };
  if (effect.effect_type === 'cleanse') { const limit = nativeCleanseLimit(source.code); return row(`${timing}净化${target}${Number.isFinite(limit) ? `最多${limit}个` : '全部'}可普通净化的负面状态`); }
  if (effect.code === 'shield_counter_cooldown') return row('每个全局回合最多一次：格挡成功时，自身盾反冷却缩短1回合');
  if (effect.code === 'shield_counter') return state(`${timing}进入[盾反]，持续到自身下次行动前`, '盾反', `受到直伤降低${number(Math.min(60, Number(effect.value)))}%；近战反射原始伤害50%，反射不触发专精或连锁`);
  if (effect.code === 'mist_veil') return state(application, effect.name, `下一次攻击伤害提高${value}%，出手后消耗`);
  if (effect.code === 'shadow_pierce') return state(application, effect.name, `下一次攻击暴击值提高${number(Number(effect.value) * 25)}，仍需经过目标抗暴与暴击判定，出手后消耗`);
  if (effect.code === 'life_shield') return state(application, effect.name, `吸收相当于${value}%目标最大生命的伤害；总生命护盾不超过目标最大生命`);
  if (effect.code === 'prayer_hymn') return state(application, effect.name, `每层每回合分别恢复${value}%最大生命和最大魔力${effect.max_stacks ? `，最多${effect.max_stacks}层` : ''}`);
  if (effect.code === 'advanced_taunt') return state(application, effect.name, '优先攻击该状态的施加者');
  if (effect.code === 'advanced_guard') return state(application, effect.name, `下一次单体直击的${value}%伤害转移给守护者，转移后消耗`);
  if (effect.code === 'advanced_counter_ready') return state(application, effect.name, `下次行动前对主目标发动一次${value}%威力反击`);
  if (effect.code.startsWith('element_mark_')) return state(application, effect.name, '参与元素共鸣；被天穹序列消耗时触发对应元素的灼烧、减速、失衡或魔防降低');
  if (effect.code === 'advanced_prayer') return state(application, effect.name, '记录可供圣愈者急救转化的祷言层数');
  if (effect.effect_type === 'damage_over_time') {
    const base = effect.code === 'lost_health_poison' ? '已损失生命' : '最大生命';
    const cap = effect.code === 'poison' ? '；首领每层每回合最多损失1.5%最大生命，最多3层有效' : '；首领同种持续伤害每回合合计最多损失1.5%最大生命';
    return state(application, effect.name, `${stacked ? '每层' : ''}每回合损失${value}%${base}${stacked && effect.max_stacks ? `，最多${effect.max_stacks}层` : ''}${cap}；强度和持续时间按破韧与韧性对抗结算`);
  }
  if (effect.effect_type === 'control') {
    const explanation: Record<string, string> = { stun: '无法行动', ice_bind: '冰缚期间无法行动', sleep: '无法行动，受到直击后苏醒', fear: '受到恐惧控制', silence: '不能施放主动技能', blind: '命中受到抑制', petrify: '不能行动；普通净化不能解除', charm: '攻击原阵营队友；普通净化不能解除', confusion: '行动目标可能转向友方' };
    return state(`${timing}以${value}%基础概率对${target}施加[${effect.name}]，基础持续${turns}回合`, effect.name, `${explanation[effect.code] ?? '限制目标行动'}；成功率及持续时间受破韧、韧性与控制抗性影响，首领控制持续最多1回合`);
  }
  if (percent[effect.code]) return state(source.code === 'guard_break' && effect.code === 'exposed' ? `眩晕成功后，对目标施加[${effect.name}]，持续${turns}回合` : application, effect.name, percent[effect.code] + (effect.target_scope === 'enemy' ? '；强度和持续时间按破韧与韧性对抗结算' : ''));
  return state(application, effect.name, effect.effect_type === 'heal_over_time' ? `每回合恢复${value}%最大生命` : `效果强度${value}${turns ? `，基础持续${turns}回合` : ''}`);
});

const folioEffects = (source: SkillCombatSource, factor: number, powerFactor: number): CombatEffectDetail[] | undefined => {
  const skill = folioSkillByCode(source.code); if (!skill) return undefined;
  const id = source.code.slice(6); const result: CombatEffectDetail[] = [];
  const amount = (base: number, cap: number) => number(Math.min(cap, base * factor));
  const duration = (base: number, cap = 4) => Math.min(cap, Math.max(1, Math.floor(base * factor + 1e-9)));
  const targets = skill.targetCount === 0 ? '全体目标' : skill.targetCount === 1 ? '选定目标' : `${skill.targetCount}个不同目标（不足时不重复攻击）`;
  if (skill.parts.length) result.push(row(`对${targets}造成${skill.parts.length > 1 ? `${skill.parts.length}段` : ''}${skill.parts.map(part => `${number(part * powerFactor)}%`).join(' / ')}威力的${skill.element !== '无' ? skill.element + '属性' : ''}${skill.category === 'magic' ? '魔法' : '物理'}伤害${skill.parts.length > 1 ? '，各段独立结算命中和防御' : ''}`));
  if (id === 'p02') result.push(row('目标已有普通减防时，本次攻击威力额外提高10%'));
  if (id === 'p07') result.push(row('本次攻击忽略目标10%物理防御'));
  if (id === 'p23') result.push(row('本次攻击对生命护盾的伤害提高30%'));
  if (['p04', 'p10', 'm04'].includes(id)) result.push(row(id === 'p04' ? `本次对首目标的命中修正系数提高${amount(10, 20)}%` : `本次攻击命中值提高${amount(10, 20)}点`));
  if (id === 'm09') result.push(row('首段命中首目标后，驱散其1个可普通驱散的增益'));
  const labels: Record<string, string> = { attack: '物理攻击', magic: '魔法攻击', defense: '物理防御', magic_defense: '魔法防御', speed: '速度', evasion: '闪避值', accuracy: '下一次攻击命中值', hit: '命中修正系数', slow: '速度', attack_down: '物理攻击', magic_down: '魔法攻击', hit_down: '命中抑制系数', healing_down: '造成的治疗', evasion_down: '闪避值', exposed_hit: '受击命中修正系数', regen: '每回合恢复最大生命' };
  for (const [code, base, cap] of folioBuffs[id] ?? []) result.push(row(`为${targets}提供${duration(3)}回合增益：${labels[code]}${code === 'regen' ? '' : '提高'}${amount(base, cap)}${['accuracy', 'evasion'].includes(code) ? '点' : '%'}`));
  const debuff = folioDebuffs[id];
  if (debuff) { const [code, base, cap, turns] = debuff; result.push(row(`首段命中${['p20', 'm14', 'm23'].includes(id) ? '首' : ''}目标后，${labels[code]}${code === 'exposed_hit' ? '提高' : '降低'}${amount(base, cap)}${code === 'evasion_down' ? '点' : '%'}，持续${duration(turns)}回合；实际施加按目标韧性结算`)); }
  if (/^s0[1-6]$/.test(id)) result.push(row(`净化${targets}最多${['s05', 's06'].includes(id) ? 2 : 1}个${id === 's06' ? '可普通净化的持续伤害' : '可普通净化的负面'}状态`));
  const heal = ({ s02: [60, 120], s04: [40, 80], s06: [50, 80] } as Record<string, number[]>)[id];
  if (heal) result.push(row(`恢复${targets}相当于施法者${amount(heal[0], heal[1])}%魔法攻击的生命，实际恢复受治疗修正影响`));
  if (['s05', 's17'].includes(id)) result.push(state(`为${targets}施加[生命护盾]，持续${duration(3)}回合`, '生命护盾', `吸收${amount(id === 's05' ? 12 : 8, id === 's05' ? 20 : 12)}%目标最大生命的伤害；同组护盾取较高值`));
  if (id === 'm03') result.push(state(`首段命中后施加[绯焰灼烧]，持续${duration(2, 3)}回合`, '绯焰灼烧', `每回合损失普通目标${amount(2, 4)}% / 首领${amount(.5, 1)}%最大生命，每次最多施法者40%魔法攻击；实际施加按韧性结算`));
  return result;
};

/** Mirrors CombatRules.cast and its passive hooks; mechanism counts never receive potency growth. */
const residentEffects = (source: SkillCombatSource, factor: number, durationChange: number, powerFactor: number): CombatEffectDetail[] | undefined => {
  const skill = residentSkillByCode(source.code); if (!skill || source.code.startsWith('folio_')) return undefined;
  const result: CombatEffectDetail[] = [];
  const value = (code: string, base: number) => number(specializeEffectValue(code, base, factor));
  const turns = (code: string, base: number) => specializeEffectDuration(code, base, durationChange);
  const buff = (code: string, base: number, duration: number, target = '自身', label = code) => `${target}${label}${value(code, base)}%，持续${turns(code, duration)}回合`;
  const control = (name: string, chance: number, duration: number) => `以${number(specializeControlChance(chance, factor))}%基础概率对目标施加[${name}]，基础持续${duration}回合；实际概率受破韧、韧性和控制抗性影响${name === '石化' ? '，首领石化最多1回合' : ''}`;
  const effectMap: Record<string, string[]> = {
    A01: ['下一次单体攻击技能扩散至敌方全体；次目标伤害与普通效果为50%，控制概率减半，持续3回合'],
    A02: ['为友方施加三相附锋3回合：每回合首次主动作命中后，追加本次伤害50%的风、雷、火之一属性伤害'],
    A03: [`目标带减速、目盲或恐惧时，本次基础威力由105%变为130%（当前为${number(130 * powerFactor)}%）`],
    A04: ['命中后施加导电2回合：下一次受到风或雷属性直击伤害提高20%，触发后消耗'],
    A05: ['命中后消耗目标1层普通灼烧或中毒，追加3%目标最大生命的火伤（首领1.5%），且不超过施法者150%魔法攻击'],
    A06: [`为友方提供折光${turns('refraction', 2)}回合：下次受到非无属性、非奥术的直击时，减伤${value('refraction', 35)}%，反击原始伤害的${number(20 * Number(value('refraction', 35)) / 35)}%，反击属性取攻击者最低抗性`],
    B01: [control('混乱 / 沉睡 / 目盲（随机一种）', 65, 3), '对首领的混乱、沉睡最多1回合，目盲基础持续3回合'], B02: [control('石化', 65, 3), '普通石化不可普通净化；被直击打破时追加最多目标4%最大生命伤害（首领1%），且不超过攻击者较高攻击150%', `打破普通石化时，施法者恢复最多${number((residentSkillByCode('B02')?.mana ?? 294) * .3)}魔力，且不超过自身15%最大魔力`],
    B03: [control('魅惑', 60, 2), '首领免疫魅惑；魅惑失败时，改为以100%基础概率施加目盲2回合'], B04: ['命中后，' + control('恐惧', 55, 1), '恐惧使目标跳过下次行动；恐惧期间受到火属性直击伤害提高12%', '对首领改为速度降低20%，持续1回合'], B05: ['命中后，' + control('沉默', 70, 3)],
    B06: ['命中后，' + control('目盲', 100, 3), buff('slow', 20, 2, '目标已目盲时改为速度降低', '')],
    C01: ['友方本轮普通行动后获得一次额外行动，同一目标3回合内不能再次获得；额外行动不能再次触发额外行动链'],
    C02: [buff('speed', 35, 1, '自身', '速度提高'), '随机使自身一个冷却中的技能冷却缩短1回合'],
    C03: [buff('slow', 18, 2, '敌方全体', '速度降低'), '施放前每有一名敌人已减速，恢复自身4%最大魔力，最多12%'],
    C04: ['重置剩余冷却最长的一项技能；该技能下次施放消耗提高40%、冷却增加2回合；不能重置时隙赠礼、预支星刻、星环回拨'],
    C05: ['同回合已有其他队友命中过目标时：' + buff('speed', 15, 1, '自身', '速度提高'), '满足前述条件并命中后：' + buff('slow', 10, 1, '目标', '速度降低')],
    C06: ['与友方交换选定目标及仇恨位置', buff('reduction', 10, 1, '双方', '受到的伤害降低')],
    D01: ['支付500＋施放前当前魔力8%（向下取整），为另一名友方恢复同等魔力；不能转赠自身'],
    D02: ['主动技能伤害提高25%，魔力消耗提高50%，两项同类修正分别加算'],
    D03: [`自身魔力低于30%时，基础威力由100%变为135%（当前为${number(135 * powerFactor)}%），命中修正系数降低10%`],
    D04: ['额外消耗自身当前魔力20%', '2回合内友方目标下一次施法魔力消耗降低35%，支付后消耗该折扣', buff('next_damage', 12, 2, '友方目标下次技能', '伤害提高')],
    D05: ['消耗自身10%最大生命，恢复25%最大魔力；生命不足时不生效，本轮不能获得额外行动'],
    D06: ['驱散目标一个魔力回复、节流、蓄势或附魔增益，成功后其3回合内下一次施法魔力消耗提高30%，支付后消耗该负担'],
    E01: [`清除目标可普通净化的负面状态；每清除1层，基础威力增加30%，最多4层（当前威力${number(90 * powerFactor)}%～${number(210 * powerFactor)}%）`],
    E02: ['驱散目标全部可普通驱散的增益', '自身随机获得5种不同减益1回合：目盲、减速、易伤、物防降低、魔防降低、命中降低、物攻降低、魔攻降低之一；非目盲基础强度10%'],
    E03: ['移除自身1个可普通净化的减益并转移给目标，保留强度，最多3回合；硬控仍须重新判定成功率'],
    E04: ['命中后驱散目标1个增益；成功时，' + buff('reduction', 10, 1, '自身', '受到的伤害降低')],
    E05: [`清除友方可普通净化的中毒、灼烧与流血，每清除1层恢复其${number(3 * factor)}%最大生命，最多${number(12 * factor)}%（受治疗修正影响）`],
    E06: ['命中后随机将目标一种普通中毒、灼烧、流血或减防效果增加1层，最多3层，剩余时间最多3回合'],
    F01: ['友方获得法镜3回合：下次受到魔法直击时，反射原始伤害75%；反射后消耗'],
    F02: [buff('physical_reduction', 24, 3, '友方目标', '受到的物理伤害降低'), '受护者受到物理直击时，使攻击者速度降低20%1回合'],
    F03: [`为友方提供${number(Math.min(100, 14 * factor))}%最大生命护盾，持续${turns('shield', 3)}回合`, '生命护盾被打破时，对敌方全体造成49%受护者魔法攻击威力的火属性追加伤害'],
    F04: ['2回合内代承友方目标下一次单体直击伤害的30%，生效后消耗', buff('reduction', 15, 2, '自身', '受到的伤害降低')],
    F05: ['为友方提供相位假身3回合：下次直击减伤60%；若原始伤害的60%超过受护者10%最大生命，额外恢复其10%最大魔力'],
    F06: ['命中后消耗自身生命护盾的20%，对目标追加等额反冲伤害'],
    G01: ['物理、魔法攻击均使用自身两项攻击中较高者'], G02: ['2回合内下一次物理技能改用较高攻击、下一次魔法技能改用较低攻击，两项分别触发并消耗'],
    G03: ['命中后追加自身较低攻击25%的伤害'], G04: ['命中后获得咒刃引线3回合：下一次近战物理技能命中修正提高20%，威力降低10%，触发后消耗'],
    G05: [buff('speed', 25, 3, '轻势', '速度提高') + `，物理与魔法防御各降低${value('armor_shatter', 12)}%`, buff('defense', 18, 3, '重势', '物理、魔法防御提高') + `，速度降低${value('slow', 20)}%`, '两种姿态交替切换，旧姿态立即移除'],
    G06: ['攻击前削去目标当前生命护盾的30%，随后正常攻击'], H01: ['自身获得协同号令3回合：自身主技能命中后，最多两名其他队友分别进行一次40%物攻威力追击，每名队友每回合一次'],
    H02: ['目标获得双锋夹角2回合：同回合已有其他队友命中过目标时，后续攻击伤害提高15%、命中修正提高10%，每回合最多2次'],
    H03: ['2回合内由生命比例最高的另一名友方，替选定友方分担下一次单体直击伤害的25%，生效后消耗'],
    H04: ['清除友方可普通净化的减速与目盲', buff('speed', 18, 2, '友方目标', '速度提高')],
    H05: [buff('beat', 20, 3, '全队下一次直接治疗或生命护盾', '强度提高')],
    H06: ['嘲讽敌方全体2回合', buff('reduction', 20, 2, '自身', '受到的伤害降低')],
    I02: [`消耗自身当前生命10%（至少保留1生命）；自身生命低于35%时基础威力由135%变为160%（当前为${number(160 * powerFactor)}%）`],
    I03: ['自身生命低于40%时，净化自身1个普通减益并恢复12%最大魔力；否则恢复6%最大魔力'],
    I04: [`消耗自身当前生命15%，为另一名友方恢复相当于施法者${number(18 * factor)}%最大生命的生命（受治疗修正影响）`],
    I05: [`目标生命低于30%时，基础威力由100%变为145%（当前为${number(145 * powerFactor)}%）`], I06: ['获得绝境佯死2回合：受到一次致命伤害时保留1生命并进入目盲1回合；每场战斗最多施放一次'],
    J01: [buff('accuracy', 15, 2, '自身', '命中属性提高'), buff('blind_resist', 30, 2, '自身', '目盲抗性提高'), '雾、雨、湿天气下改为全队生效'],
    J02: [`高温、灰雨、火或炎天气下基础威力125%；其他天气90%（当前${number(125 * powerFactor)}% / ${number(90 * powerFactor)}%）`, '非适宜天气时，自身火抗降低10%，持续1回合'],
    J03: [buff('slow', 15, 1, '敌方目标', '速度降低'), '风、山、崖环境下改为敌方全体生效'],
    J04: ['雷天气下造成110%基础威力雷伤，命中后嘲讽1回合；其他天气仅施加导电20%持续2回合'],
    J05: [buff('reduction', 12, 2, '友方目标', '受到的伤害降低'), '净化受护者1个减速；水、湿、河、潮环境下全队生效'],
    J06: ['对目标施加目盲1回合；目标已目盲时改为驱散1个普通增益；雪、冰、极光环境下对全体敌人生效'],
    K01: ['友方获得临锻回火3回合：下一次物理技能伤害提高20%，生效后消耗'],
    K02: [`恢复友方${number(15 * factor)}%最大生命及最多8%最大魔力（回魔不超过本次已支付魔力的60%）`, '净化受治者1个普通中毒或灼烧'],
    K03: ['命中后驱散目标1个生命护盾、壁垒或元素附魔'], K04: ['显示目标一个增益及剩余冷却最长的技能，并标记该增益2回合；梦魇会遮蔽情报'],
    K05: ['获得猎人量距3回合：下一次远程技能命中修正提高30%，若目标生命全满，威力额外提高18%；生效后消耗'],
    K06: ['净化友方一个普通沉睡、恐惧或混乱；成功后其速度提高' + value('speed', 20) + `%，持续${turns('speed', 2)}回合，并封锁本轮额外行动`],
    L01: ['开战时持续遮蔽自身战斗日志；对应梦魇机制被解除后，遮蔽结束'], L02: ['获得灯下假影3回合：抵消下一次单体伤害45%，生效后消耗'],
    L03: [`自身仍在梦魇中或目标识珠低于3级时，基础威力120%，否则85%（当前${number(120 * powerFactor)}% / ${number(85 * powerFactor)}%）`],
    L04: ['打断目标当前吟唱，目标返还一半已支付魔力', control('沉默', 60, 2)],
    L05: [buff('accuracy_down', 10, 2, '目标', '命中属性降低'), '将目标的一个增益显示为其他增益名称，持续2回合；仅误导显示，实际效果不变'],
    L06: ['命中后施加影缝标记2回合：目标带目盲、沉默或梦魇时，施法者对其攻击命中修正提高20%'],
    M01: ['重置自身一个剩余冷却至少3回合的最长技能；排除时隙赠礼、预支星刻和自身', buff('slow', 30, 1, '自身', '速度降低'), buff('exposed', 15, 1, '自身', '受到的直伤提高')],
    M02: ['全队获得援护回响3回合；当前版本触发时未产生额外复制治疗或增益'],
    M03: [`目标每有1种增益，基础威力+15%，最多3种；每有1种减益，+10%，最多3种（当前基础${number(190 * powerFactor)}%，最高${number(265 * powerFactor)}%）`],
    M04: ['翻转自身最多3种普通增益与3种普通减益：物攻、魔攻、双防、速度、命中、减伤与其对应减益互换，保留强度及剩余时间'],
    M05: ['自身获得根系共鸣3回合：友方治疗、护盾或支援生效时，生命最低队友恢复4%最大生命，每队每回合最多3次'],
    M06: ['清除目标普通中毒、灼烧、流血和减防；每移除1层，本次伤害提高18%，最多90%']
  };
  if (skill.category !== 'passive' && skill.power > 0 && !['D03', 'E01', 'I02', 'I05', 'J02', 'J04', 'L03', 'M03'].includes(skill.id)) result.push(row(`对${skill.scope === 'enemies' ? '敌方全体' : '目标'}造成${number(skill.power * powerFactor)}%威力的${skill.element !== '无' ? skill.element + '属性' : ''}${skill.category === 'magic' ? '魔法' : '物理'}伤害`));
  result.push(...(effectMap[skill.id] ?? []).map(row));
  const passiveFactor = residentScalablePassives.has(source.code) ? Number(source.passiveFactor ?? passiveSpecializationFactor(source.specializations?.potent, source.tier)) : 1;
  const p = (base: number) => number(base * passiveFactor);
  const passives: Record<string, string[]> = {
    A07: ['不同回合连续使用不同元素命中时，恢复3%最大魔力，每回合一次'], A08: [`目标带至少两种元素印记、中毒、灼烧、导电等标记时，技能伤害提高${p(12)}%`],
    B07: [`受到硬控时获得${p(20)}%减伤1回合，每场最多2次`], B08: ['每回合首次对已有控制的目标施加控制时，破韧提高12'],
    C07: [`每场首次使用基础冷却至少3回合的技能，获得${p(12)}%减伤与${p(10)}%速度1回合`], C08: [`对速度高于自身的目标，每回合首次技能伤害提高${p(10)}%，首次技能命中修正提高${p(15)}%`],
    D07: ['每回合首次支付至少40魔力时，返还已支付魔力40%，最多6%最大魔力'], D08: [`魔力低于25%时，受到魔法伤害降低${p(18)}%，造成治疗降低${p(25)}%`],
    E07: [`每种非硬控减益使受到伤害降低${p(3)}%，最多${p(12)}%`], E08: [`每回合首次净化或驱散成功，下一次技能伤害提高${p(12)}%，持续1回合`],
    F07: [`每回合被同一攻击者命中并由护盾吸收时，使其双防各降低${p(8)}%1回合`], F08: [`连续2回合未受伤后，下次受到伤害降低${p(25)}%`],
    G07: [`连续交替不同伤害类别的技能获得增伤，每层${p(8)}%，最多2层；连续同类技能清除层数`], G08: [`主副手异类武器时命中、闪避属性提高${p(8)}%；否则双攻提高${p(5)}%`],
    H07: [`其他队友本回合先命中过目标时，自身暴击属性提高${p(5)}%，最多${p(15)}%`], H08: [`队伍仅自身一人时，受到伤害降低${p(15)}%，受到治疗提高${p(20)}%`],
    I01: [`自身每损失1%生命，直击伤害提高${p(.25)}%`], I07: ['每回合首次受到直接伤害后，下一次施放技能魔力消耗降低20%，仅本回合有效'], I08: [`生命低于25%时，风、雷、火抗性提高${p(15)}，受到治疗降低${p(20)}%`],
    J07: ['切磋等级位于当前等级带内时，首次控制基础概率提高8个百分点'], J08: ['每场首次以适合当前天气的元素命中，恢复4%最大魔力'],
    K07: [`每场首次施放辅助技能，获得${p(10)}%减伤与${p(10)}%命中属性1回合`], K08: ['每回合首次成功净化、驱散或护盾破碎时，有35%概率随机使一个冷却中的辅助技能冷却缩短1回合'],
    L07: [`目盲时，每回合首次受到伤害降低${p(20)}%`], L08: ['每场首次攻击识珠低于3级的目标，命中修正提高30%'],
    M07: [`倒下且仍有队友时，队友获得${p(20)}%减伤与${p(15)}%增伤1回合，每场一次`], M08: [`开战时随机获得尚未拥有的${['D02', 'D08', 'E07', 'H08', 'I01', 'I08'].map(id => residentSkillByCode(id)?.name).join('、')}中一种被动的40%数值，持续2回合`]
  };
  result.push(...(passives[skill.id] ?? []).map(row));
  return result;
};

const passiveLabels: Record<string, string> = {
  damageBonusPct: '造成的伤害提高', damageReductionPct: '受到的伤害降低', healingBonusPct: '治疗强度提高',
  regenerationBonusPct: '施加的每回合生命再生提高', magicDamagePct: '魔法伤害提高', lightSkillBonusPct: '光属性技能伤害提高',
  lifestealPct: '直击伤害生命吸取比例为', venomDamagePct: '剧毒伤害提高', criticalDamageBonusPct: '暴击最终伤害提高',
  hpPct: '最大生命提高', mpPct: '最大魔力提高', physicalAttackPct: '物理攻击提高', magicAttackPct: '魔法攻击提高',
  physicalDefensePct: '物理防御提高', magicDefensePct: '魔法防御提高', accuracyPct: '命中属性提高', speedPct: '速度提高', evasionPct: '闪避属性提高',
  critRatePct: '暴击属性提高', critDamagePct: '暴击伤害属性提高', critResistPct: '暴免属性提高', critDamageReductionPct: '暴抗属性提高', chantSpeedPct: '吟唱速度提高', critRateCorrectionPct: '暴击率修正提高', hitCorrectionPct: '命中率修正提高',
  controlResistancePct: '控制抗性修正提高', spiritHpPct: '召唤物最大生命提高', physicalDamageReductionPct: '受到物理伤害降低',
  magicDamageReductionPct: '受到魔法伤害降低', rangedSkillDamagePct: '远程技能伤害提高', aoeSkillDamagePct: '范围技能伤害提高',
  physicalSkillDamagePct: '物理技能伤害提高', magicSkillDamagePct: '魔法技能伤害提高', healingReceivedPct: '受到治疗提高',
  hpRegenPct: '每回合恢复最大生命', mpRegenPct: '每回合恢复最大魔力', actualHitRatePct: '最终命中率修正提高', actualCritRatePct: '最终暴击率修正提高',
  dropBonusPct: '战利品额外掉落概率提高', manaCostReductionPct: '技能魔力消耗降低', wardenInheritPct: '林伴继承属性额外提高', wardenDamageReductionPct: '林伴在场时受到技能直击伤害降低',
  critAvoidanceCorrectionPct: '抗暴率修正提高', statusHitCorrectionPct: '状态命中修正提高'
};
const passiveEffects = (source: SkillCombatSource) => Object.entries(record(source.passive_effect_json)).flatMap(([key, value]) => {
  if (typeof value !== 'number' || !value) return [];
  const adjusted = specializedPassiveValue(key, value, source.specializations?.potent ?? 1, source.tier);
  if (passiveLabels[key]) return [row(`${adjusted < 0 ? passiveLabels[key].replace('提高', '降低') : passiveLabels[key]}${number(Math.abs(adjusted))}%`)];
  if (/^(fire|ice|wind|thunder)Mastery$/.test(key)) return [row(`${({ fire: '火', ice: '冰', wind: '风', thunder: '雷' } as Record<string, string>)[key.replace('Mastery', '')]}元素精通提高${number(value)}`)];
  if (key === 'spiritLimitBonus') return [row(`灵位上限增加${number(value)}`)];
  if (key === 'experienceMultiplier') return [row(`获得经验为原来的${number(value)}倍`)];
  return [];
});

const hiddenEffects = (source: SkillCombatSource, factor: number, powerFactor: number): CombatEffectDetail[] | undefined => {
  const skill = hiddenSkill(source.code); if (!skill) return undefined;
  const pct = (base: number, cap = Infinity) => number(Math.min(cap, base * factor));
  const map: Record<string, string[]> = {
    hidden_mix: ['选择2～4颗粒子，以首颗为主材；按粒子组合计算攻击、治疗、护盾、净化和异常，投料数量与范围决定魔力消耗和冷却', '2 / 3 / 4颗的基础失败概率为15% / 17% / 19%，大成功概率15%；失败时伤害转向友方并降至35%', '施放后获得25实验值；主材与上次不同时额外获得10'],
    hidden_catalyst: ['为后续2个完整回合内的下一次调配或奇釜选择催化模式', '稳定：失败概率降低10个百分点（最低2%），大成功降低5个百分点（最低5%）；激发：失败提高10个百分点，大成功提高15个百分点'],
    hidden_neutralize: ['为全队每人移除1个由自身调配造成的事故减益', `无可移除事故的队友获得${pct(6)}%最大生命护盾2回合`],
    hidden_kettle: ['消耗100实验值，以所选2～4颗粒子进行过载调配，主要数值为普通调配的125%', '魔力消耗为对应调配＋160，基础大成功概率30%，失败概率比普通调配低5个百分点；本次施放后粒子调配至少进入1回合冷却'],
    hidden_weapon_strike: [`以阵内一器对目标造成${number(hiddenWeaponAttackPower(source.code, 1) * powerFactor)}%器具攻击威力伤害`, '器具攻击＝自身对应攻击×80%＋不超过自身攻击的器具攻击×20%；器类决定使用物理或魔法攻击', '命中后获得20器鸣；器类与上次御击不同再获得10'],
    hidden_weapon_guard: [`为友方提供生命护盾2回合：${pct(8)}%目标最大生命＋施法者双防之和的${pct(30)}%，最多20%目标最大生命`, '护盾首次吸收敌方伤害时，施法者获得20器鸣，每回合一次'],
    hidden_weapon_combo: [`消耗50器鸣，以1 / 2 / 3器攻击目标，每器当前威力分别${[1, 2, 3].map(count => number(hiddenWeaponAttackPower(source.code, count) * powerFactor) + '%').join(' / ')}，各段独立结算防御与器性`, '器具攻击＝自身对应攻击×80%＋不超过自身攻击的器具攻击×20%；同种器类每次施放仅触发一次器性'],
    hidden_weapon_finale: [`消耗100器鸣，以1 / 2 / 3器攻击敌方全体，每器当前威力分别${[1, 2, 3].map(count => number(hiddenWeaponAttackPower(source.code, count) * powerFactor) + '%').join(' / ')}，各段独立结算防御`, '仅第一器对首目标触发一次器性；器具攻击使用自身80%＋器具20%的受限混合攻击'],
    hidden_overclock: ['在同一行动中启动一台异械，支付其完整原生能量和冷却', '原生伤害、治疗、护盾为120%，普通状态强度为110%；具体效果由所选异械技能决定'],
    hidden_transfer: ['兼容供能源的异械支付40能量，接收异械获得30能量', '接收者随后立即启动原生技能，并支付完整原生能量与冷却'],
    hidden_synergy: ['消耗50灵感，同次驱动两台不同异械，分别支付完整原生成本', `各台伤害、治疗、护盾按90%投影，普通状态按80%投影，再结算适用的当前效果倍率×${number(factor)}`, '每台范围投影最多3个目标；直接治疗、护盾分别最多目标20%最大生命，共享1次控制及1次驱散预算'],
    hidden_debug: ['消耗100灵感，至多两台异械各恢复30能量、各原生技能冷却缩短2回合', '其中一台立即启动原生技能：伤害、治疗、护盾为125%，普通状态强度为110%'],
    hidden_mark: [`以自身较高攻击对目标造成${number(105 * powerFactor)}%威力的直击伤害`, `命中后施加落子定势2回合：随后2次主动作直伤提高${pct(15, 25)}%，每次额外伤害不超过施法者25%较高攻击`, '标记建立获得20筹策，首次兑现再获得10筹策'],
    hidden_order: ['消耗30筹策，令下轮友方行动位置前移2位，或令敌方后移2位；不增加行动次数', `被提位的友方（延后敌方时为自身）立即获得${pct(8, 12)}%最大生命护盾1回合`],
    hidden_plan: [`预案保留2回合；守势：下次敌方主动作直伤降低${pct(35, 45)}%`, `接应：伤害将使队友降至40%最大生命以下时，先获得${pct(16, 24)}%最大生命护盾`, '截断：对公开吟唱尝试打断，普通目标50%概率、首领20%；成功触发预案获得20筹策'],
    hidden_finale: [`消耗100筹策，以自身较高攻击造成${number(175 * powerFactor)}%威力的直击伤害`, `命中后建立合围窗口2回合：后续主动作命中最多追加2次${number(70 * powerFactor)}%较高攻击威力追击，每名攻击者每回合最多兑现一次；追击不暴击、不递归`]
  };
  return (map[source.code] ?? []).map(row);
};

const masteryEffects = (source: SkillCombatSource): CombatEffectDetail[] | undefined => {
  const effect = record(source.passive_effect_json); if (!effect.weaponType) return undefined;
  const proficiency = Math.min(5, Math.max(1, Number(source.specializations?.overcharge ?? 1)));
  const offhand = offhandAttributeMultiplier(source.specializations?.instant);
  const result = Object.entries(effect).flatMap(([key, value]) => typeof value === 'number' && value !== 0 && passiveLabels[key] ? [row(`装备对应${effect.weaponType}时，主手${passiveLabels[key]}${number(value + Number(effect.masteryStepPct ?? 0) * (proficiency - 1))}%；副手为${number((value + Number(effect.masteryStepPct ?? 0) * (proficiency - 1)) * offhand)}%`)] : []);
  result.push(row(`副手该类武器的属性词条按${number(offhand * 100)}%生效；不缩放装备特殊效果`));
  return result;
};

const boundMechanics = (source: SkillCombatSource): CombatEffectDetail[] => {
  const mechanics: Record<string, string[]> = {
    passive_shadow_combo: ['可连击主技能实际命中后连影增加1层，最多5层；转火或未命中减少1层，间隔超过2回合重置；复制攻击不再次积累'],
    passive_titan_burden: ['普通战斗伤害的最终生命损失分摊到接下来3个自身回合的伤势队列；伤势不等于免伤，后续仍需偿还'],
    passive_thief_opening: ['每回合首次成功闪避获得10手感；验货和借势命中也可积累手感，手感不直接生成战利品'],
    passive_stringblade_flow: ['远程与近战主攻击成功交替时，下一击伤害提高10%；连续同类动作不触发'],
    passive_arcane_circuit: ['按成功施放的中高位奥术主行动累积奥术负荷；多段、复制、暴击不重复获得，满值用于高阶奥术']
  };
  const direct = (mechanics[source.code] ?? []).map(row);
  const definition = advancedBoundSkillDefinitions.find(skill => skill.code === source.code && skill.kind === '传承');
  if (!definition) return direct;
  const values = inheritancePassiveFor(definition.professionCode)?.own ?? [];
  const v = (index: number) => number(values[index] ?? 0);
  const inherited: Record<string, string[]> = {
    bulwark_guard: [`带嘲讽、守护、壁垒或护盾结束行动时，为生命比例最低的其他队友建立护阵1回合，每回合一次`, `受护者首次受到技能直击时，将${v(0)}%伤害转给自身，最多受护者12%最大生命；其余伤害再降低${v(1)}%`],
    war_lord: ['成功施加新减益后，为该目标施加军令2回合，每回合最多一个目标', `下一名不同队友的技能直击最终伤害、命中修正各提高${v(0)}% / ${v(1)}%，并留下应旗`, `自身随后直击该目标忽略${v(2)}%对应防御，获得${v(3)}战意并消耗应旗`],
    ironbreaker: [`每目标每回合首次单体技能命中带破甲、易伤或追猎的目标，本次暴击率修正提高${v(0)}%，并留下裂口2回合`, `下一名不同队友单体技能暴击率修正提高${v(1)}%，忽略${v(2)}%对应防御，随后消耗裂口`],
    elementalist: ['成功施加此前不存在的冰、火、风、雷印记或对应减益后，留下导相2回合', `下一次不同元素技能直击最终伤害提高${v(0)}%，施法者恢复${v(1)}%最大魔力；自身触发时额外获得${v(2)}奥能`],
    spirit_summoner: ['每回合首次有生命低于60%的队友获得直接治疗、生命盾或壁垒时，建立灵荫', `场上仍有存活灵时，回合末该队友恢复${v(0)}%最大生命，生命最低的灵恢复${v(1)}%最大生命，自身获得${v(2)}灵契`],
    arcane_magister: ['中高位奥术每次成功的主行动累积奥术负荷；负荷上限100，满值由下一次高阶奥术消耗，多段与复制不重复累计'],
    spellblade: [`技能直击造成伤害后，下次有效治疗、护盾、壁垒或友方增益提高${v(0)}%`, `该支援生效后，下次技能直击最终伤害提高${v(1)}%，忽略${v(2)}%对应防御；每回合最多完成一轮`],
    nightblade: [`每目标每回合首次技能直击生命不高于45%或带自身追猎的目标，最终伤害提高${v(0)}%`, `触发后进入退影：下次自身回合前首次受到技能直击减伤${v(1)}%；击杀额外净化自身1个普通减益`],
    venomancer: ['目标有自身剧毒时，同回合其他队友施加另一种新减益建立蚀媒', `下一名不同角色技能直击立即兑现一层下回合剧毒的${v(0)}%伤害，普通目标最多${v(1)}% / 首领最多${v(2)}%最大生命`],
    trickster_ranger: ['其他队友先技能命中后，自身再命中建立猎线2回合；另外两名不同队友命中后收线', `收线驱散1个闪避、加速或命中增益；没有可驱散增益时减速${v(0)}%1回合，自身获得${v(1)}机巧`],
    saint_healer: [`每回合首次直接治疗生命低于50%的队友时，附加${v(0)}%最大生命护盾2回合`, `若本次治疗使其跨过50%生命，将实际恢复量${v(1)}%转为对另一名生命最低队友的额外治疗`],
    aegis_priest: [`每名队友每回合首次由自身施加的生命盾或壁垒抵消技能直击，获得${v(0)}%控制抗性至下次回合结束`, `同时恢复吸收或减免伤害的${v(1)}%，最多受护者${v(2)}%最大生命`],
    sharpshooter: [`每回合首次远程技能直击生命高于60%的目标，命中修正提高${v(0)}%、最终伤害提高${v(1)}%，建立猎眼2回合`, `其他队友命中猎眼目标时命中修正提高${v(2)}%，并消耗猎眼；自身击杀后速度提高${v(3)}%1回合`],
    gunner: [`技能直击暴击后建立火药印记2回合；下一名不同队友直击暴击率修正提高${v(0)}%、暴击伤害提高${v(1)}%，消耗印记；每回合最多${v(2)}次`],
    ranger_warden: [`每回合首次林伴施加标记、束缚、减速或中毒时，自身与生命最低队友的闪避、速度各提高${v(0)}%1回合`, `该林伴留下林迹2回合，另一名队友命中后目标减速${v(1)}%1回合，消耗林迹`],
    dawn_inquisitor: ['施加易伤或成功驱散增益时建立晨钟判词2回合', `最多两种不同伤害类别的队友技能直击各提高${v(0)}%最终伤害，延长易伤1回合；第二种触发后获得${v(1)}信念并消耗判词`],
    magical_scholar: ['每回合首次用反应中和移除自身事故时，获得8%最大生命护盾2回合，恢复30魔力', '获得复盘：下次不同主材有效调配的首个非控制增益延长1回合；大成功再获得10实验值'],
    weapon_master: ['三器合锋用至少两种器类全部命中时，恢复15器鸣，获得归鞘2回合；每2回合一次', '下次不同器类命中时，继承上次记录的普通器性60%效果'],
    inventor: ['双机协同两台异械均实际生效后，为能量较低者恢复20能量，两台原生冷却各缩短1回合；每2回合一次', '随后2回合内下一次单异械行动，原生能量消耗降低25%，并令另一台进入待机'],
    tactician: ['条件预案成功触发后获得余策2回合：下次预案所需筹策降低25%，每2回合一次', '守势额外净化受护者1个普通减益；接应延长护盾至下次行动结束；截断额外施加20%减速1回合'],
    sword_shadow: ['可连击攻击实际命中后，按5%＋最终速度×0.1%＋最终命中×0.35%＋最多3层连影×2%判定复制，概率最低5%、最高35%', '复制不递归；普通可连击技能最多复制2次，剑刃风暴最多1次'],
    titan: ['普通战斗伤害的最终生命损失进入接下来3个自身回合的伤势队列'],
    master_thief: ['成功闪避、验货与借势实际命中可积累有限手感；探囊仍受目标合法战利品池、警觉与同一生命实例仅成功一次限制'],
    holy_knight: ['勇誓与守誓互斥，切换立即取消旧姿态临时强化；守誓代承对单个伤害事件最多一次'],
    stringblade: ['远程与近战攻击成功交替时，伤害提高10%；启用引弦时改为25%；连续同类动作不触发']
  };
  return [...direct, ...(inherited[definition.professionCode] ?? []).map(row)];
};

/** Talent rules are separate from ordinary skills: no generic power or potency growth. */
const talentEffects = (source: SkillCombatSource): CombatEffectDetail[] | undefined => {
  const talent = talentByCode.get(source.code); if (!talent) return undefined;
  if (!talent.implemented) return [row('该天赋尚未开放，当前不能选择或获得其效果')];
  const map: Record<string, string[]> = {
    A01: ['自身普通攻击与主动攻击技能的直击伤害提高50%'],
    A02: ['自身治疗术的恢复基数提高50%，随后结算受疗修正与生命上限；药剂和吸血不受此增幅'],
    A03: ['技能实际魔力支付为原来的2/3；固定转赠魔力不享受折扣'],
    A04: ['对自身尚未命中过的敌人，直击伤害为225%；对已经命中过的敌人为125%；多段共享本次首次命中资格'],
    A05: ['连续主动攻击切换伤害类别时，直击伤害为160%；其他情况为110%'],
    A06: ['自身直击伤害为125%，受到的直击伤害为5/6，产生的仇恨为150%'],
    A07: ['连续攻击同一敌人，直击倍率依次为110%、125%、140%、155%、170%，之后保持170%；切换敌人或使用非攻击行动重置'],
    A08: ['主动防御后，下一次主动攻击直击伤害为250%；防御减伤保留至下次正常行动开始'],
    A09: ['远程主动直击伤害为150%，攻击前可查看距离是否满足技能限制'],
    A10: ['指定自己的一只机巧、契灵或随从，其正常攻击伤害为200%；同一时间仅指定一只'],
    B01: ['普通步行与坐标前往耗时降低50%'], B02: ['勘察耗时由60秒缩短至24秒，显示最近5个已公开资源点的方向和种类'],
    B03: ['普通非首领随机掉落概率为200%；概率超过100%的部分折为同种普通产物数量，任务与稀有专属产物不受影响'],
    B04: ['完成公开资源调查后记录合法往返路线，沿已记录路线移动耗时降低60%'],
    B05: ['战斗胜利有30%概率、首次到达新坐标有20%概率拾得4份普通残料；每天战斗最多触发6次、移动2次，共最多32份'],
    B06: ['公开危险区域的非战斗环境伤害降低60%；调查陷阱前显示伤害类型'],
    B07: ['普通矿物采集产出为350%，公开矿点显示剩余可采次数'],
    B08: ['受到真实环境伤害后，记录该区域30分钟；期间调查耗时降低75%'],
    B09: ['正式遗迹机关每次成功推进3点进度，失败提供一条公开排除线索'],
    B10: ['从安全锚点沿合法路线外出，移动耗时为60%；沿本次已走路线返程为25%'],
    C01: ['合格角色经验为175%，副职业熟练度为250%'],
    C02: ['每种合格怪物每天前3次击败经验为300%，之后恢复正常'],
    C03: ['角色经验暂存研习账本，30分钟后按200%领取；收存不得超过当前合法成长容量'],
    C04: ['个人制作成功并切换配方时，该次成功部分熟练度为400%；首次或连续同配方为150%'],
    C05: ['合格探索、生产和社交日常的角色经验为250%；普通杀怪经验不变'],
    C06: ['满足满血入战、完成至少3次正常行动并实际承受至少50%最大生命敌伤的失败，记录一个合格敌种；下次击败同种经验为400%，消耗记录，每天最多3次'],
    C07: ['每累计4次同类合格经验事件，下一次额外经验为本次基础经验6倍与前4次平均基础经验6倍中的较小值，之后重新累计'],
    C08: ['当日首个成功生产配方连续完成时，成功部分熟练度为350%；改用其他成功配方后当天停止该加成'],
    C09: ['首次完成某名普通NPC正式个人委托，角色经验为400%；该NPC后续委托为150%'],
    C10: ['完成合格战斗或生产后，在安全处复盘5分钟，可额外领取原始角色经验150%或原始成功熟练度250%'],
    D01: ['喜欢物品带来的正向交涉心情为300%，首次接触显示2类喜好'],
    D02: ['合格交涉入队概率为300%，最高75%；随从正向亲密增长为300%'],
    D03: ['向普通NPC自由赠礼的正向好感为300%'],
    D04: ['承接委托时立约，按时完成的好感和地区声望为400%；逾期或放弃扣除原基础好感奖励50%'],
    D05: ['每天首次与同一已相识NPC共餐，好感为400%；本人分享给队友的料理持续时间为300%'],
    D06: ['与引荐人达到200好感后，可沿公开人物关系引荐；被引荐NPC前5次有效正向好感为500%'],
    D07: ['首次战前交涉使用温和开场，后续喜欢物品的正向心情为400%；交涉失败后的前2个自身正常回合直击伤害减半'],
    D08: ['本人亲手制作且符合NPC喜好的普通赠礼，正向好感为500%'],
    D09: ['正式声望奖励为350%；地区公开声望达到100后，可查看该地普通人物索引'],
    D10: ['与指定随从结下同心结，其正向亲密增长为400%；其他随从为75%'],
    E01: ['本人普通采集产出为300%，小数余量累计后补齐'],
    E02: ['个人锻造、炼金失败返还实付普通材料的2/3；成功部分熟练度为300%'],
    E03: ['本人食用料理的数值增益为150%，持续时间为300%'],
    E04: ['个人家园合格普通建材支付为40%，按累计小数结算'],
    E05: ['糖水屋普通恢复药剂和公会普通补给五折，每天共用5000铜币减免额度'],
    E06: ['个人机巧战外维修的普通材料支付为35%；机巧制造成功部分熟练度为300%'],
    E07: ['成功锻造普通装备后，记录基础熟练度300%的纹印，下次同类锻造成功时一并领取'],
    E08: ['普通恢复药剂炼制产量为350%，投掷与附状态药剂不适用'],
    E09: ['个人合格普通制作材料支付为40%，按累计小数结算'], E10: ['本人普通作物生长时间由24小时缩短至8小时'],
    F01: ['火元素精通提高50', '攻击命中施加朱雀灼烧2次：每次基础伤害为该动作有效直击生命损失的2.5%，再结算韧性与火抗；同施法者取较强灼烧并刷新'],
    F02: ['雷元素精通提高50；战外普通移动耗时降低50%'],
    F03: ['最大生命提高35%', '承受敌方直击后仍存活时，向攻击者反震实际生命损失的30%'],
    F04: ['斩击、刺击直击伤害为150%；击败等级差不超过5级的合格敌人后，下一次攻击显示弱点提示'],
    F05: ['对他人施放治疗术的基数为150%，自疗不变；受治队友30分钟内下一次脱战休息恢复量为300%'],
    F06: ['每完成第3次主动攻击，将对各目标有效直击生命损失的150%记为延迟伤害，在自身下次正常行动开始时结算'],
    F07: ['直击伤害初始为115%；正常攻击直击击杀等级差不超过5级的敌人后，恢复15%最大生命，本场直击倍率增加15个百分点，最多175%'],
    F08: ['每名普通NPC前5次有效正向好感为400%；交涉正向礼物心情为200%，保存已公开喜好'],
    F09: ['对生命高于50%的敌人，直击伤害为200%；直接击败等级差不超过5级的合格敌人后恢复8%最大生命，每回合最多一次'],
    F10: ['风元素精通提高50；正常攻击行动结束后，对命中且存活的目标追加本次有效直击生命损失50%的风属性伤害'],
    G01: ['正常攻击行动结束时，恢复本次物理直击实际生命损失的50%，最多自身20%最大生命'],
    G02: ['开战获得35%最大生命的独立护盾；每完成一次有效正常行动补充4%最大生命护盾，最多35%'],
    G03: ['最大生命提高20%，自身直击伤害为125%'],
    G04: ['魔法直击与治疗术基数为120%，技能魔力支付为80%'],
    G05: ['最大生命提高50%，首次受到普通非硬控减益时显示清晰来源'],
    G06: ['冰元素精通提高50；脱战休息时每10分钟可凝结月露，恢复30%最大魔力'],
    G07: ['可普通净化的持续伤害为35%，其他敌方直击伤害为80%'],
    G08: ['每次受到敌方直击增加1层劫纹，每层使后续直击伤害乘95%，最多8层'],
    G09: ['受到元素直击的伤害为5/6，随后储存1枚混沌核；下次主动攻击消耗核心，追加该动作有效直击生命损失25%的无属性伤害'],
    G10: ['每次自身正常行动开始交替星辉与星隐；星辉时直击、治疗术为150%，星隐时受到直击伤害为2/3'],
    H01: ['主动直击伤害为225%；最大生命为60%，获得的生命护盾为50%'],
    H02: ['正常行动开始时生命不高于30%，本次主动直击与治疗术为200%；其他角色对自身的治疗量为50%'],
    H03: ['主动攻击技能直击伤害为175%；每次先支付8%最大生命并至少保留1生命，普通攻击不收费也不增幅'],
    H04: ['原始吟唱至少1回合的魔法直击为250%，治疗术为300%；结算专精后仍额外增加1个完整吟唱回合'],
    H05: ['对同一敌人本次生命的首次单体主动攻击，所有直击段伤害为400%；后续为80%；首次未命中或使用群攻仍消耗首次资格'],
    H06: ['开启险采后，每次支付15%最大生命，80%概率获得450%普通采集产量，20%无产出；支付后至少保留1生命'],
    H07: ['首饰槽全部为空且本场未使用恢复药剂时，主动直击伤害为200%；首次受到恢复药剂作用先取消本场增幅'],
    H08: ['全程没有队友、随从、契灵、机巧或外来支援时，主动直击为200%；技能魔力支付为125%，接受支援后本场增幅失效'],
    H09: ['主动开启孤注制作后，合格普通产物成功产量为400%，原成功率乘70%；失败材料不退，稀有主材配方不适用'],
    H10: ['首次生命降至20%及以下时进入余火不灭，战斗伤害最低保留1生命，持续2个自身正常行动时点；每场一次', '期间正常主动直击为250%，生命恢复全部无效；到期或离开战斗扣除10%最大生命，至少保留1生命'],
    I01: ['主动直击总伤害为180%，其中一半当场生效，另一半在自身下次正常行动开始结算；两次各自遇到护盾'],
    I02: ['普通材料重量为1/3；固定配方缺少一种普通辅材时，可用同阶、等标准价值的其他普通材料代付，代付价值不超过普通材料总值50%'],
    I03: ['普通随机掉落每天最多5次整包预览：接受则数量为200%；放弃则同表重抽一次并按200%领取，重抽结果必须接受'],
    I04: ['正式第一回合前可对自身施放一次已学会且冷却就绪的法镜、铁门半开、余火护幕或猎人量距，不占正常行动，仍支付魔力与冷却，效果强度为150%'],
    I05: ['每完成2次正常行动，下次正常行动前重复上一次普通攻击，伤害为记录有效直击生命损失的150%'],
    I06: ['可选择无名拜访，陌生NPC首次自由交谈忽略历史负好感；普通正向交谈好感为300%'],
    I07: ['脱战可投影同类装备槽外观；每3次正常行动可将自身一项普通增益的原强度、层数与剩余时间转给一名友方，同类更强增益不会被覆盖'],
    I08: ['采集时可将本次普通产物封存24小时，期满领取350%；封存期间无法使用或交易'],
    I09: ['普通生命恢复药剂可改为基础恢复量200%的护盾，维持2个自身正常行动时点，该药剂不再回血'],
    I10: ['单人面对一只允许降服的普通怪物时，可战前选择不取性命；敌人生命首次将降至1/3以下时停在该阈值并立即降服，按普通击败结算一次']
  };
  const result = (map[talent.number] ?? []).map(row);
  if (['A', 'F', 'G', 'H', 'I'].includes(talent.number[0]) && !['F02', 'F08', 'G06', 'H06', 'H09', 'I02', 'I03', 'I06', 'I08'].includes(talent.number)) result.push(row('上述战斗效果仅在对怪物的战斗中生效，玩家切磋不生效'));
  return result;
};

/** Short purpose text is intentionally independent of description and specialization copy. */
const purpose = (source: SkillCombatSource, effects: CombatEffectDetail[]) => {
  if (source.code === 'appraisal') return '鉴识目标并查看战斗情报。';
  if (source.code === 'craftsmanship') return '借助副职业技艺改善打造与炼金收益。';
  if (source.code === 'machine_echo') return '为自身生效中的主动异械补充充能。';
  const talent = talentByCode.get(source.code);
  if (talent) return ({ 战斗: '强化自身的战斗表现。', 探索: '改善探索、移动与资源获取。', 成长: '改变经验与熟练度的获取方式。', 社交: '改善与角色的交涉及关系成长。', 生产: '改善采集、制作与材料利用。', 血脉: '发挥血脉赋予的固有能力。', 体魄: '通过特殊体魄增强生存与战斗。', 孤注: '以特定代价换取条件收益。', 奇异: '提供特殊的行动与资源使用方式。', '？？？': '特殊成长道路。' } as Record<string, string>)[talent.group];
  if (['passive', 'bound'].includes(source.category)) return source.category === 'passive' ? '链接后提供持续的战斗增益。' : '提供角色固有能力与战斗增益。';
  const text = effects.map(effect => effect.text).join(' ');
  if (source.category === 'utility') {
    if (/净化|清除.*负面/.test(text) && /恢复|治疗/.test(text)) return '净化异常并恢复友方状态。';
    if (/净化|驱散/.test(text)) return '处理战场上的异常状态与增益。';
    if (/生命护盾|减伤|保护|代承/.test(text)) return '保护队友并缓解受到的伤害。';
    if (/额外行动|冷却|行动次序/.test(text)) return '调整行动节奏，创造出手机会。';
    if (/恢复/.test(text)) return '恢复友方生命或魔力。';
    if (/控制|沉默|目盲|石化|魅惑/.test(text)) return '限制敌方行动，干扰其战斗节奏。';
    return '施放辅助术式，支援战斗。';
  }
  const folio = folioSkillByCode(source.code);
  const multiple = allTargets(source.target_scope) || Boolean(folio && folio.targetCount !== 1);
  return `${multiple ? '攻击多个敌人' : '攻击选定敌人'}${/命中后|施加/.test(text) ? '并触发附加效果' : ''}。`;
};

export const skillCombatDetails = (source: SkillCombatSource): { summary: string; combatEffects: CombatEffectDetail[] } => {
  const spec = source.specializationResult ?? skillSpecialization({ code: source.code, category: source.category, tier: source.tier, power: Number(source.power ?? 0), mana_cost: Number(source.mana_cost ?? 0), cooldown_turns: Number(source.cooldown_turns ?? 0), chant_turns: Number(source.chant_turns ?? 0) }, source.specializations);
  const generated = folioEffects(source, spec.effectFactor, spec.powerFactor) ?? residentEffects(source, spec.effectFactor, spec.durationChange, spec.powerFactor) ?? hiddenEffects(source, spec.effectFactor, spec.powerFactor) ?? masteryEffects(source) ?? skillAdvancedCombatDetails({ ...source, specializationResult: spec }) ?? talentEffects(source);
  const effects: CombatEffectDetail[] = generated ?? [];
  if (!generated && Number(source.actualPower ?? spec.power) > 0 && !['passive', 'bound', 'utility'].includes(source.category)) effects.push(row(`对${allTargets(source.target_scope) ? '敌方全体' : '目标'}造成${number(Number(source.actualPower ?? spec.power))}%威力的${source.element && source.element !== '无' ? source.element + '属性' : ''}${source.category === 'magic' ? '魔法' : '物理'}伤害`));
  if (!advancedSkillSkipsDatabaseEffects(source.code) && !['machine_echo', 'warrior_taunt_player'].includes(source.code)) effects.push(...databaseEffects(source));
  if (['bound', 'passive'].includes(source.category) && !record(source.passive_effect_json).weaponType) effects.push(...passiveEffects(source), ...boundMechanics(source));
  if (source.code === 'appraisal') {
    effects.push(row(`可鉴识不高于自身${Math.max(1, Number(source.appraisal?.rangeLevel ?? 1)) * 3}级的目标`));
    effects.push(row(`当前识珠Lv.${source.appraisal?.informationLevel ?? 1}，按已解锁权限显示目标情报`));
  }
  const healing = ({ healing_light: 100, healing_prayer: 135, saint_healer_mending_prayer: 90, saint_healer_absolution_hand: 60 } as Record<string, number>)[source.code];
  if (healing) effects.unshift(row(`恢复选定友方（未选择时取生命比例最低者）相当于施法者${number(healing * spec.supportFactor)}%魔法攻击${source.code === 'saint_healer_mending_prayer' ? `＋目标${number(8 * spec.supportFactor)}%最大生命` : ''}的生命；实际恢复受治疗修正影响`));
  if (source.code === 'warrior_taunt') effects.push(row('敌方全体对自身增加相当于自身物理防御＋魔法防御的仇恨'));
  if (source.code === 'warrior_taunt_player') effects.push(row('对敌方全体，将每名其他队友当前仇恨的一半（向下取整）转移至自身'));
  if (source.code === 'machine_echo') effects.push(row('自身每件已生效主动异械恢复最多25点充能，不超过其充能上限'));
  if (source.code === 'craftsmanship') {
    const craft = source.craftsmanship;
    effects.push(row(craft?.kind === 'durability' ? `自身打造的装备耐久损耗降低${number(craft.percent)}%（当前锻造师Lv.${craft.level}）` : craft?.kind === 'potion' ? `药品期望品质与产量总收益提高${number(craft.percent)}%，品质达到上限后转为额外产量（当前炼金师Lv.${craft.level}）` : '拥有锻造师或炼金师副职业时，按副职业等级改善耐久损耗或药品品质、产量'));
  }
  const combatEffects = effects.filter((effect, index) => effects.findIndex(other => other.text === effect.text) === index);
  return { summary: purpose(source, combatEffects), combatEffects };
};
