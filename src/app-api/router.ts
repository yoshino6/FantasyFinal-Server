import type koaRouter from 'koa-router';
import { randomUUID } from 'node:crypto';
import { getAppApiConfig } from '../config/app-api';
import {
  appSessionQqUser,
  createAppUser,
  loginAppUser,
  logoutAppSession,
  sessionForApp,
  setAppPasswordByPlayerId,
  changeAppPasswordByPlayerId,
  type AppSession
} from '../game/app-channel.service';
import { executeAppCommand, appQuickPanel } from './app-command.service';
import { appCommandCategories, appCommandCatalogFor, findAppCommandById, isAppCommandAllowed, type AppCommandArgument } from './command-catalog';
import { getCharacter } from '../game/character.service';
import { executeCoreGameCommand, listCoreCommandCatalog } from '../core-command-bridge';
import { formatValueToAppMessage } from './app-format';
import {
  acceptPartyApplication,
  applyPartyRecruitment,
  createPartyRecruitment,
  listChatChannels,
  listChatMessages,
  listPartyApplications,
  listPartyRecruitments,
  rejectPartyApplication,
  sendChatMessage,
  issueRealtimeTicket
} from './social.service';
import { friendList, friendRequests, oathReleaseRequests, oathRequests, oathStatus } from '../game/social.service';
import {
  autoBattleConfig,
  autoBattleSkills,
  autoPotionItems,
  deleteAutoBattleAction,
  saveAutoBattleAction,
  setAutoBattleEnabled,
  setAutoPotionEnabled,
  setAutoPotionItem,
  setAutoPotionThreshold,
  toggleAutoBattleEncounterAction,
  type AutoBattleMode
} from '../game/auto-battle.service';

type Context = any;

const secureRequest = (ctx: Context) => {
  const config = getAppApiConfig();
  if (!config.enabled) return false;
  const remote = String(ctx.req?.socket?.remoteAddress ?? '');
  const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  if (loopback.has(remote)) return true;
  return config.allowInsecurePublicHttp === true || String(ctx.get('x-forwarded-proto') ?? '').toLowerCase() === 'https';
};

const apiError = (ctx: Context, status: number, message: string) => {
  ctx.status = status;
  ctx.type = 'application/json';
  ctx.body = { ok: false, message };
};

const parseBody = async (ctx: Context) => {
  const length = Number(ctx.get('content-length') || 0);
  if (length > 64 * 1024) throw new Error('请求体过大。');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of ctx.req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error('请求体过大。');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const result = JSON.parse(text);
    return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
  } catch {
    throw new Error('请求格式无效。');
  }
};

const bearer = (ctx: Context) => {
  const header = String(ctx.get('authorization') ?? '');
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1]!.trim() : '';
};

const requireSession = async (ctx: Context): Promise<AppSession | null> => {
  if (!secureRequest(ctx)) {
    apiError(ctx, 404, '未找到接口。');
    return null;
  }
  const token = bearer(ctx);
  if (!token) {
    apiError(ctx, 401, '缺少访问令牌。');
    return null;
  }
  const session = await sessionForApp(token);
  if (!session) {
    apiError(ctx, 401, '登录已失效，请重新登录。');
    return null;
  }
  return session;
};

const autoBattleMode = (value: unknown): AutoBattleMode => String(value ?? 'pve').toLowerCase() === 'pvp' ? 'pvp' : 'pve';

const autoBattleView = (data: Awaited<ReturnType<typeof autoBattleConfig>>) => ({
  mode: data.mode,
  settings: {
    enabled: Boolean(data.settings?.enabled),
    defaultEncounterAction: data.settings?.default_encounter_action ?? 'battle',
    autoPotionEnabled: Boolean(data.settings?.auto_potion_enabled),
    hpThreshold: Number(data.settings?.hp_threshold ?? 30),
    hpItemId: data.settings?.hp_item_id == null ? null : Number(data.settings.hp_item_id),
    hpItemName: data.settings?.hp_item_name ?? null,
    mpThreshold: Number(data.settings?.mp_threshold ?? 30),
    mpItemId: data.settings?.mp_item_id == null ? null : Number(data.settings.mp_item_id),
    mpItemName: data.settings?.mp_item_name ?? null
  },
  actions: data.actions.map(action => ({ sequence: Number(action.sequence), skillId: action.skillId == null ? null : Number(action.skillId), name: String(action.name) }))
});

