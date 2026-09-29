/** 隐藏路线的任务证据；目标必须由真实 PVE 胜利结算记账。 */
export const mapHiddenAdvancedQuests: Record<string, {
  observation: { codes: string[]; name: string; count: number };
  material: { code: string; name: string; count: number };
  proof: { codes: string[]; name: string; count: number };
  lesson: string;
  trialInstruction: string;
}> = {
  sword_shadow: {
    observation: { codes: ['goblin_archer'], name: '哥布林弓箭手', count: 2 },
    material: { code: 'goblin_ear', name: '哥布林耳', count: 3 },
    proof: { codes: ['goblin_assassin'], name: '哥布林刺客', count: 1 },
    lesson: '先看清连续出手的间隙，再面对深林里擅长突然换位的刺客。',
    trialInstruction: '试炼会出现一名陪练。连续四回合命中，转向陪练后再打回原目标；在拭剑期间命中，并用持鞘实际追加连击。'
  },
  titan: {
    observation: { codes: ['stonevein_golem'], name: '石脉傀儡', count: 2 },
    material: { code: 'ridge_core', name: '岩脊核心', count: 3 },
    proof: { codes: ['canyon_overseer'], name: '峡谷监工', count: 1 },
    lesson: '记住石脉的承力方式，再从监工的重击下活着回来。',
    trialInstruction: '需与至少一名真实队友组队。导师与两名陪练须分别造成可入队伤害；观察连续三回合伤势扣血，并实际替队友承受一次单体伤害。'
  },
  spirit_summoner: {
    observation: { codes: ['watermirror_siren'], name: '水镜妖', count: 2 },
    material: { code: 'marsh_heart', name: '雾沼心', count: 3 },
    proof: { codes: ['reed_shaman'], name: '芦荡巫医', count: 1 },
    lesson: '在错乱的回声中分辨不同灵息，再回应芦荡巫医的召唤。',
    trialInstruction: '让攻、守、疗三种职责同时维持连续三回合；其中一只灵体被击破后，支付代价重新召唤并完成指令。'
  },
  master_thief: {
    observation: { codes: ['shell_gull'], name: '拾贝鸥盗', count: 2 },
    material: { code: 'tide_shell', name: '潮壳', count: 3 },
    proof: { codes: ['ebb_acolyte'], name: '退潮祭徒', count: 1 },
    lesson: '先辨认海岸的可取之物，再摸清祭徒藏在潮声里的防备。',
    trialInstruction: '先验出导师不可偷并安全撤手；对普通陪练完成一次合法探囊，取得本场战斗凭证，再将其转为实际战斗收益。陪练不会额外掉落实物。'
  },
  holy_knight: {
    observation: { codes: ['whiteantler_guard'], name: '白角鹿王卫', count: 2 },
    material: { code: 'frost_crystal', name: '霜晶', count: 3 },
    proof: { codes: ['snowline_hunter'], name: '雪线猎官', count: 1 },
    lesson: '见过雪线守卫如何站住前排，再顶住猎官的一轮追击。',
    trialInstruction: '需与至少一名真实队友组队。先后让勇誓和守誓真正作用于队伍，再替队友实际分担一次单体伤害。'
  },
  stringblade: {
    observation: { codes: ['bridge_raider'], name: '悬桥掠夺者', count: 2 },
    material: { code: 'thunder_core', name: '鸣雷石', count: 3 },
    proof: { codes: ['cliff_arbiter'], name: '断崖裁断者', count: 1 },
    lesson: '读懂悬桥两端的射线与近身破绽，再与断崖裁断者交手。',
    trialInstruction: '试炼会出现一名陪练。连续四回合按远程、近战、远程、近战命中，其间主动换一次目标并触发远近交替。'
  }
};
