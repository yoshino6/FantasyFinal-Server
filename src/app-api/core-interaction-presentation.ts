export type CoreInteractionPresentation = {
  presentation: 'story' | 'interaction' | 'page';
  destination?: 'character' | 'inventory' | 'explore';
  commerce?: { kind: 'bank' | 'guildShop' | 'bookshop' | 'homeShop'; mode?: 'buy' | 'sell'; targetId?: string };
};

/** These entries need the full QQ/Core message and button structure on H5. */
export const coreWindowCommand = (command: string): boolean =>
  /^\/*(?:建筑进入|建筑敲门|坐标互动)(?:\s|$)/.test(command.trim());

const storyCommand = /^\/*(?:注册|询问|选择去向|天堂|恩赐列表|恩赐分页|恩赐搜索|天赋目录|天赋详情|选择恩赐|初行选择|初章|继续剧情|初行公会|初行入会)(?:\s|$)/;

const commerceFor = (command: string): CoreInteractionPresentation['commerce'] => {
  const [key, target, area] = command.trim().replace(/^\/+/, '').split(/\s+/);
  if (key === '钱庄' || key === '建筑进入' && target === 'silver_bell_bank') return { kind: 'bank' };
  if (key === '工会商店' || /^(?:商店购买(?:页)?|商店搜索|商店出售(?:页|搜索)?)$/.test(key)
    || key === '建筑区域' && area === '工会商店') {
    return { kind: 'guildShop', ...(/商店出售/.test(key) ? { mode: 'sell' as const } : { mode: 'buy' as const }),
      ...(key === '建筑区域' && target ? { targetId: target } : {}) };
  }
  if (key === '百味书屋' || /^书屋(?:购买|出售)(?:页|搜索)?$/.test(key) || key === '建筑进入' && target === 'bookshop') {
    return { kind: 'bookshop', ...(/书屋出售/.test(key) ? { mode: 'sell' as const } : { mode: 'buy' as const }) };
  }
  if (key === '百纳居' || key === '建筑进入' && target === 'baina_residence') return { kind: 'homeShop' };
  return undefined;
};

const titlesIn = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap(node => {
    if (Array.isArray(node)) return titlesIn(node);
    if (!node || typeof node !== 'object') return [];
    const entry = node as { type?: string; value?: unknown };
    return entry.type === 'MD.title' && typeof entry.value === 'string'
      ? [entry.value]
      : titlesIn(entry.value);
  });
};

/** Follow the executed button, including page exits from a story dialog. */
export const coreInteractionPresentation = (command: string, formats?: unknown): CoreInteractionPresentation => {
  const key = command.trim().replace(/^\/+/, '').split(/\s/, 1)[0];
  if (['角色', '我'].includes(key)) return { presentation: 'page', destination: 'character' };
  if (['背包', '物品'].includes(key)) return { presentation: 'page', destination: 'inventory' };
  if (['面板', '操作面板', '探索', '寻怪', '战斗', '攻击', '状态', '旅途'].includes(key)) {
    // The opening middleware may intercept exploration and emit a story.
    if (titlesIn(formats).some(title => /^(?:初章·|主线·)/.test(title))) return { presentation: 'story' };
    return { presentation: 'page', destination: 'explore' };
  }
  const titles = titlesIn(formats);
  if (titles.some(title => /^(?:战斗开始|战斗操作|战斗回合|★★★战斗★★★)$/.test(title))) {
    return { presentation: 'page', destination: 'explore' };
  }
  if (storyCommand.test(command.trim()) || titles.some(title => /^(?:初章·|主线·)/.test(title))) {
    return { presentation: 'story' };
  }
  const commerce = commerceFor(command);
  return { presentation: 'interaction', ...(commerce ? { commerce } : {}) };
};
