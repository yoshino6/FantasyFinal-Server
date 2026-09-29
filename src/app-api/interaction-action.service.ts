import { createHash, randomBytes } from 'node:crypto';
import { executeCoreGameCommand, listCoreCommandCatalog, type CoreRouteExecution } from '../core-command-bridge';
import type { CoreCommandRequest } from '../contracts/core-api';
import { appSessionQqUser, type AppSession } from '../game/app-channel.service';
import { formatValueToAppMessage, type AppFormatNode } from './app-format';

const ACTION_TTL_MS = 2 * 60_000;
const RESULT_TTL_MS = 5 * 60_000;
const MAX_BUTTONS_PER_RESULT = 256;
const MAX_STORED_ACTIONS = 10_000;

export type IssuedCoreInteractionButton = {
  label: string;
  actionId: string;
  revision: string;
  expiresAt: string;
};

export type CoreInteractionMessage = {
  text: string;
  markdown?: string;
  /** Button/MD.button command data is removed. Execute only the signed buttons below. */
  format?: AppFormatNode[];
  buttons: IssuedCoreInteractionButton[];
};

export type IssuedCoreInteractionResult = {
  revision: string;
  expiresAt: string;
  messages: CoreInteractionMessage[];
  serverTime: string;
};

export class CoreInteractionActionError extends Error {
  constructor(
    readonly code: 'invalid_action' | 'expired_action' | 'stale_action' | 'used_action' | 'core_unavailable',
    message: string,
    readonly status: number = 409
  ) {
    super(message);
    this.name = 'CoreInteractionActionError';
  }
}

type ActionRecord = {
  actionId: string;
  revision: string;
  playerId: number;
  sessionHash: string;
  qqUserId: string;
  contextKey: string;
  command: string;
  expiresAt: number;
  state: 'ready' | 'running' | 'settled';
  idempotencyKey?: string;
  result?: Promise<IssuedCoreInteractionResult>;
  retainUntil?: number;
};

type ActiveContext = { revision: string; expiresAt: number; claimedActionId?: string };

type IssueInput = {
  session: AppSession;
  /** The bearer credential from the authenticated request; it is only stored as SHA-256. */
  sessionToken: string;
  /** The public command which produced execution. Hidden follow-ups are issued internally. */
  originCommand: string;
  execution: CoreRouteExecution;
  blockWebProtectedWrites?: boolean;
};

type ExecuteInput = {
  session: AppSession;
  sessionToken: string;
  actionId: string;
  revision: string;
  /** Reuse the same key when retrying a request. */
  idempotencyKey: string;
  /** H5 market writes use their durable quote/confirm endpoints. */
  blockWebProtectedWrites?: boolean;
};

type Dependencies = {
  resolveQqUser: (session: AppSession) => Promise<string>;
  executeCore: (request: CoreCommandRequest) => Promise<CoreRouteExecution>;
  publicCoreCommands: () => Array<{ command: string }>;
  now: () => number;
  randomId: () => string;
};

const sessionHash = (token: string): string => createHash('sha256').update(token).digest('hex');
const contextKeyFor = (playerId: number, tokenHash: string, qqUserId: string): string =>
  createHash('sha256').update(`${playerId}\0${tokenHash}\0private\0${qqUserId}`).digest('hex');

const validIdentity = (session: AppSession, token: string): boolean =>
  Number.isSafeInteger(session.playerId) && session.playerId > 0 && token.length >= 16 && token.length <= 4096;

