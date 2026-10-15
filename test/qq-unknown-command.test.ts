import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

type Handler = (ctx: any) => Promise<void>;

// Compile the real modules while supplying every runtime dependency explicitly.
// No server listener, configuration file, database, poller or QQ transport runs.
const load = (path: string, modules: Record<string, any>) => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(Object.hasOwn(modules, name), `Unmocked dependency: ${path}: ${name}`);
    return modules[name];
  }, module, module.exports);
  return module.exports;
};
const forbidden = () => { throw new Error('Unexpected external service call'); };
const disabledService = new Proxy({}, { get: (_, name) => name === '__esModule' ? false : forbidden });

class FakeFormat {
  value: any[] = [];
  static create() { return new FakeFormat(); }
  static createMarkdown() { return new FakeFormat(); }
  static createButtonGroup() { return new FakeFormat(); }
  addText(value: string) { this.value.push({ type: 'MD.text', value }); return this; }
  addNewline() { this.value.push({ type: 'MD.newline' }); return this; }
  addMarkdown(value: FakeFormat) { this.value.push({ type: 'Markdown', value: value.value }); return this; }
  addMarkdownOriginal(value: string) { this.value.push({ type: 'MarkdownOriginal', value }); return this; }
  addButtonGroup(value: FakeFormat) { this.value.push({ type: 'BT.group', value: value.value }); return this; }
  addRow() { this.value.push({ type: 'BT.row', value: [] }); return this; }
  addButton(value: string, data: string, options: any) {
    assert.equal(options.autoEnter, false, 'QQ command buttons must remain manual');
    this.value.at(-1).value.push({ type: 'Button', value, options: { ...options, data } });
    return this;
  }
}