type ActionCatalogEntry = {
  id: string;
  command: string;
  args: AppCommandArgument[];
  readOnly: boolean;
  requiresCharacter: boolean;
  refresh?: string[];
};

type PendingCommandAction = {
  playerId: number;
  commandId: string;
  command: string;
  expiresAt: number;
};

const pendingCommandActions = new Map<string, PendingCommandAction>();
const pendingActionTtl = 60_000;

const cleanupPendingCommandActions = () => {
  const now = Date.now();
  for (const [token, item] of pendingCommandActions) if (item.expiresAt <= now) pendingCommandActions.delete(token);
  if (pendingCommandActions.size > 10_000) pendingCommandActions.delete(pendingCommandActions.keys().next().value as string);
};

const actionValues = (entry: ActionCatalogEntry, raw: unknown): { values?: string[]; error?: string } => {
  const objectArgs = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  const arrayArgs = Array.isArray(raw) ? raw : undefined;
  const values: string[] = [];
  for (const [index, argument] of entry.args.entries()) {
    const rawValue = arrayArgs ? arrayArgs[index] : objectArgs?.[argument.name];
    const empty = rawValue === undefined || rawValue === null || String(rawValue).trim() === '';
    if (empty) {
      if (argument.required) return { error: `请填写${argument.label || argument.name}。` };
      values.push('');
      continue;
    }
    const value = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue);
    if (value.length > 4096 || /[\r\n]/.test(value)) return { error: `${argument.label || argument.name}内容无效。` };
    if (argument.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) return { error: `${argument.label || argument.name}必须是数字。` };
      if (argument.min !== undefined && number < argument.min) return { error: `${argument.label || argument.name}不能小于 ${argument.min}。` };
      if (argument.max !== undefined && number > argument.max) return { error: `${argument.label || argument.name}不能大于 ${argument.max}。` };
    }
    if (argument.type === 'enum' && argument.options?.length && !argument.options.includes(value)) {
      return { error: `${argument.label || argument.name}取值不在允许范围内。` };
    }
    values.push(value);
  }
  return { values };
};

const actionCommand = (entry: ActionCatalogEntry, values: string[]): string => {
  let lastValue = -1;
  values.forEach((value, index) => { if (value.trim()) lastValue = index; });
  const args = lastValue < 0 ? [] : values.slice(0, lastValue + 1);
  return [entry.command, ...args].join(' ').trim();
};

const actionMessage = (formats: unknown[][]) => formats.map(format => formatValueToAppMessage(format));

/**
 * 兼容旧版网页按钮发送的纯文本命令。命令必须先出现在动态公开目录中，
 * 因而不会因为这个兼容入口绕过管理、测试或隐藏路由过滤。
 */
const coreEntryForRawCommand = (raw: string) => {
  const command = raw.trim().replace(/^\/+/, '');
  if (!command) return undefined;
  return listCoreCommandCatalog()
    .sort((left, right) => right.command.length - left.command.length)
    .find(entry => command === entry.command || command.startsWith(`${entry.command} `));
};