const publicCommandMatches = (raw: string, commands: Array<{ command: string }>): boolean => {
  const command = raw.trim().replace(/^\/+/, '');
  return commands.some(entry => command === entry.command || command.startsWith(`${entry.command} `));
};
const webMarketWriteCommand = (command: string) => /^\/*万叶(?:卖出|求购|撤单)(?:\s|$)/.test(command.trim());
const webSkillWriteCommand = (command: string) => /^\/*(?:学习技能|升级技能|升级专精|链接被动|技能快捷|升级鉴识)(?:\s|$)/.test(command.trim());
const webBankWriteCommand = (command: string) => /^\/*钱庄(?:存入|取出|定存|兑付|提前支取)(?:\s|$)/.test(command.trim());
const webHomeWriteCommand = (command: string) => /^\/*家园(?:改名|购买|回家|出门|放入|取出|升级|扩建|制作|拆除)(?:\s|$)/.test(command.trim());
const webGuildShopWriteCommand = (command: string) => /^\/*(?:购买商品|出售商品)(?:\s|$)/.test(command.trim());
const webBookshopWriteCommand = (command: string) => /^\/*(?:购买书屋物品|出售书屋物品)(?:\s|$)/.test(command.trim());
const webHomeShopWriteCommand = (command: string) => /^\/*百纳居交易(?:\s|$)/.test(command.trim());
const webEvolutionWriteCommand = (command: string) => /^\/*(?:进化注射|进化共生选择|进化定型选择|领取进化委托|提交进化委托|进化变异操作)(?:\s|$)/.test(command.trim());
const webAdvancedProfessionWriteCommand = (command: string) => /^\/*(?:二转闲聊|接受二转|确认切换二转|推进二转|提交二转凭证|开启导师试炼|开始二转旁修|完成二转旁修|切换二转旁修|隐藏二转|隐藏导师操作|二转配置)(?:\s|$)/.test(command.trim());
const webProtectedWriteCommand = (command: string) => webMarketWriteCommand(command) || webSkillWriteCommand(command) || webBankWriteCommand(command) || webHomeWriteCommand(command) || webGuildShopWriteCommand(command) || webBookshopWriteCommand(command) || webHomeShopWriteCommand(command) || webEvolutionWriteCommand(command) || webAdvancedProfessionWriteCommand(command);

type CapturedButton = { label: string; command: string };

/** Read the original Format nodes so a trailing-space prefill button is never executed. */
const capturedButtons = (format: unknown): CapturedButton[] => {
  const buttons: CapturedButton[] = [];
  const visit = (nodes: unknown) => {
    if (!Array.isArray(nodes)) return;
    for (const rawNode of nodes) {
      if (!rawNode || typeof rawNode !== 'object') continue;
      const node = rawNode as AppFormatNode;
      if (node.type === 'BT.group' || node.type === 'BT.row' || node.type === 'Markdown' || node.type === 'MD.row') {
        visit(node.value);
        continue;
      }
      if (node.type !== 'Button' && node.type !== 'MD.button') continue;
      const options = node.options;
      if (options?.type !== undefined && options.type !== 'command') continue;
      const command = typeof options?.data === 'string' ? options.data
        : typeof options?.command === 'string' ? options.command
          : typeof options?.value === 'string' && options.value.startsWith('/') ? options.value : '';
      if (!command || command !== command.trim() || command.length > 4096 || /[\r\n\0]/.test(command)) continue;
      buttons.push({ label: String(node.value ?? '按钮').slice(0, 256), command });
    }
  };
  visit(format);
  return buttons;
};

/** Keep visual nodes, but remove all executable button nodes and their raw commands. */
const safeFormat = (format: unknown): AppFormatNode[] => {
  if (!Array.isArray(format)) return [];
  const nodes: AppFormatNode[] = [];
  for (const raw of format) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as AppFormatNode;
    if (node.type === 'Button' || node.type === 'MD.button' || node.type === 'BT.group' || node.type === 'BT.row' || node.type === 'Select') continue;
    const options = node.options && typeof node.options === 'object'
      ? Object.fromEntries(Object.entries(node.options).filter(([key]) => !['data', 'command', 'action', 'autoEnter'].includes(key)))
      : undefined;
    nodes.push({
      ...(node.type ? { type: node.type } : {}),
      value: Array.isArray(node.value) ? safeFormat(node.value) : node.value,
      ...(options && Object.keys(options).length ? { options } : {})
    });
  }
  return nodes;
};

