import type { CombatEffectDetail, SkillCombatSource } from './skill-combat-details';
import { advancedProfessionActiveSkillCodes } from '../game/advanced-profession.config';
import { advancedResourceDefinitions, advancedSkillResourceRequirements } from '../game/advanced-resource.config';
import { newAdvancedSkillDefinitions } from '../game/map-hidden-advanced-skills.config';
import { wardenCompanionBySkill } from '../game/warden-companion.config';
import { spiritDefinitions } from '../game/spirit-summoner.config';
import { aoeSkillPower } from '../game/aoe-damage.config';
import { specializeEffectDuration, specializeEffectValue } from '../game/skill-specialization';

const advancedCodes = new Set(Object.values(advancedProfessionActiveSkillCodes).flat().filter(code => !code.startsWith('hidden_')));
const newSkills = new Map(newAdvancedSkillDefinitions.map(skill => [skill.code, skill]));
const number = (value: number) => String(Number(value.toFixed(4)));
const row = (text: string): CombatEffectDetail => ({ text });
const state = (text: string, name: string, description: string): CombatEffectDetail => ({ text, descriptions: [{ name, text: description }] });

/** These early-return branches never run the database's on_cast/on_hit effects. */
export const advancedSkillSkipsDatabaseEffects = (code: string) => Boolean(wardenCompanionBySkill(code)) || newSkills.get(code)?.category === 'utility';

/** Read-only copy of the player PvE branches in adventure.service.ts, including
 * cooldowns/stats_json mechanisms. DB effects are appended by skillCombatDetails.
 * Do not use advancedSkillDescriptions here: several historical descriptions
 * describe branches which are no longer reached by player actions. */