const harness = async () => {
  const posts = new Map<string, Handler>();
  const calls = { dispatch: 0, fallback: 0, defeat: 0, wanted: 0, heartbeat: 0 };
  const responses: any[] = [];
  const sent: any[] = [];
  const events: any[] = [];
  let event: any;
  let capture: { formats: any[][] };
  let gatewayFactory: () => Promise<() => Promise<void>>;
  const noop = () => undefined;
  const alemon = {
    Format: FakeFormat,
    logger: { info: noop, warn: noop, error: noop },
    withEventContext: (_event: any, _next: any, run: () => any) => run(),
    getConfigValue: () => ({}),
    useEvent: () => [event],
    useMessage: () => [{ send: async (message: any) => { sent.push(message); } }],
    Router: { create: () => ({ define: {}, res: (_options: any, factory: any) => { gatewayFactory = factory; } }) },
    defineChildren: (value: any) => value,
    MessageDirect: { create: forbidden },
    ResultCode: { Ok: 0 }
  };
  const format = load('../src/app-api/app-format.ts', {
    '../game/story-illustrations': { appStoryIllustrationFromFormat: () => undefined }
  });
  const facade = load('../src/app-api/app-command.service.ts', {
    alemonjs: alemon,
    './app-format': format,
    '../game/character.service': disabledService,
    '../game/adventure.service': { ...disabledService, chooseTarget: async () => { throw new Error('目标已离开当前位置。'); } },
    '../game/dungeon.service': disabledService,
    '../game/auto-battle.service': disabledService,
    '../database/pool': { getPool: forbidden },
    '../game/message': disabledService,
    '../game/divine-message': disabledService,
    '../game/app-channel.service': disabledService,
    '../game/constants': disabledService,
    '../game/advanced-profession.config': disabledService,
    '../game/story-illustrations': disabledService,
    './social-presentation': disabledService
  });
  const outbox = {
    enqueueNotification: forbidden, ensureNotificationOutbox: forbidden,
    acknowledgeNotification: forbidden, claimNotifications: forbidden, notificationOutboxHealth: forbidden
  };
  const bridge = load('../src/core-command-bridge.ts', {
    alemonjs: alemon,
    './game/use-game-message': { withCoreMessageCapture: (value: any, run: () => any) => { capture = value; return run(); } },
    './app-api/app-format': format,
    './app-api/notification.service': { enqueueWebNotificationForQqUser: forbidden, ensureWebNotificationInbox: forbidden },
    './core/notification/outbox.service': outbox,
    './game/movement-visual': { captureMovementVisual: async (run: () => Promise<any>) => ({ result: await run() }) }
  });
  const routes = new Map([
    ['角色', { config: { path: '角色' } }],
    ['升级技能', { config: { path: '升级技能', schema: { usage: '/升级技能 <编号>' } } }],
    ['开采', { config: { path: '开采' } }]
  ]);
  bridge.registerCoreCommandRouter({
    routes: new Map(['message.create', 'private.message.create'].map(name => [name, { one: routes, two: new Map() }])),
    dispatch: async (value: any) => {
      calls.dispatch++;
      events.push(value);
      if (value.MessageText === '/角色') {
        capture.formats.push([{ type: 'Text', value: '角色资料已打开。' }]);
        return { matched: true };
      }
      if (value.MessageText === '/升级技能') return {
        matched: true, reason: 'validation_failed', eventName: value.name,
        matchedPath: '升级技能', commandKey: '升级技能', validation: { error: '缺少技能编号', usage: '/升级技能 <编号>' }
      };
      if (value.MessageText === '/开采 7') throw new Error('当前位置没有可开采资源。');
      return { matched: false };
    }
  });
  class FakeKoa {
    use() {}
    listen() {
      return { listening: true, once: (name: string, callback: () => void) => { if (name === 'listening') queueMicrotask(callback); } };
    }
  }
  class FakeRouter {
    get() {}
    post(path: string, handler: Handler) { posts.set(path, handler); }
    routes() {}
    allowedMethods() {}
  }
  const api = load('../src/core/api/server.ts', {
    koa: FakeKoa, 'koa-router': FakeRouter, alemonjs: alemon,
    '../../database/pool': { getPool: forbidden },
    '../../app-api/app-command.service': { executeAppCommand: (...args: any[]) => { calls.fallback++; return facade.executeAppCommand(...args); } },
    '../../config/core-api': { getCoreApiConfig: () => ({ enabled: true, serviceToken: 'test-token', maxBodyBytes: 8192, port: 0, listenHost: 'unused' }) },
    '../../contracts/core-api': load('../src/contracts/core-api.ts', {}),
    '../notification/outbox.service': outbox,
    '../../game/group-channel.service': { rememberGroupChannel: async () => { calls.heartbeat++; } },
    '../../game/pvp.service': {
      takePvpDefeatNotice: async () => { calls.defeat++; return null; },
      townPassiveWantedAlert: async () => { calls.wanted++; return null; },
      reservePassiveWarrantNotice: forbidden
    },
    '../../game/message': disabledService,
    '../../response/warrant-notice': disabledService,
    '../../app-api/app-format': format,
    '../../core-command-bridge': bridge
  });
  const state = globalThis as any;
  const previous = state.__fantasyFinalCoreApiServer;
  delete state.__fantasyFinalCoreApiServer;
  try { await api.startCoreApiServer(); }
  finally {
    if (previous === undefined) delete state.__fantasyFinalCoreApiServer;
    else state.__fantasyFinalCoreApiServer = previous;
  }
  const invoke = async (path: string, body: any) => {
    const raw = JSON.stringify(body);
    const ctx: any = {
      get: (name: string) => name === 'authorization' ? 'Bearer test-token' : name === 'x-request-id' ? body.requestId ?? '' : '',
      req: { async *[Symbol.asyncIterator]() { yield Buffer.from(raw); } }
    };
    assert.ok(posts.has(path), `Route exists: ${path}`);
    await posts.get(path)!(ctx);
    assert.notEqual(ctx.status, 400);
    responses.push(ctx.body);
    return ctx.body;
  };
  const gateway = (path: string, prefix: string) => {
    const { CoreApiError } = load('../src/qq-gateway/core-client.ts', {});
    load(path, {
      alemonjs: alemon,
      'node:crypto': { randomUUID: () => 'test-random-id' },
      './core-client': { CoreApiError, CoreClient: class {
        command(body: any) { return invoke(`${prefix}/commands`, body); }
        heartbeat(body: any) { return invoke(`${prefix}/conversations/heartbeat`, body); }
      } },
      './renderer': load('../src/qq-gateway/renderer.ts', { alemonjs: alemon }),
      './notification-poller': { NotificationPoller: class { start() {} } }
    });
    return async (command: string, scope: 'private' | 'group', id: string) => {
      event = { MessageText: command, MessageId: id, current: { UserId: 'qq-user', UserName: '玩家', BotId: 'test-bot', IsPrivate: scope === 'private', ...(scope === 'group' ? { ChannelId: 'test-group' } : {}) } };
      await (await gatewayFactory!())();
      return responses.at(-1);
    };
  };
  return { calls, sent, events, facade, gateway };
};

