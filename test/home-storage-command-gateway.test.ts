import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('web generic command and command/action reject both home storage writes before Core execution', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/router.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const posts = new Map<string, (context: any) => Promise<void>>();
  let executions = 0;
  const catalog = [
    { id: 'home-storage-deposit', command: '家园放入', args: [], readOnly: false, requiresCharacter: true },
    { id: 'home-storage-withdraw', command: '家园取出', args: [], readOnly: false, requiresCharacter: true }
  ];
  const noop = () => undefined;
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: () => 'uuid' },
    '../config/app-api': { getAppApiConfig: () => ({ enabled: true }) },
    '../game/app-channel.service': { sessionForApp: async () => ({ playerId: 1, displayName: '玩家' }), appSessionQqUser: async () => 'owner' },
    './command-catalog': { findAppCommandById: () => undefined, isAppCommandAllowed: () => false },
    '../core-command-bridge': { listCoreCommandCatalog: () => catalog, executeCoreGameCommand: async () => { executions++; return { matched: true }; } }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => modules[name] ?? new Proxy({}, { get: () => noop }), loaded, loaded.exports);
  loaded.exports.registerAppApiRoutes({
    get: noop,
    delete: noop,
    post: (path: string, handler: (context: any) => Promise<void>) => { posts.set(path, handler); }
  }, '/api/web/v1');
  const context = (body: Record<string, unknown>) => {
    const raw = JSON.stringify(body);
    return {
      req: { socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield Buffer.from(raw); } },
      get: (name: string) => name === 'authorization' ? 'Bearer session' : name === 'content-length' ? String(Buffer.byteLength(raw)) : ''
    } as any;
  };

  for (const [command, commandId] of [['/家园放入 3 2', 'home-storage-deposit'], ['/家园取出 3 2', 'home-storage-withdraw']] as const) {
    const raw = context({ command });
    await posts.get('/api/web/v1/command')!(raw);
    assert.equal(raw.status, 400);
    assert.match(raw.body.message, /家园储物查看报价/);
    const action = context({ commandId, mode: 'execute' });
    await posts.get('/api/web/v1/command/action')!(action);
    assert.equal(action.status, 400);
    assert.match(action.body.message, /家园储物查看报价/);
  }
  assert.equal(executions, 0);
});