export function skillAdvancedCombatDetails(source: SkillCombatSource): CombatEffectDetail[] | undefined {
  if (!advancedCodes.has(source.code) || ['passive', 'bound'].includes(source.category)) return undefined;
  const code = source.code, spec = source.specializationResult;
  const value = (effect: string, base: number) => number(specializeEffectValue(effect, base, spec?.effectFactor ?? 1));
  const turns = (effect: string, base: number) => specializeEffectDuration(effect, base, spec?.durationChange ?? 0);
  const support = spec?.supportFactor ?? 1;
  const barrier = (base: number, duration: number, target = '全队') => state(`为${target}提供[减伤壁垒]，持续${turns('barrier', duration)}回合`, '减伤壁垒', `受到的伤害降低${value('barrier', base)}%；实际支援还受适用的攻势换挡影响`);
  const regeneration = (base: number, duration: number, target = '全队') => state(`为${target}提供[再生]，持续${turns('regeneration', duration)}回合`, '再生', `每回合恢复${value('regeneration', base)}%最大生命；实际恢复受再生与受疗修正影响`);
  const guard = (rate: number, duration: number, target = '选定友方，未指定时取生命比例最低者') => state(`为${target}提供[守护]，持续${duration}回合`, '守护', `下一次可转移的单体伤害中${rate}%由施法者代承，触发后移除；转移伤害继续结算守护者减伤与护盾，每次伤害仅转移一次`);
  const combo = state('实际命中后连影增加1层（最多5层），首次命中获得20影势，并判定连击', '连影', '连击概率＝5%＋最终速度×0.1个百分点＋最终命中×0.35个百分点＋前3层连影每层2个百分点，限制在5%～35%；追影斩最多复制2次，剑刃风暴最多复制1次，复制独立结算命中和防御且不递归获取影势；换目标先减1层，未命中减1层，间隔超过2回合归零');
  const spiritRoles = state('灵体按当前职责回应，每只每个全局回合最多回应一次', '灵体职责', '攻：82%灵体魔攻威力的单体攻击；疗：恢复生命比例最低队友72%灵体魔攻的生命；守：全队获得8%减伤壁垒2回合。未调度的逐风貂使全体敌人速度降低12%1回合；未调度的弯月猫恢复主人6%最大魔力并使目标易伤12%1回合。调度强化令下一次攻、疗、守对应数值×1.15；灵体回应获得15灵契，并消耗1次维系时长');
  const map: Record<string, CombatEffectDetail[]> = {
    sword_shadow_polish: [state('记录拭剑状态，至当前全局回合＋3时仍有效', '拭剑', '有效期间追影斩和剑刃风暴直接伤害×1.15，并忽略对应防御15%；同名状态刷新，不叠加')],
    sword_shadow_sheathe: [state('准备下一次追影斩或剑刃风暴的额外1次复制', '持鞘', '不可预存第二层；开始对应攻击时消耗标记，追影斩连击总数最多2次，剑刃风暴最多1次；复制不递归')],
    sword_shadow_chase: [combo], sword_shadow_storm: [combo, row('每次施放只在首个实际命中的目标上进行一次连击判定')],
    titan_anchor: [row('对每名存活敌人增加max(50，向下取整的自身最大生命×8%)仇恨'), state('自身获得[控制抗性]2回合', '控制抗性', '控制抗性提高20%，不提高双防')],
    titan_defer: [state('准备延后下一次到期的伤势结算', '缓伤', '将min(本次到期伤势×15%向下取整，自身最大生命×8%向下取整)延后一回合；没有消除伤势，不能叠存，战斗结束仍结清')],
    titan_quake: [row('实际命中后，对目标额外增加max(40，向下取整的自身最大生命×6%)仇恨')],
    titan_unbroken: [row('对每名存活敌人增加max(100，向下取整的自身最大生命×12%)仇恨'), guard(25, 2, '生命比例最低的另一名存活友方'), state('准备下一跳伤势延期', '缓伤', '下一次到期伤势最多延后15%，且不超过自身8%最大生命，延后一回合；未偿伤势继续结算')],
    arcane_precast: [state('准备下一次奥术攻击技能', '预构奥式', '下一次奥术攻击技能威力×1.12，支付魔力×1.2并向上取整；施放后清除，不放大奥术负荷取得')],
    arcane_bolt_high: [row('完成施放后获得20奥术负荷；不要求本次攻击命中')],
    arcane_pierce: [row('本次额外忽略目标18%魔法防御；完成施放后获得30奥术负荷，不要求命中')],
    arcane_meteor: [],
    summoner_call: [row('从五种灵体中选择一只进入空灵位，维系7次回应；同种已存在时只重设维系时间'), row('普通灵位上限1；拥有灵息被动或正在唤灵师试炼时上限3，灵体生命额外×1.2'), spiritRoles],
    summoner_reassign: [row('将选定存活灵体按攻→守→疗循环切换职责，准备下一次职责数值×1.15；本次调度不立即追加回应'), spiritRoles],
    summoner_command: [row('令选定现存灵体立刻执行一次职责；本回合已经回应过的灵体不能再次执行'), spiritRoles],
    summoner_triad: [row('要求至少两种不同职责的存活灵体；全部本回合尚未回应的灵体各执行一次职责，同一灵体不能重复回应'), spiritRoles],
    thief_appraise: [row('显示目标合法低价值可偷物资，记录验货目标；首次识别该目标获得15手感'), row('首领、非陪练试炼目标不可偷；没有合法物资时仍能识别其禁止偷取状态')],
    thief_pickpocket: [row('仅对可偷的普通PvE怪物尝试一次战利品预占；同一怪物本次生命成功后不可再偷'), row('成功率＝55%＋(自身命中−目标感知)/10个百分点＋已验货12个百分点（未验货则−12个百分点）−警觉层数×12个百分点，最低15%、最高85%'), row('成功获得20手感并记录本场取物凭证；物品仅在胜利掉落真实生成且可扣减时兑现；失败警觉增加1层；陪练不发放物品')],
    thief_exploit: [row('本次目标已被自身验货时，直接伤害×1.10；实际命中后将其记为已验货目标并获得10手感')],
    thief_loaded: [row('持有本场探囊凭证时，直接伤害×1.25；实际命中后消耗凭证，不额外生成掉落')],
    paladin_switch_vow: [row('切换勇誓／守誓，并立即删除自身施加的旧姿态临时强化')],
    paladin_rally: [state('按当前誓约强化全队2回合，生效后获得15誓约', '勇誓／守誓', '勇誓：双攻提高12%、命中属性提高8%；守誓：减伤10%、控制抗性提高10%，并使另一名生命比例最低队友（或指定队友）获得一次20%单体守护2回合')],
    paladin_charge: [row('实际命中后，对目标额外增加max(40，向下取整的自身最大生命×6%)仇恨，并获得15誓约')],
    paladin_sanctuary: [state('按当前誓约强化全队2回合', '勇誓／守誓', '勇誓：双攻提高18%、命中属性提高12%；守誓：减伤16%、控制抗性提高10%，并使另一名生命比例最低队友（或指定队友）获得一次25%单体守护2回合；同名强化取高值')],
    stringblade_draw: [state('准备下一次成功远近交替攻击', '收弦', '远近交替的直接伤害倍率从×1.10变为×1.25；攻击实际命中后清除，不额外增加行动')],
    stringblade_shot: [], stringblade_slash: [],
    stringblade_cross: [row('有效远近交替并实际命中且目标存活时，追加本次主段伤害55%的非递归伤害；追加段不另取资源')],
    bulwark_shieldwall_advance: [state('施放时对受击目标施加[嘲讽]2回合，并获得20守势', '嘲讽', '敌方行动强制锁定施法者；该状态在本次攻击命中判定之前施加')],
    bulwark_vicarious_guard: [guard(35, 2), barrier(20, 2, '自身')],
    bulwark_immovable_mountain: [state('自身控制抗性提高20%，持续2回合；记录承受攻击次数', '反击架势', '状态期间作为主目标承受3次正伤害后准备一次反击；下次自身行动前以90%概率尝试90%物攻威力攻击，仍需命中判定')],
    bulwark_bastion_judgment: [row('主目标伤害在防御结算后额外×1.60；其余目标按通常范围威力结算'), barrier(15, 2), state('施放时嘲讽主目标2回合', '嘲讽', '敌方强制锁定施法者，施放即生效，不要求主段命中')],
    warlord_quake_command: [],
    warlord_break_formation: [state(`命中后目标物理防御降低${value('armor_shatter', 8)}%，持续${turns('armor_shatter', 2)}回合，并施加[破阵军令]2回合`, '破阵军令', '随后一次技能伤害提高12%，命中兑现后消耗')],
    warlord_triumph_banner: [state('全队控制抗性提高15%，持续3回合', '控制抗性', '控制抗性提高15%；触发攻势换挡时按支援倍率修正'), row(`存活敌人至少3名时，额外恢复全队${number(8 * support)}%最大生命；实际恢复受主动治疗及适用的区域修正影响`)],
    warlord_hundred_battle_sweep: [row('目标每带减速、束缚、眩晕中的一种，本次防御结算后的伤害额外提高15%（当前三种条件最多45%）')],
    ironbreaker_armor_rend: [state(`攻击前目标已有普通破甲时，命中后额外施加[易伤]${turns('exposed', 2)}回合`, '易伤', `受到的直击伤害提高${value('exposed', 3)}%`)],
    ironbreaker_breaking_pursuit: [row('目标已有易伤或追猎标记时直接伤害×1.35；满足条件并命中额外获得20裂势')],
    ironbreaker_gap_execution: [row('目标当前生命低于35%时直接伤害×1.45；击杀后自身该技能剩余冷却减半并向下取整')],
    ironbreaker_steel_flash: [row('本次攻击通常不会暴击，强制暴击效果另行结算；目标每层易伤使直接伤害提高8%，最多5层／40%，命中后移除全部易伤')],
    elementalist_cinderfrost_cycle: [row('每次施放在火／冰属性间交替；命中后施加对应元素印记4回合'), state(`以冰命中已有火印记的目标时，施加[减速]${turns('slow', 1)}回合`, '减速', `速度降低${value('slow', 25)}%`), row('向已有其他元素印记的目标补入新印记时获得25奥能，每次施放最多一次')],
    elementalist_storm_chain: [row('目标已有火、冰、风印记每种使本次防御结算后的伤害提高15%，最多30%；命中后留下雷印记4回合'), row('向已有其他印记的目标首次补入雷印记时获得25奥能，每次施放最多一次')],
    elementalist_fourfold_resonance: [row('目标已有火、冰、雷印记每种使本次直接伤害提高10%，最多30%；命中后刷新已有印记至4回合，并加入风印记4回合'), row('以风首次补齐已有火、冰、雷三印记时获得100奥能；其他首次补入风印记时获得25奥能，每次施放最多一次')],
    elementalist_sky_sequence: [row('每种已有元素印记使本次防御结算后的伤害提高10%，最多40%；命中后消耗全部已有印记'), state('按引爆前的印记施加对应效果', '元素反应', `火：灼烧${value('burn', 5)}%最大生命${turns('burn', 2)}回合；冰：速度降低${value('slow', 25)}%${turns('slow', 1)}回合；风：命中与闪避降低${value('imbalance', 15)}%${turns('imbalance', 1)}回合；雷：魔防降低${value('magic_shatter', 8)}%${turns('magic_shatter', 2)}回合；异常仍受首领持续伤害与状态抗性规则限制`)],
    spellblade_arcane_thrust: [row('上一项物理行动后，本次魔法直击伤害×1.35')],
    spellblade_phase_guard: [state(`自身闪避属性提高${value('alchemy_evasion', 20)}%，持续${turns('alchemy_evasion', 2)}回合`, '相位格挡', '状态期间首次成功闪避敌方攻击时获得30法刃，触发后移除该资源奖励标记')],
    spellblade_spellbreak_whirl: [], spellblade_starfire_duel: [row('本次击杀目标时，重置自身相位格挡的剩余冷却')],
    nightblade_shadow_mark: [state('命中后施加[追猎标定]3回合，并获得20破绽', '追猎标定', '目标下一次受到施法者自身非标定技能的攻击伤害提高20%，命中兑现后消耗')],
    nightblade_gap_stab: [row('目标同时已有追猎及易伤／破甲／束缚／眩晕之一时，直接伤害×1.36；当前实现为一次攻击结算'), row('追猎且目标已有可触发削弱状态时，命中额外获得20破绽')],
    nightblade_crescent_throat: [row('目标当前生命低于40%时直接伤害×215/175'), state('命中后施加[降疗]2回合', '降疗', '目标受到的治疗降低40%')],
    nightblade_silent_finale: [row('仅能对已有追猎标定的目标施放；自身标记的额外伤害兑现后消耗；本次击杀返还50 MP')],
    venomancer_serpent_kiss: [],
    venomancer_corrosion_mist: [row('命中已有普通中毒的目标时，按毒牙技能当前效果再尝试叠加1层普通剧毒；普通目标最多5层、首领最多3层')],
    venomancer_venom_burst: [row('命中后立即引爆全部剩余普通剧毒：目标最大生命×各层强度×剩余回合之和×60%；首领按每层最多1.5%及40%系数计算，并限制为6%首领最大生命；继续结算毒伤增幅与生命护盾'), state('随后移除全部原普通剧毒，并施加1层1回合剧毒', '剧毒', '普通目标每回合损失5%最大生命，首领1.5%；旧持续时间与层数不会保留')],
    venomancer_thousand_throat: [row('实际命中后额外执行两次本技能on_hit效果，合计三次；各次叠毒受真实状态上限限制'), state('命中后施加[降疗]2回合', '降疗', '普通目标受到的治疗降低60%，首领30%')],
    ranger_grapple_trap: [state('命中后施加[追猎]2回合；首领的冰束缚改为减速30%1回合', '追猎', '该标记强度15%；后续队友命中为施法者返还15筹码，普通束缚与减速按状态抗性结算')],
    ranger_weakness_survey: [state('命中后施加[测绘]2回合，并获得20筹码', '测绘', '全队对该目标的命中属性提高15%、暴击属性提高8%，不直接等于实际命中／暴击概率')],
    ranger_guiding_smoke: [state(`全队闪避属性提高${value('alchemy_evasion', 20)}%，持续${turns('alchemy_evasion', 2)}回合；敌方全体获得[失衡]`, '失衡', `命中与闪避属性各降低${value('imbalance', 15)}%，持续${turns('imbalance', 2)}回合；适用时再按攻势换挡支援倍率结算`)],
    ranger_hundred_hunt: [row('仅能对已有追猎标定的目标施放'), row('实际命中且主段后目标存活时，由另一名物攻最高的存活队友追加一次70%物攻威力追击；没有其他存活队友时，自身补一次35%物攻威力追击，独立结算命中与防御，不递归追加行动')],
    saint_healer_mending_prayer: [state('治疗后为受益者施加[祷言]3回合；治疗前生命低于50%时获得25信念', '祷言', '记录祷言状态与层数；同队晨曦审判者因队友获得祷言取得10信念')],
    saint_healer_absolution_hand: [state('实际净化控制时，为受益者提供10%减伤壁垒1回合，并获得20信念；治疗后施加[祷言]3回合', '祷言', '记录祷言状态与层数；同队晨曦审判者因队友获得祷言取得10信念')],
    saint_healer_resonant_mass: [row(`全队恢复基础为（施法者65%魔攻＋各自5%最大生命）×当前支援专精倍率${number(support)}的生命；实际还结算治疗、受疗和攻势换挡`), regeneration(6, 2), state('治疗前生命低于40%的受益者额外获得[祷言]3回合', '祷言', '记录祷言状态与层数；再生基础6%还加算施法者再生增幅后按适用支援倍率结算')],
    saint_healer_revival_sanctuary: [row(`全队立即恢复基础${number(18 * support)}%最大生命；实际恢复受治疗与支援修正影响，受益对象仅限存活友方`)],
    aegis_watch_bastion: [barrier(15, 2, '选定友方，未指定时取生命比例最低者'), state('受益者获得[控制抗性]2回合', '控制抗性', '控制抗性提高20%，适用时再按攻势换挡支援倍率结算')],
    aegis_shared_vow: [barrier(20, 2, '生命比例最低的两名存活队友'), row('队伍中第一名存活盾卫／战帅／破阵者获得10对应职业资源')],
    aegis_luminous_echo: [barrier(10, 2), regeneration(5, 1), state('每名受益者的壁垒首次承受正伤害后，恢复7%最大生命，仅一次', '光幕回响', '该回流按固定7%最大生命并结算区域恢复修正，触发后移除回响标记')],
    aegis_undying_dome: [barrier(20, 2), state('全队获得[濒危不倒]2回合', '濒危不倒', '期间每人第一次受到致命伤害后保留1生命并移除该状态；不能复活已倒下者')],
    dawn_morning_mark: [state('命中后施加[晨星印记]2回合', '晨星印记', '下一次元素使技能对该目标的直接伤害提高20%，命中兑现后消耗')],
    dawn_exorcism_word: [row('命中后驱散目标1个可普通驱散的增益；成功时全队恢复4%最大魔力并获得25信念')],
    dawn_judgment_litany: [state(`命中后额外施加[易伤]${turns('exposed', 2)}回合`, '易伤', `受到的直击伤害提高${value('exposed', 50)}%`)],
    dawn_daybreak_decree: [row('每个实际命中的目标分别驱散1个可普通驱散增益；每次成功，全队获得8%减伤壁垒1回合，同名壁垒取高值')],
    sharpshoot_snipe: [row('本次命中修正系数提高25%，仍按实际命中规则结算')],
    sharpshoot_volley: [], sharpshoot_wind_arrow: [],
    sharpshoot_headshot: [row('目标当前生命高于60%时，本次命中修正系数提高30%')],
    gunner_cluster: [],
    gunner_minefield: [state(`敌方全体闪避属性降低${value('evasion_down', 20)}%，持续${turns('evasion_down', 2)}回合，并获得[易伤]`, '易伤', `受到的直击伤害提高${value('exposed', 20)}%，持续${turns('exposed', 2)}回合`), row('布设完成获得15弹片')],
    gunner_artillery: [], gunner_smoke_bomb: [],
    ranger_hunters_mark: [], ranger_trap_barrage: [], ranger_flanking_shot: [],
    ranger_eagle_eye: [state('按当前在场林伴回应，全队增益2回合，敌方干扰1回合；所有存活林伴恢复30%最大生命', '林野同契', '雾枭：全队命中属性+20%、速度+15%，全体敌人雾标12%；栗影：全队闪避+12%、速度+15%，全体敌人减速15%；青鳞：全体敌人叠1层青鳞毒2回合、易伤15%。对应林伴不在场则该部分不生效；三伴俱在时上述数值提高50%，雾标仍为12%'), state('青鳞回应时叠加[青鳞毒]', '青鳞毒', '普通目标每层每回合损失3%最大生命，最多3层；首领每层1%、最多2层；独立于普通中毒，不触发蚀毒师被动')]
  };
  const result: CombatEffectDetail[] = [];
  const companion = wardenCompanionBySkill(code);
  if (companion) {
    result.push(row(`召唤林伴〖${companion.name}〗；已在场时恢复其全部生命，离场后可重新召唤`));
    result.push(row(`林伴基础最大生命为自身${number(companion.statScale.hp * 100)}%；拥有林巡被动时继承属性额外提高20%。林伴不独立行动，通常单体攻击不点名，首领点名与范围攻击仍可命中`));
    result.push(row('召唤本身不造成直接伤害；林伴生效后的职责效果按当前在场状态结算'));
  } else {
    const power = Number(source.actualPower ?? spec?.power ?? aoeSkillPower(code, Number(source.power ?? newSkills.get(code)?.power ?? 0)));
    if (power > 0 && ['physical', 'magic'].includes(source.category)) {
      const target = ['全体', 'all_enemies'].includes(String(source.target_scope)) ? '敌方全体' : '目标';
      result.push(row(`对${target}造成${number(power)}%威力的${source.element && source.element !== '无' ? source.element + '属性' : ''}${source.category === 'magic' ? '魔法' : '物理'}伤害`));
    }
  }
  result.push(...(map[code] ?? []));
  if (code.startsWith('sharpshoot_')) result.push(row('本职技能实际命中获得12专注，暴击再获得15；远程命中后目标生命仍高于60%时再获得20专注'));
  if (code.startsWith('gunner_') && source.category !== 'utility') result.push(row('本职技能每次实际命中获得12弹片，暴击再获得15，范围技能命中每个目标再获得8'));
  if (['stringblade_shot', 'stringblade_slash', 'stringblade_cross'].includes(code)) result.push(state('远近攻击实际交替时直接伤害×1.10，持有收弦时改为×1.25', '锋线', '成功交替命中获得1锋线，最多4层；未交替的穿心矢／贴身断弦命中会损失1层已有锋线；实际命中后更新上次远近模式并清除收弦'));
  const resource = advancedSkillResourceRequirements[code];
  if (resource) result.unshift(row(`施放额外消耗${resource.amount}${advancedResourceDefinitions[resource.professionCode]?.name ?? '职业资源'}；该资源仅在本场PvE战斗内保留`));
  // The spirit definitions are the runtime-selected pool, not separate new skills.
  if (code === 'summoner_call') result.push(row(`可选灵体：${spiritDefinitions.map(spirit => spirit.name).join('、')}`));
  return result;
}