/** 桌宠 App API；默认保留旧前缀，新客户端使用 /api/desktop/v1。 */
export const registerAppApiRoutes = (router: koaRouter, apiPrefix = '/app-api/v1') => {
  const apiPath = (path: string) => `${apiPrefix}${path}`;

  router.get(apiPath('/health'), async (ctx: Context) => {
    ctx.type = 'application/json';
    ctx.body = { ok: true, service: 'fantasy-final-game-core', time: new Date().toISOString() };
  });

  router.post(apiPath('/register'), async (ctx: Context) => {
    try {
      if (!secureRequest(ctx)) {
        apiError(ctx, 404, '未找到接口。');
        return;
      }
      const body = await parseBody(ctx);
      const displayName = String(body.displayName ?? '').trim();
      if (!displayName) {
        apiError(ctx, 400, '请填写昵称。');
        return;
      }
      const created = await createAppUser(displayName);
      ctx.type = 'application/json';
      ctx.body = {
        ok: true,
        accessToken: created.token,
        uid: created.gameUserId,
        gameUserId: created.gameUserId,
        account: { uid: created.gameUserId, passwordLoginEnabled: false }
      };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '注册失败。');
    }
  });

  router.post(apiPath('/login'), async (ctx: Context) => {
    try {
      if (!secureRequest(ctx)) {
        apiError(ctx, 404, '未找到接口。');
        return;
      }
      const body = await parseBody(ctx);
      const result = await loginAppUser(body.gameId ?? body.uid, body.password);
      ctx.type = 'application/json';
      ctx.body = { ok: true, accessToken: result.token, uid: result.gameUserId, gameUserId: result.gameUserId, account: { uid: result.gameUserId, passwordLoginEnabled: true } };
    } catch (error) {
      apiError(ctx, 401, 'UID 或密码错误。');
    }
  });

  router.post(apiPath('/password/set'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const body = await parseBody(ctx);
      if (String(body.newPassword ?? '') !== String(body.passwordConfirmation ?? '')) {
        apiError(ctx, 400, '两次密码不一致。');
        return;
      }
      const result = await setAppPasswordByPlayerId(session.playerId, body.newPassword);
      ctx.type = 'application/json';
      ctx.body = { ok: true, accessToken: result.token, uid: session.gameUserId, gameUserId: session.gameUserId, passwordLoginEnabled: true, passwordUpdatedAt: new Date().toISOString() };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '设置密码失败。');
    }
  });

  router.post(apiPath('/password/change'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const body = await parseBody(ctx);
      if (String(body.newPassword ?? '') !== String(body.passwordConfirmation ?? '')) {
        apiError(ctx, 400, '两次密码不一致。');
        return;
      }
      const result = await changeAppPasswordByPlayerId(session.playerId, body.currentPassword, body.newPassword);
      ctx.type = 'application/json';
      ctx.body = { ok: true, accessToken: result.token, uid: session.gameUserId, gameUserId: session.gameUserId, passwordLoginEnabled: true, passwordUpdatedAt: new Date().toISOString() };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '修改密码失败。');
    }
  });

  router.post(apiPath('/logout'), async (ctx: Context) => {
    if (!secureRequest(ctx)) {
      apiError(ctx, 404, '未找到接口。');
      return;
    }
    const token = bearer(ctx);
    if (!token) {
      apiError(ctx, 401, '缺少访问令牌。');
      return;
    }
    await logoutAppSession(token);
    ctx.type = 'application/json';
    ctx.body = { ok: true };
  });

  /**
   * H5 命令目录：只返回服务端明确允许公开的玩家命令。
   * 管理、测试、调试和隐藏剧情命令不会从这里暴露，前端也不需要扫描
   * 机器人路由来推断可用能力。
   */
  router.get(apiPath('/command-catalog'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const qqUserId = await appSessionQqUser(session);
      const character = await getCharacter(qqUserId);
      const appCommands = appCommandCatalogFor(Boolean(character));
      const appCommandNames = new Set(appCommands.flatMap(command => [command.command, ...(command.aliases ?? [])]));
      const coreCommands = listCoreCommandCatalog()
        .filter(command => !appCommandNames.has(command.command))
        .map(command => ({
          ...command,
          enabled: !command.requiresCharacter || Boolean(character),
          ...(command.requiresCharacter && !character ? { reason: '请先完成角色注册。' } : {})
        }));
      const coreCategories = [...new Set(coreCommands.map(command => command.category))]
        .filter(category => !appCommandCategories.some(item => item.id === category))
        .map(category => ({ id: category, title: category }));
      ctx.type = 'application/json';
      ctx.body = {
        ok: true,
        version: 1,
        categories: [...appCommandCategories, ...coreCategories],
        commands: [...appCommands, ...coreCommands],
        serverTime: new Date().toISOString()
      };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '读取命令目录失败。');
    }
  });

  /**
   * 结构化命令入口。只接受目录中的 commandId，写操作默认先生成一次性
   * 预览凭据，确认时才把命令交给真实 Router，避免网页按钮直接执行消耗型操作。
   */
  router.post(apiPath('/command/action'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const body = await parseBody(ctx);
      const commandId = String(body.commandId ?? '').trim();
      const appEntry = findAppCommandById(commandId);
      const coreEntry = listCoreCommandCatalog().find(entry => entry.id === commandId);
      const entry = (appEntry ?? coreEntry) as ActionCatalogEntry | undefined;
      if (!entry) {
        apiError(ctx, 400, '网页端不支持此命令。');
        return;
      }
      const qqUserId = await appSessionQqUser(session);
      if (entry.requiresCharacter && !await getCharacter(qqUserId)) {
        apiError(ctx, 400, '请先完成角色注册。');
        return;
      }
      const parsed = actionValues(entry, body.args);
      if (parsed.error || !parsed.values) {
        apiError(ctx, 400, parsed.error ?? '命令参数无效。');
        return;
      }
      const command = actionCommand(entry, parsed.values);
      const mode = String(body.mode ?? (entry.readOnly ? 'execute' : 'preview'));
      cleanupPendingCommandActions();
      if (!entry.readOnly && mode !== 'confirm') {
        if (mode === 'execute') {
          apiError(ctx, 400, '该操作需要先预览，再点击确认执行。');
          return;
        }
        const confirmToken = randomUUID();
        pendingCommandActions.set(confirmToken, {
          playerId: session.playerId,
          commandId,
          command,
          expiresAt: Date.now() + pendingActionTtl
        });
        ctx.type = 'application/json';
        ctx.body = {
          ok: true,
          commandId,
          preview: `将执行：${command}`,
          confirmToken,
          expiresIn: Math.floor(pendingActionTtl / 1000),
          refresh: entry.refresh ?? []
        };
        return;
      }
      if (!entry.readOnly) {
        const confirmToken = String(body.token ?? '').trim();
        const pending = pendingCommandActions.get(confirmToken);
        if (!pending || pending.playerId !== session.playerId || pending.commandId !== commandId || pending.command !== command || pending.expiresAt <= Date.now()) {
          if (confirmToken) pendingCommandActions.delete(confirmToken);
          apiError(ctx, 400, '确认凭据无效或已过期，请重新获取预览。');
          return;
        }
        pendingCommandActions.delete(confirmToken);
      }
      if (coreEntry) {
        const execution = await executeCoreGameCommand({
          requestId: `web-action:${randomUUID()}`,
          actor: { provider: 'app', subject: qqUserId, displayName: session.displayName },
          conversation: { scope: 'private', id: qqUserId },
          command,
          source: 'message'
        });
        if (!execution.matched) {
          apiError(ctx, 400, '本体命令当前不可用。');
          return;
        }
        const messages = actionMessage(execution.formats);
        const first = messages[0] ?? { text: '命令已执行。', buttons: [] };
        ctx.type = 'application/json';
        ctx.body = { ok: true, commandId, command, ...first, messages, refresh: entry.refresh ?? [], serverTime: new Date().toISOString() };
        return;
      }
      const result = await executeAppCommand({ qqUserId, command });
      ctx.type = 'application/json';
      ctx.body = { ok: true, commandId, command, ...result, refresh: entry.refresh ?? [], serverTime: new Date().toISOString() };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '命令执行失败。');
    }
  });

  router.post(apiPath('/command'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const body = await parseBody(ctx);
      const command = String(body.command ?? '').trim();
      if (!command) {
        apiError(ctx, 400, '缺少命令。');
        return;
      }
      if (command.length > 4096 || /[\r\n]/.test(command)) {
        apiError(ctx, 400, '命令内容无效。');
        return;
      }
      const qqUserId = await appSessionQqUser(session);
      if (!isAppCommandAllowed(command)) {
        const coreEntry = coreEntryForRawCommand(command);
        if (!coreEntry) {
          apiError(ctx, 400, '网页端暂不支持此命令。');
          return;
        }
        if (coreEntry.requiresCharacter && !await getCharacter(qqUserId)) {
          apiError(ctx, 400, '请先完成角色注册。');
          return;
        }
        const execution = await executeCoreGameCommand({
          requestId: `web-command:${randomUUID()}`,
          actor: { provider: 'app', subject: qqUserId, displayName: session.displayName },
          conversation: { scope: 'private', id: qqUserId },
          command: command,
          source: 'message'
        });
        if (!execution.matched) {
          apiError(ctx, 400, '本体命令当前不可用。');
          return;
        }
        const messages = actionMessage(execution.formats);
        const first = messages[0] ?? { text: '命令已执行。', buttons: [] };
        ctx.type = 'application/json';
        ctx.body = { ok: true, command, ...first, messages, refresh: coreEntry.refresh ?? [], serverTime: new Date().toISOString() };
        return;
      }
      const result = await executeAppCommand({ qqUserId, command });
      ctx.type = 'application/json';
      ctx.body = { ok: true, ...result, serverTime: new Date().toISOString() };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '命令执行失败。');
    }
  });

  router.get(apiPath('/panel'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    ctx.type = 'application/json';
    ctx.body = { ok: true, ...await appQuickPanel(session) };
  });

  /**
   * H5 自动战斗设置。网页弹窗直接复用 game/auto-battle.service 的校验与事务，
   * 不把设置复制到网页数据库，也不绕过战斗中的装备锁定规则。
   */
  router.get(apiPath('/auto-battle/config'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const qqUserId = await appSessionQqUser(session);
      const config = await autoBattleConfig(qqUserId, autoBattleMode(ctx.query?.mode));
      ctx.type = 'application/json';
      ctx.body = { ok: true, ...autoBattleView(config) };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '读取自动战斗设置失败。');
    }
  });

  router.get(apiPath('/auto-battle/skills'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const qqUserId = await appSessionQqUser(session);
      const page = Math.max(1, Number(ctx.query?.page ?? 1) || 1);
      const keyword = String(ctx.query?.keyword ?? '').trim();
      ctx.type = 'application/json';
      ctx.body = { ok: true, ...(await autoBattleSkills(qqUserId, page, keyword)) };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '读取自动战斗技能失败。');
    }
  });

  router.get(apiPath('/auto-battle/potions'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const qqUserId = await appSessionQqUser(session);
      const page = Math.max(1, Number(ctx.query?.page ?? 1) || 1);
      const keyword = String(ctx.query?.keyword ?? '').trim();
      ctx.type = 'application/json';
      ctx.body = { ok: true, ...(await autoPotionItems(qqUserId, page, keyword)) };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '读取自动药剂失败。');
    }
  });

  router.post(apiPath('/auto-battle/settings'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const body = await parseBody(ctx);
      const qqUserId = await appSessionQqUser(session);
      const mode = autoBattleMode(body.mode);
      const operation = String(body.operation ?? '').trim();
      if (operation === 'enabled') {
        await setAutoBattleEnabled(qqUserId, Boolean(body.enabled), mode);
      } else if (operation === 'potion') {
        await setAutoPotionEnabled(qqUserId, Boolean(body.enabled), mode);
      } else if (operation === 'threshold') {
        const kind = String(body.kind ?? '').toLowerCase() === 'mp' ? 'mp' : 'hp';
        await setAutoPotionThreshold(qqUserId, kind, Number(body.threshold), mode);
      } else if (operation === 'potion-item') {
        const kind = String(body.kind ?? '').toLowerCase() === 'mp' ? 'mp' : 'hp';
        const raw = body.itemId === null || body.itemId === undefined || body.itemId === '' ? null : Number(body.itemId);
        await setAutoPotionItem(qqUserId, kind, raw === null || !Number.isFinite(raw) ? null : raw, mode);
      } else if (operation === 'default-action') {
        // QQBot 当前命令是“切换”语义，网页保留同样的语义，避免出现两套规则。
        if (mode !== 'pve') throw new Error('PVP 不使用默认遇敌决策。');
        await toggleAutoBattleEncounterAction(qqUserId);
      } else {
        throw new Error('未知的自动战斗设置操作。');
      }
      const config = await autoBattleConfig(qqUserId, mode);
      ctx.type = 'application/json';
      ctx.body = { ok: true, ...autoBattleView(config), refresh: ['summary', 'autoBattle'] };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '保存自动战斗设置失败。');
    }
  });

  router.post(apiPath('/auto-battle/actions'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const body = await parseBody(ctx);
      const qqUserId = await appSessionQqUser(session);
      const sequence = Number(body.sequence);
      const rawSkill = body.skillId === null || body.skillId === undefined || body.skillId === '' ? null : Number(body.skillId);
      const skillId = rawSkill === null || !Number.isFinite(rawSkill) || rawSkill === 0 ? null : rawSkill;
      const mode = autoBattleMode(body.mode);
      await saveAutoBattleAction(qqUserId, sequence, skillId, mode);
      const config = await autoBattleConfig(qqUserId, mode);
      ctx.type = 'application/json';
      ctx.body = { ok: true, ...autoBattleView(config), refresh: ['summary', 'autoBattle'] };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '保存自动出招失败。');
    }
  });

  router.delete(apiPath('/auto-battle/actions/:sequence'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const qqUserId = await appSessionQqUser(session);
      const sequence = Number(ctx.params.sequence);
      const mode = autoBattleMode(ctx.query?.mode);
      await deleteAutoBattleAction(qqUserId, sequence, mode);
      const config = await autoBattleConfig(qqUserId, mode);
      ctx.type = 'application/json';
      ctx.body = { ok: true, ...autoBattleView(config), refresh: ['summary', 'autoBattle'] };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '删除自动出招失败。');
    }
  });

  /**
   * 探索方格的即时移动。与 /command 中的“前往坐标”分开，避免网页点击
   * 近处格子时误创建远距离计时行程；具体通行、感知、遭遇和队伍规则由
   * adventure.service 的 moveToLocalCoordinate 统一执行。
   */
  router.post(apiPath('/explore/move'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const body = await parseBody(ctx);
      const x = Number(body.x);
      const y = Number(body.y);
      const z = Number(body.z);
      if (![x, y, z].every(Number.isInteger)) {
        apiError(ctx, 400, '目标坐标必须是三个整数（x、y、z）。');
        return;
      }
      const qqUserId = await appSessionQqUser(session);
      const { moveToLocalCoordinate } = await import('../game/adventure.service');
      const result = await moveToLocalCoordinate(qqUserId, x, y, z) as any;
      const targets = Array.isArray(result.targets)
        ? result.targets.map((target: any) => ({
          type: String(target.type), id: String(target.id), name: String(target.name),
          description: String(target.description ?? '')
        }))
        : undefined;
      ctx.type = 'application/json';
      ctx.body = {
        ok: true,
        kind: String(result.kind ?? 'event'),
        text: String(result.text ?? '你移动到了目标位置。'),
        position: { x, y, z },
        ...(targets ? { interactionTargets: targets } : {}),
        panel: await appQuickPanel(session),
        serverTime: new Date().toISOString()
      };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '移动失败。');
    }
  });

  /** H5 采集入口。网页直接提交资源出生实例 ID，避免把物品 code 误当成资源编号。 */
  router.post(apiPath('/explore/mine'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const body = await parseBody(ctx);
      const resourceId = Number(body.resourceId);
      if (!Number.isSafeInteger(resourceId) || resourceId <= 0) {
        apiError(ctx, 400, '缺少有效的资源编号。');
        return;
      }
      const qqUserId = await appSessionQqUser(session);
      const { mineResource } = await import('../game/adventure.service');
      const result = await mineResource(qqUserId, resourceId);
      const stateText = result.state === 'started' ? '已开始' : result.state === 'mining' ? '正在' : '已完成';
      const text = result.state === 'completed'
        ? `采集结算：${result.rewardText || '本轮没有新的产出。'}`
        : `${stateText}采集【${result.name}】（${result.kind}），每轮约 ${result.seconds ?? 0} 秒，本轮剩余 ${result.remaining ?? 0} 秒。同坐标资源会自动连续采集。`;
      ctx.type = 'application/json';
      ctx.body = { ok: true, kind: result.state, text, resourceId, panel: await appQuickPanel(session), serverTime: new Date().toISOString() };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '无法开始采集。');
    }
  });

  /**
   * H5 遭遇战入口：移动到感知范围内的怪物后，只有玩家明确点击“攻击”
   * 才会锁定目标并创建战斗。这里不读取自动战斗配置，也不代替玩家提交
   * 第一回合行动；战斗面板由返回的 panel.battle 驱动。
   */
  router.post(apiPath('/battle/start'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const body = await parseBody(ctx);
      const spawnId = Number(body.spawnId);
      if (!Number.isSafeInteger(spawnId) || spawnId <= 0) {
        apiError(ctx, 400, '缺少有效的怪物编号。');
        return;
      }
      const qqUserId = await appSessionQqUser(session);
      const { moveToNearbyMonster, chooseTarget } = await import('../game/adventure.service');
      // 目标仍在感知范围时直接突进；已在同格时只做当前位置校验。
      await moveToNearbyMonster(qqUserId, spawnId);
      await chooseTarget(qqUserId, spawnId);
      ctx.type = 'application/json';
      ctx.body = {
        ok: true,
        kind: 'battle_started',
        text: '已进入战斗，请选择本回合行动。',
        panel: await appQuickPanel(session),
        serverTime: new Date().toISOString()
      };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '无法开始战斗。');
    }
  });

  /** H5 遇战中的躲避操作，复用 QQ 端 encounterAction 的感知、速度与退回规则。 */
  router.post(apiPath('/encounter/avoid'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const body = await parseBody(ctx);
      const spawnId = Number(body.spawnId);
      if (!Number.isSafeInteger(spawnId) || spawnId <= 0) {
        apiError(ctx, 400, '缺少有效的怪物编号。');
        return;
      }
      const qqUserId = await appSessionQqUser(session);
      const { encounterAction } = await import('../game/adventure.service');
      const text = await encounterAction(qqUserId, spawnId, 'avoid');
      ctx.type = 'application/json';
      ctx.body = { ok: true, kind: 'avoided', text, spawnId, panel: await appQuickPanel(session), serverTime: new Date().toISOString() };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '无法躲避当前遭遇。');
    }
  });

  /**
   * H5 交涉入口。交涉状态、版本、背包筛选和战斗转场全部复用本体
   * negotiateEncounter，网页只负责展示返回的 negotiation 数据。
   */
  router.post(apiPath('/negotiation'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const body = await parseBody(ctx);
      const spawnId = Number(body.spawnId);
      if (!Number.isSafeInteger(spawnId) || spawnId <= 0) {
        apiError(ctx, 400, '缺少有效的怪物编号。');
        return;
      }
      const rawType = String(body.type ?? 'view');
      const type = ['view', 'talk', 'gift', 'leave', 'fight'].includes(rawType)
        ? rawType as 'view' | 'talk' | 'gift' | 'leave' | 'fight'
        : null;
      if (!type) {
        apiError(ctx, 400, '不支持的交涉操作。');
        return;
      }
      const qqUserId = await appSessionQqUser(session);
      const { negotiateEncounter } = await import('../game/adventure.service');
      const command = {
        type,
        ...(body.sessionId ? { sessionId: String(body.sessionId) } : {}),
        ...(body.revision !== undefined ? { revision: Number(body.revision) } : {}),
        ...(body.itemId !== undefined ? { itemId: Number(body.itemId) } : {}),
        ...(body.quantity !== undefined ? { quantity: Number(body.quantity) } : {}),
        ...(body.page !== undefined ? { page: Number(body.page) } : {}),
        ...(body.keyword !== undefined ? { keyword: String(body.keyword) } : {})
      } as const;
      const negotiation = await negotiateEncounter(qqUserId, spawnId, command);
      ctx.type = 'application/json';
      ctx.body = {
        ok: true,
        kind: negotiation.kind,
        text: negotiation.text,
        negotiation,
        panel: await appQuickPanel(session),
        serverTime: new Date().toISOString()
      };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '交涉暂时无法继续。');
    }
  });

  /** 队伍地图侧栏已经完成一次明确确认后，规划并启动跨区域路线。 */
  router.post(apiPath('/explore/travel'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const body = await parseBody(ctx);
      const x = Number(body.x);
      const y = Number(body.y);
      const z = Number(body.z);
      if (![x, y, z].every(Number.isInteger)) {
        apiError(ctx, 400, '目标坐标必须是三个整数（x、y、z）。');
        return;
      }
      const qqUserId = await appSessionQqUser(session);
      const { moveTo } = await import('../game/adventure.service');
      const planned = await moveTo(qqUserId, x, y, z) as any;
      // 跨区域路线本体仍保留服务层的路线签名校验；侧栏的确认就是网页层的二次确认。
      const result = planned?.kind === 'travel_confirmation'
        ? await moveTo(qqUserId, x, y, z, { confirmationToken: String(planned.token) }) as any
        : planned;
      ctx.type = 'application/json';
      ctx.body = {
        ok: true,
        kind: String(result?.kind ?? 'travel'),
        text: result?.kind === 'travel' ? `已开始前往${result.destinationName ?? result.regionName ?? '目标区域'}，预计 ${result.seconds} 秒。` : String(result?.text ?? '路线已安排。'),
        position: { x, y, z },
        remaining: Number(result?.remaining ?? result?.seconds ?? 0),
        panel: await appQuickPanel(session),
        serverTime: new Date().toISOString()
      };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '前往失败。');
    }
  });

  router.get(apiPath('/realtime-ticket'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    ctx.type = 'application/json';
    ctx.body = { ok: true, ticket: issueRealtimeTicket(session), expiresIn: 60 };
  });

  // H5 社交接口：聊天正文走 REST，前端可按消息 id 增量拉取；队伍招募复用游戏内队伍规则。
  router.get(apiPath('/chat/channels'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      ctx.type = 'application/json';
      ctx.body = { ok: true, channels: await listChatChannels(session) };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '读取聊天频道失败。');
    }
  });

  router.get(apiPath('/chat/channels/:channelId/messages'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const limit = Math.max(1, Math.min(100, Math.floor(Number(ctx.query?.limit ?? 20) || 20)));
      const beforeId = ctx.query?.beforeId;
      const fetched = await listChatMessages(session, String(ctx.params.channelId ?? ''), limit + 1, beforeId);
      const hasMore = fetched.length > limit;
      ctx.type = 'application/json';
      ctx.body = { ok: true, messages: hasMore ? fetched.slice(-limit) : fetched, hasMore };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '读取聊天记录失败。');
    }
  });

  router.post(apiPath('/chat/channels/:channelId/messages'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const body = await parseBody(ctx);
      ctx.type = 'application/json';
      ctx.body = { ok: true, message: await sendChatMessage(session, String(ctx.params.channelId ?? ''), body.content) };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '发送消息失败。');
    }
  });

  // 社交首页摘要：好友与星誓沿用游戏本体关系数据，网页只负责紧凑展示。
  router.get(apiPath('/social/summary'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    if (!session.characterId) {
      ctx.type = 'application/json';
      ctx.body = { ok: true, friends: [], friendRequests: [], oath: null, oathRequests: [], oathReleaseRequests: [] };
      return;
    }
    try {
      const qqUserId = await appSessionQqUser(session);
      const [friends, incomingFriends, oath, incomingOaths, incomingReleases] = await Promise.all([
        friendList(qqUserId),
        friendRequests(qqUserId),
        oathStatus(qqUserId),
        oathRequests(qqUserId),
        oathReleaseRequests(qqUserId)
      ]);
      ctx.type = 'application/json';
      ctx.body = {
        ok: true,
        friends: friends.map(item => ({ name: String(item.name), gameId: Number(item.game_id), status: String(item.status), affinity: Number(item.affinity), stage: String((item.stage as any)?.title ?? item.stage) })),
        friendRequests: incomingFriends.map(item => ({ id: Number(item.id), name: String(item.name), gameId: Number(item.game_id), createdAt: new Date(item.created_at).toISOString() })),
        oath: oath ? { id: Number(oath.id), name: String(oath.name), gameId: Number(oath.game_id), status: String(oath.status), affinity: Number(oath.affinity), stage: String((oath.stage as any)?.title ?? oath.stage) } : null,
        oathRequests: incomingOaths.map(item => ({ id: Number(item.id), name: String(item.name), gameId: Number(item.game_id), affinity: Number(item.affinity), stage: String((item.stage as any)?.title ?? item.stage), expiresAt: new Date(item.expires_at).toISOString() })),
        oathReleaseRequests: incomingReleases.map(item => ({ id: Number(item.id), name: String(item.name), gameId: Number(item.game_id), expiresAt: new Date(item.expires_at).toISOString() }))
      };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '读取社交摘要失败。');
    }
  });

  router.get(apiPath('/party/recruitments'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      ctx.type = 'application/json';
      ctx.body = { ok: true, recruitments: await listPartyRecruitments(session) };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '读取队伍招募失败。');
    }
  });

  router.post(apiPath('/party/recruitments'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const body = await parseBody(ctx);
      ctx.type = 'application/json';
      ctx.body = { ok: true, recruitment: await createPartyRecruitment(session, body) };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '发布队伍招募失败。');
    }
  });

  router.post(apiPath('/party/recruitments/:id/apply'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const body = await parseBody(ctx);
      ctx.type = 'application/json';
      ctx.body = { ok: true, application: await applyPartyRecruitment(session, ctx.params.id, body.message) };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '申请加入队伍失败。');
    }
  });

  // 文档中的复数资源风格别名，保持 /apply 兼容前端快捷调用。
  router.post(apiPath('/party/recruitments/:id/applications'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      const body = await parseBody(ctx);
      ctx.type = 'application/json';
      ctx.body = { ok: true, application: await applyPartyRecruitment(session, ctx.params.id, body.message) };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '申请加入队伍失败。');
    }
  });

  router.get(apiPath('/party/recruitments/:id/applications'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      ctx.type = 'application/json';
      ctx.body = { ok: true, applications: await listPartyApplications(session, ctx.params.id) };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '读取入队申请失败。');
    }
  });

  router.post(apiPath('/party/applications/:id/accept'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      ctx.type = 'application/json';
      ctx.body = { ok: true, application: await acceptPartyApplication(session, ctx.params.id) };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '同意入队申请失败。');
    }
  });

  router.post(apiPath('/party/applications/:id/reject'), async (ctx: Context) => {
    const session = await requireSession(ctx);
    if (!session) return;
    try {
      ctx.type = 'application/json';
      ctx.body = { ok: true, application: await rejectPartyApplication(session, ctx.params.id) };
    } catch (error) {
      apiError(ctx, 400, error instanceof Error ? error.message : '拒绝入队申请失败。');
    }
  });
};
