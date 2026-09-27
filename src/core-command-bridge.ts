import { Format, withEventContext } from 'alemonjs';
import type { CoreCommandRequest } from './contracts/core-api';
import { withCoreMessageCapture } from './game/use-game-message';
import { formatValueToAppMessage } from './app-api/app-format';
import { enqueueNotification } from './core/notification/outbox.service';
import type { AppCommandArgument, AppCommandRisk } from './app-api/command-catalog';

type DispatchRouter = { dispatch: (event: Record<string, unknown>) => Promise<unknown> };

let commandRouter: DispatchRouter | undefined;

export type CoreCommandCatalogEntry = {
  id: string;
  title: string;
  category: 'system' | 'story' | 'explore' | 'battle' | 'character' | 'inventory' | 'social' | 'quest' | 'shop' | 'home' | 'other';
  command: string;
  usage: string;
  description?: string;
  args: AppCommandArgument[];
  schema: { fields: Array<Record<string, unknown>> };
  readOnly: boolean;
  requiresCharacter: boolean;
  risk: AppCommandRisk;
  requiresConfirm?: boolean;
  refresh: string[];
  source: 'core-router';
};

type RegisteredRoute = {
  config?: {
    path?: unknown;
    description?: unknown;
    schema?: { usage?: unknown; args?: unknown };
  };
  importers?: unknown[];
};