/**
 * The router calls issue() only after a public Core command has run. A follow-up
 * can be hidden, because execute() obtains it from the previously captured
 * server result rather than accepting a command string from the browser.
 */
export const createCoreInteractionActionService = (overrides: Partial<Dependencies> = {}) => {
  const dependencies: Dependencies = {
    resolveQqUser: appSessionQqUser,
    executeCore: executeCoreGameCommand,
    publicCoreCommands: listCoreCommandCatalog,
    now: Date.now,
    randomId: () => randomBytes(24).toString('base64url'),
    ...overrides
  };
  const actions = new Map<string, ActionRecord>();
  const contexts = new Map<string, ActiveContext>();

  const cleanup = () => {
    const now = dependencies.now();
    for (const [id, action] of actions) {
      if (action.state === 'ready' && action.expiresAt <= now) actions.delete(id);
      else if (action.state === 'settled' && (action.retainUntil ?? 0) <= now) actions.delete(id);
    }
    for (const [key, context] of contexts) if (context.expiresAt <= now) contexts.delete(key);
  };

  const issueFromResult = (
    execution: CoreRouteExecution,
    session: AppSession,
    tokenHash: string,
    qqUserId: string,
    expectedRevision?: string,
    blockWebProtectedWrites = false
  ): IssuedCoreInteractionResult => {
    if (!execution.matched) throw new CoreInteractionActionError('core_unavailable', '本体命令当前不可用。');
    cleanup();
    const now = dependencies.now();
    const key = contextKeyFor(session.playerId, tokenHash, qqUserId);
    const current = contexts.get(key);
    const stale = expectedRevision !== undefined && current?.revision !== expectedRevision;
    const revision = stale ? current?.revision ?? dependencies.randomId() : dependencies.randomId();
    const expiresAt = stale ? current?.expiresAt ?? now : now + ACTION_TTL_MS;
    const formats = Array.isArray(execution.formats) ? execution.formats : [];
    const buttonGroups = formats.map(format => capturedButtons(format).filter(button => !blockWebProtectedWrites || !webProtectedWriteCommand(button.command)));
    const buttonCount = buttonGroups.reduce((sum, group) => sum + group.length, 0);
    if (buttonCount > MAX_BUTTONS_PER_RESULT) throw new CoreInteractionActionError('core_unavailable', '可选操作过多，请重新打开当前互动。');
    if (!stale && actions.size + buttonCount > MAX_STORED_ACTIONS) {
      throw new CoreInteractionActionError('core_unavailable', '互动暂时繁忙，请稍后重试。', 503);
    }
    if (!stale) {
      for (const [id, action] of actions) if (action.contextKey === key && action.state === 'ready') actions.delete(id);
      contexts.set(key, { revision, expiresAt });
    }
    const messages = formats.map((format, index): CoreInteractionMessage => {
      const message = formatValueToAppMessage(format);
      const buttons = stale ? [] : buttonGroups[index]!.map(button => {
        const actionId = dependencies.randomId();
        actions.set(actionId, {
          actionId, revision, playerId: session.playerId, sessionHash: tokenHash,
          qqUserId, contextKey: key, command: button.command, expiresAt, state: 'ready'
        });
        return { label: button.label, actionId, revision, expiresAt: new Date(expiresAt).toISOString() };
      });
      return {
        text: message.text,
        ...(message.markdown ? { markdown: message.markdown } : {}),
        ...(message.format ? { format: safeFormat(message.format) } : {}),
        buttons
      };
    });
    return { revision, expiresAt: new Date(expiresAt).toISOString(), messages, serverTime: new Date(now).toISOString() };
  };

  const issue = async (input: IssueInput): Promise<IssuedCoreInteractionResult> => {
    if (!validIdentity(input.session, input.sessionToken)) throw new CoreInteractionActionError('invalid_action', '互动身份无效。', 401);
    if (!publicCommandMatches(input.originCommand, dependencies.publicCoreCommands())) {
      throw new CoreInteractionActionError('invalid_action', '网页端不支持此互动。', 403);
    }
    const qqUserId = await dependencies.resolveQqUser(input.session);
    if (!qqUserId) throw new CoreInteractionActionError('invalid_action', '互动身份无效。', 401);
    return issueFromResult(input.execution, input.session, sessionHash(input.sessionToken), qqUserId, undefined, input.blockWebProtectedWrites);
  };

  const execute = async (input: ExecuteInput): Promise<IssuedCoreInteractionResult> => {
    if (!validIdentity(input.session, input.sessionToken)
      || !input.actionId || input.actionId.length > 128
      || !input.revision || input.revision.length > 128
      || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128 || /[\r\n\0]/.test(input.idempotencyKey)) {
      throw new CoreInteractionActionError('invalid_action', '互动请求无效。', 400);
    }
    const qqUserId = await dependencies.resolveQqUser(input.session);
    const tokenHash = sessionHash(input.sessionToken);
    const action = actions.get(input.actionId);
    if (!action || action.playerId !== input.session.playerId || action.sessionHash !== tokenHash
      || action.qqUserId !== qqUserId || action.revision !== input.revision) {
      throw new CoreInteractionActionError('invalid_action', '互动已失效，请重新打开当前内容。', 403);
    }
    if (input.blockWebProtectedWrites && webProtectedWriteCommand(action.command)) {
      throw new CoreInteractionActionError('invalid_action', webSkillWriteCommand(action.command)
        ? '请在角色页的技能面板查看消耗并确认操作。'
        : webAdvancedProfessionWriteCommand(action.command)
          ? '请在角色页的职业进阶查看当前试炼，并通过专用确认流程操作。'
        : '请在世界页的万叶联市查看报价并确认交易。', 403);
    }
    if (action.state !== 'ready') {
      if (action.idempotencyKey === input.idempotencyKey && action.result) return action.result;
      throw new CoreInteractionActionError('used_action', '该操作已提交，请刷新当前内容。');
    }
    cleanup();
    if (action.expiresAt <= dependencies.now()) throw new CoreInteractionActionError('expired_action', '互动已过期，请重新打开当前内容。');
    const context = contexts.get(action.contextKey);
    if (!context || context.revision !== action.revision || context.claimedActionId) {
      throw new CoreInteractionActionError('stale_action', '状态已变化，请重新打开当前内容。');
    }
    // Claim synchronously before awaiting the Core handler. Sibling choices and
    // retries with a different idempotency key cannot run the command twice.
    context.claimedActionId = action.actionId;
    action.state = 'running';
    action.idempotencyKey = input.idempotencyKey;
    const result = (async () => {
      const execution = await dependencies.executeCore({
        requestId: `web-interaction:${action.actionId}`,
        actor: { provider: 'app', subject: qqUserId, displayName: input.session.displayName },
        conversation: { scope: 'private', id: qqUserId },
        command: action.command,
        source: 'interaction'
      });
      return issueFromResult(execution, input.session, tokenHash, qqUserId, action.revision, input.blockWebProtectedWrites);
    })();
    action.result = result;
    void result.then(
      () => { action.state = 'settled'; action.retainUntil = dependencies.now() + RESULT_TTL_MS; },
      () => { action.state = 'settled'; action.retainUntil = dependencies.now() + RESULT_TTL_MS; }
    );
    return result;
  };

  return { issue, execute };
};

const coreInteractionActions = createCoreInteractionActionService();

export const issueCoreInteractionActions = coreInteractionActions.issue;
export const executeIssuedCoreInteractionAction = coreInteractionActions.execute;
