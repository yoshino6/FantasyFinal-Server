import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import * as presentation from '../src/app-api/core-interaction-presentation';

test('H5 building entry uses public Core messages through both raw and confirmed catalog commands', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/router.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const posts = new Map<string, (context: any) => Promise<void>>();
  const executed: string[] = [];
  let appExecutions = 0;
  let nonce = 0;
  const catalog = ['建筑进入', '建筑敲门', '坐标互动'].map(command => ({
    id: `core.${command}`, command, args: [], requiresCharacter: true, readOnly: command === '坐标互动'
  }));
  const entries = catalog.map(entry => ({ ...entry, id: `app.${entry.command}` }));
  const noop = () => undefined;
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: () => `uuid-${++nonce}` },
    '../config/app-api': { getAppApiConfig: () => ({ enabled: true }) },
    '../game/app-channel.service': { sessionForApp: async () => ({ playerId: 1, displayName: '玩家' }), appSessionQqUser: async () => 'owner' },
    '../game/character.service': { getCharacter: async () => ({ id: 1 }) },
    './command-catalog': { findAppCommandById: (id: string) => entries.find(entry => entry.id === id), isAppCommandAllowed: () => true },
    './app-command.service': { executeAppCommand: async () => { appExecutions++; return { text: '简化面板' }; } },
    './core-interaction-presentation': presentation,
    '../core-command-bridge': {
      listCoreCommandCatalog: () => catalog,
      executeCoreGameCommand: async (request: { command: string }) => { executed.push(request.command); return { matched: true, formats: [] }; }
    },
    './interaction-action.service': {
      issueCoreInteractionActions: async () => ({ presentation: 'interaction', messages: [{ text: 'QQ 原版建筑面板', buttons: [{ label: '前台', actionId: 'signed', revision: 'revision' }] }] })
    }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => modules[name] ?? new Proxy({}, { get: () => noop }), loaded, loaded.exports);
  loaded.exports.registerAppApiRoutes({ get: noop, delete: noop, post: (path: string, handler: any) => posts.set(path, handler) }, '/api/web/v1');
  const context = (body: Record<string, unknown>) => {
    const raw = JSON.stringify(body);
    return {
      req: { socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield Buffer.from(raw); } },
      get: (name: string) => name === 'authorization' ? 'Bearer session' : name === 'content-length' ? String(Buffer.byteLength(raw)) : ''
    } as any;
  };
  for (const entry of entries) {
    const raw = context({ command: `/${entry.command}` });
    await posts.get('/api/web/v1/command')!(raw);
    assert.equal(raw.body.ok, true);
    assert.equal(raw.body.messages[0].text, 'QQ 原版建筑面板');
    assert.equal(raw.body.buttons[0].actionId, 'signed');
    const action = context({ commandId: entry.id, mode: entry.readOnly ? 'execute' : 'preview' });
    await posts.get('/api/web/v1/command/action')!(action);
    const confirmed = entry.readOnly ? action : context({ commandId: entry.id, mode: 'confirm', token: action.body.confirmToken });
    if (!entry.readOnly) await posts.get('/api/web/v1/command/action')!(confirmed);
    assert.equal(confirmed.body.ok, true);
    assert.equal(confirmed.body.messages[0].text, 'QQ 原版建筑面板');
  }
  assert.equal(appExecutions, 0);
  assert.equal(executed.length, 6);
  const protectedWrite = context({ command: '/购买商品 1 1' });
  await posts.get('/api/web/v1/command')!(protectedWrite);
  assert.equal(protectedWrite.status, 400);
  assert.match(protectedWrite.body.message, /报价并确认交易/);
  assert.equal(executed.length, 6);
});