const blockedCoreRouteText = /(管理员|管理员命令|管理日志|管理$|权限|全局设置|全局倍率|玩家数据核查|玩家操作|全服玩家核查|地图开关|地图切换|清空背包|恢复注销账号|确认覆盖恢复|注销记录|世界生态管理|世界事件账本|世界内容|测试|调试|刷新(?:小怪|矿产|BOSS|商店|悬赏|迷宫)|重建迷宫|BOSS管理|小怪管理|矿产管理|迷宫管理|BOSS测试|管理员登录|给予权限|撤销权限)/i;
const blockedCoreImporterText = /(response\/admin(?:[/'"`]|$)|world-dynamics-admin|admin-profession-test|hidden[-/]|debug[-/]|(?:^|[/_.-])test(?:[/_.-]|$))/i;

const routeText = (route: RegisteredRoute): string => [
  ...(route.importers ?? []).map(importer => String(importer)),
  String(route.config?.path ?? '')
].join(' ');

const coreRouteIsPublic = (route: RegisteredRoute): boolean => {
  const path = String(route.config?.path ?? '').trim();
  if (!path || blockedCoreRouteText.test(path)) return false;
  return !blockedCoreImporterText.test(routeText(route));
};

const schemaArguments = (schema: { args?: unknown } | undefined): AppCommandArgument[] => {
  const rawArgs = (schema as any)?.args;
  if (!Array.isArray(rawArgs)) return [];
  return rawArgs.map((raw: any, index: number) => {
    const name = String(raw?.name ?? `arg${index + 1}`);
    const rules = Array.isArray(raw?.rules) ? raw.rules : [];
    const typeRule = rules.find((rule: any) => ['enum', 'number', 'rest', 'string'].includes(String(rule?.type ?? '')));
    const type = String(typeRule?.type ?? '') === 'enum'
      ? 'enum'
      : String(typeRule?.type ?? '') === 'number'
        ? 'number'
        : String(typeRule?.type ?? '') === 'rest'
          ? 'rest'
          : 'text';
    const enumValues = Array.isArray(typeRule?.enum) ? typeRule.enum.map((value: unknown) => String(value)) : undefined;
    const required = rules.some((rule: any) => Boolean(rule?.required));
    const min = Number.isFinite(Number(typeRule?.min)) ? Number(typeRule.min) : undefined;
    const max = Number.isFinite(Number(typeRule?.max)) ? Number(typeRule.max) : undefined;
    return {
      name,
      label: String(raw?.label ?? name),
      type,
      ...(required ? { required: true } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(enumValues?.length ? { options: enumValues } : {})
    };
  });
};

const coreCategory = (path: string): CoreCommandCatalogEntry['category'] => {
  if (/(战斗|攻击|防御|逃跑|技能|药剂援助|召唤|异械施放|异械技能|异械目标)/.test(path)) return 'battle';
  if (/(注册|初行|初章|剧情|天堂|女神|道路|公会|冒险者登记|选择去向|恩赐|天赋|问心|世界树|新世界)/.test(path)) return 'story';
  if (/(角色|属性|职业|装备|技能|改性|改名|行迹|育成|天赋)/.test(path)) return 'character';
  if (/(背包|道具|异械|图鉴|物品|材料|装备详情)/.test(path)) return 'inventory';
  if (/(队伍|组队|好友|邮件|聊天|交谈|社交|赠礼)/.test(path)) return 'social';
  if (/(任务|成就|足迹|悬赏|委托|奇遇|事件)/.test(path)) return 'quest';
  if (/(商店|店铺|交易|市场|钱庄|打造|熔铸|重铸|附魔|炼金|分解|构造|购买|出售|卖出|存入|取出)/.test(path)) return 'shop';
  if (/(家园|房间|家具|布置)/.test(path)) return 'home';
  if (/(探索|地图|移动|前往|NPC|域民|建筑|开采|迷宫|天气|附近|感知|坐标|目标)/.test(path)) return 'explore';
  return 'system';
};

const routeReadOnly = (path: string): boolean => !/(选择|确认|提交|领取|删除|丢弃|使用|穿戴|卸下|创建|加入|退出|购买|出售|卖出|存入|取出|打造|炼制|熔铸|重铸|附魔|分解|构造|兑换|升级|学习|改名|改性|设置|操作|移动|前往|进入|开采|攻击|防御|逃跑|施放|召唤|领取|接取|参与|协作|答题|选择|跳过|注销|生效|解除|配置设置|配置确认|配置取消)/.test(path);

const routeRisk = (path: string, readOnly: boolean): AppCommandRisk => {
  if (/(战斗|攻击|防御|逃跑|技能|药剂|召唤|异械施放|异械技能|异械目标)/.test(path)) return 'combat';
  if (/(NPC|域民|建筑|奇遇|对话|交谈|公会|迷宫|世界树|进入)/.test(path)) return 'interaction';
  return readOnly ? 'read' : 'write';
};

const routeNeedsCharacter = (path: string): boolean => !/(^(菜单|help|hello|注册|询问|选择去向|天堂|初行|初章|道路|女神|公会|冒险者登记|恩赐|天赋目录|天赋详情)|注册|初行|初章)/i.test(path);

const routeRefresh = (path: string, category: CoreCommandCatalogEntry['category']): string[] => {
  const regions = new Set<string>();
  if (category === 'character') regions.add('summary');
  if (category === 'inventory' || /(装备|道具|材料|背包|图鉴)/.test(path)) regions.add('inventory');
  if (category === 'battle' || /(攻击|防御|技能|召唤|异械施放|逃跑)/.test(path)) regions.add('battle');
  if (category === 'explore' || /(地图|移动|前往|探索|开采|NPC|建筑|坐标|目标)/.test(path)) { regions.add('summary'); regions.add('nearby'); }
  if (category === 'social') regions.add(/邮件/.test(path) ? 'mail' : 'party');
  if (category === 'story' || /(剧情|初行|初章|天堂|女神)/.test(path)) regions.add('story');
  return [...regions];
};

const routeToCatalogEntry = (route: RegisteredRoute): CoreCommandCatalogEntry | undefined => {
  const path = String(route.config?.path ?? '').trim();
  if (!coreRouteIsPublic(route)) return undefined;
  const args = schemaArguments(route.config?.schema);
  const category = coreCategory(path);
  const readOnly = routeReadOnly(path);
  const risk = routeRisk(path, readOnly);
  const usage = String(route.config?.schema?.usage ?? '').trim() || `/${path}`;
  const fields = args.map(argument => ({
    key: argument.name,
    label: argument.label,
    type: argument.type === 'text' ? 'string' : argument.type,
    ...(argument.required !== undefined ? { required: argument.required } : {}),
    ...(argument.min !== undefined ? { min: argument.min } : {}),
    ...(argument.max !== undefined ? { max: argument.max } : {}),
    ...(argument.options ? { options: argument.options.map(option => ({ label: option, value: option })) } : {})
  }));
  return {
    id: `core.${path}`,
    title: path,
    category,
    command: path,
    usage,
    ...(route.config?.description ? { description: String(route.config.description) } : {}),
    args,
    schema: { fields },
    readOnly,
    requiresCharacter: routeNeedsCharacter(path),
    risk,
    ...(!readOnly && /(删除|丢弃|领取|使用|购买|出售|卖出|存入|取出|打造|炼制|熔铸|重铸|附魔|分解|构造|兑换|升级|学习|改名|改性|设置|注销|确认覆盖|恢复)/.test(path) ? { requiresConfirm: true } : {}),
    refresh: routeRefresh(path, category),
    source: 'core-router'
  };
};

/** 从已注册的 Alemon Router 读取实际 path/schema；管理、测试、隐藏路由在此处剔除。 */
export const listCoreCommandCatalog = (): CoreCommandCatalogEntry[] => {
  if (!commandRouter) return [];
  const routeMap = new Map<string, RegisteredRoute>();
  const routesByEvent = (commandRouter as any).routes;
  if (!(routesByEvent instanceof Map)) return [];
  for (const eventRoutes of routesByEvent.values()) {
    for (const route of [...(eventRoutes?.one?.values?.() ?? []), ...(eventRoutes?.two?.values?.() ?? [])] as RegisteredRoute[]) {
      const path = String(route?.config?.path ?? '').trim();
      if (path && !routeMap.has(path)) routeMap.set(path, route);
    }
  }
  return [...routeMap.values()]
    .map(routeToCatalogEntry)
    .filter((entry): entry is CoreCommandCatalogEntry => Boolean(entry))
    .sort((left, right) => left.command.localeCompare(right.command, 'zh-CN'));
};

/** 在游戏本体加载完整 Router 后注册给 Core API 使用。 */
export const registerCoreCommandRouter = (router: DispatchRouter) => {
  commandRouter = router;
};

export type CoreRouteExecution = {
  matched: boolean;
  result: any;
  formats: unknown[][];
};

const validationFormat = (router: DispatchRouter, result: any) => {
  const routes = (router as any).routes?.get?.(result.eventName);
  const entry = routes?.one?.get?.(result.matchedPath) ?? routes?.two?.get?.(result.matchedPath);
  const config = entry?.config;
  const lines = [`我已经识别到你想用的是 \`${result.commandKey ?? result.matchedPath ?? ''}\`。`, result.validation?.error || '这条指令的参数还不完整。'];
  if (config?.description) lines.push(String(config.description));
  if (result.validation?.usage) lines.push(`你可以这样输入：\`${result.validation.usage}\``);
  else if (result.commandKey) lines.push(`请继续补全 \`${result.commandKey}\` 所需的参数。`);
  const args = Array.isArray(config?.schema?.args) ? config.schema.args : [];
  if (args.length) {
    lines.push('参数说明：');
    for (const [index, arg] of args.entries()) {
      const rules = Array.isArray(arg?.rules) ? arg.rules : [];
      const required = rules.some((rule: any) => rule?.required) ? '必填' : '可选';
      const type = rules.find((rule: any) => rule?.type)?.type;
      const typeText = type === 'number' ? '数字' : type === 'enum' ? `枚举: ${(rules.find((rule: any) => rule?.type)?.enum ?? []).join(' / ')}` : type === 'rest' ? '剩余文本' : '文本';
      lines.push(`参数「${arg?.name || `第${index + 1}个参数`}」：${required}，${typeText}`);
    }
  }
  const markdown = Format.createMarkdown();
  lines.forEach((line, index) => { if (index) markdown.addNewline(); markdown.addText(line); });
  return Format.create().addMarkdown(markdown).value as unknown[];
};

/**
 * 复用原版 index.ts Router 与 response handler。这里只构造一个没有 QQ
 * 适配器的事件上下文，消息由 useGameMessage 的捕获层收集为 Format.value。
 */
export const executeCoreGameCommand = async (request: CoreCommandRequest): Promise<CoreRouteExecution> => {
  if (!commandRouter) return { matched: false, result: { reason: 'router_unavailable' }, formats: [] };
  const router = commandRouter;
  const conversation = request.conversation;
  const scope = conversation?.scope === 'group' || conversation?.scope === 'channel' ? conversation.scope : 'private';
  const isPrivate = scope === 'private';
  const id = conversation?.id || request.actor.subject;
  const eventName = request.source === 'interaction'
    ? (isPrivate ? 'private.interaction.create' : 'interaction.create')
    : (isPrivate ? 'private.message.create' : 'message.create');
  const event: Record<string, unknown> = {
    name: eventName,
    Platform: 'qq-bot',
    MessageText: request.command,
    MessageId: request.requestId,
    UserId: request.actor.subject,
    UserKey: request.actor.subject,
    UserName: request.actor.displayName || request.actor.subject,
    BotId: conversation?.botId || 'core-api',
    IsPrivate: isPrivate,
    ChannelId: isPrivate ? undefined : id,
    GuildId: scope === 'channel' ? id : undefined,
    GroupId: scope === 'group' ? id : undefined,
    SpaceId: scope === 'group' ? `GROUP:${id}` : scope === 'channel' ? `GUILD:${id}` : undefined,
    Target: { scope: isPrivate ? 'c2c' : scope, targetId: id, BotId: conversation?.botId || 'core-api' },
    CreateAt: Date.now()
  };
  let lateSequence = 0;
  const capture = {
    formats: [] as unknown[][],
    closed: false,
    late: async (format: unknown[]) => {
      if (!conversation?.botId) return;
      const message = formatValueToAppMessage(format);
      await enqueueNotification({
        dedupeKey: `core-command:${request.requestId}:late:${++lateSequence}`,
        provider: 'qq', botId: conversation.botId,
        scope: isPrivate ? 'private' : scope, targetId: id, actorId: request.actor.subject,
        messages: [{
          kind: 'markdown', text: message.text,
          ...(message.markdown ? { markdown: message.markdown } : {}),
          ...(message.format ? { format: message.format } : {}),
          ...(message.buttons.length ? { buttons: message.buttons.map(button => ({ ...button, execution: 'manual' as const })) } : {})
        }]
      });
    }
  };
  const result = await (withEventContext as any)(
    event,
    async () => undefined,
    () => withCoreMessageCapture(capture, () => router.dispatch(event)),
    { appName: 'fantasyfinal-core', phase: 'route' }
  );
  if (result?.reason === 'validation_failed') {
    (withEventContext as any)(event, async () => undefined, () => capture.formats.push(validationFormat(router, result)), { appName: 'fantasyfinal-core', phase: 'route' });
  }
  capture.closed = true;
  return { matched: Boolean(result?.matched), result, formats: capture.formats };
};