test('App unsupported-command help remains available unless silence is requested', async () => {
  const { facade } = await harness();
  const input = { qqUserId: 'qq-user', command: '/不存在的指令' };
  assert.match((await facade.executeAppCommand(input)).text, /App 网关/);
  assert.equal(await facade.executeAppCommand(input, { ignoreUnsupported: true }), undefined);
  assert.match((await facade.executeAppCommand({ ...input, command: '/目标' }, { ignoreUnsupported: true })).text, /目标需要编号/);
});

for (const prefix of ['/api/qqbot/v1', '/internal/v1/qq'] as const) {
  const gatewayPath = '../src/qq-gateway/index.ts';
  test(`unknown group/private commands stay silent via ${prefix}`, async () => {
    const { calls, sent, events, gateway } = await harness();
    const send = gateway(gatewayPath, prefix);
    for (const scope of ['group', 'private'] as const) {
      for (const [index, command] of ['/不存在的指令', '不存在的指令', '/角色不存在', '普通聊天消息', '我我', '/我我'].entries()) {
        const response = await send(command, scope, `${scope}-unknown-${index}`);
        assert.equal(response.ok, true);
        assert.deepEqual(response.messages, [], `${scope}: ${command}`);
      }
    }
    assert.equal(sent.length, 0, 'Unknown commands must never call QQ message.send');
    assert.equal(calls.defeat, 0, 'Unknown commands must not consume pending defeat notices');
    assert.equal(calls.wanted, 0, 'Unknown commands must not claim wanted notices');
    assert.equal(calls.heartbeat, 6, 'Group presence heartbeat remains independent of command recognition');
    assert.deepEqual(new Set(events.map(value => value.name)), new Set(['message.create', 'private.message.create']));
    const before = { ...calls };
    await send('/不存在的指令', 'group', 'group-unknown-0');
    assert.equal(calls.dispatch, before.dispatch, 'Cached silent requests must not dispatch again');
    assert.equal(calls.fallback, before.fallback, 'Cached silent requests must not retry the App facade');
    assert.equal(sent.length, 0);
  });

  test(`registered replies, help, errors and App compatibility commands still reply via ${prefix}`, async () => {
    const { calls, sent, gateway } = await harness();
    const send = gateway(gatewayPath, prefix);
    for (const [index, command, expected] of [
      [0, '/角色', '角色资料已打开'],
      [1, '/升级技能', '缺少技能编号'],
      [2, '/NPC忽略', '你暂时忽略了这位域民'],
      [3, '/目标', '目标需要编号'],
      [4, '/开采 7', '当前位置没有可开采资源'],
      [5, '/目标 7', '目标已离开当前位置']
    ] as const) {
      await send(command, index % 2 ? 'private' : 'group', `known-${index}`);
      assert.equal(sent.length, index + 1, command);
      assert.ok(JSON.stringify(sent.at(-1)).includes(expected), command);
    }
    assert.equal(calls.defeat, 4, 'Successful registered and App compatibility commands retain passive notice processing');
    assert.equal(calls.wanted, 2);
    const before = { ...calls };
    await send('/角色', 'group', 'known-0');
    assert.equal(calls.dispatch, before.dispatch, 'Replayed commands must reuse the cached result');
    assert.equal(calls.fallback, before.fallback);
    assert.equal(calls.defeat, before.defeat, 'Replayed commands must not consume notices twice');
    assert.equal(calls.wanted, before.wanted);
    assert.equal(sent.length, 7, 'A replay can resend the cached reply without executing the command again');
  });
}
