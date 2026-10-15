import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('web evolution routes require a session and accept only pause or resume', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/evolution-routes.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const gets = new Map<string, (context: any) => Promise<void>>();
  const posts = new Map<string, (context: any) => Promise<void>>();
  const calls: unknown[][] = [];
  const modules: Record<string, unknown> = {
    '../game/app-channel.service': { appSessionQqUser: async () => 'player' },
    './evolution-progression.service': {
      previewEvolutionProgression: async (...args: unknown[]) => { calls.push(['growth-preview', ...args]); return { token: 't' }; },
      confirmEvolutionProgression: async (...args: unknown[]) => { calls.push(['growth-confirm', ...args]); return { toLevel: 21 }; }
    },
    './evolution.service': {
      evolutionStatus: async (...args: unknown[]) => { calls.push(['status', ...args]); return { profileOpened: true }; },
      evolutionMutation: async (...args: unknown[]) => { calls.push(['detail', ...args]); return { mutation: { id: 5 } }; },
      previewEvolutionMutation: async (...args: unknown[]) => { calls.push(['preview', ...args]); return { token: 't' }; },
      confirmEvolutionMutation: async (...args: unknown[]) => { calls.push(['confirm', ...args]); return { stateAfter: 'paused' }; }
    }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  loaded.exports.registerEvolutionApiRoutes({
    get: (path: string, handler: (context: any) => Promise<void>) => { gets.set(path, handler); },
    post: (path: string, handler: (context: any) => Promise<void>) => { posts.set(path, handler); }
  }, '/api/web/v1', {
    requireSession: async (context: any) => context.authenticated ? { playerId: 1 } : null,
    parseBody: async (context: any) => context.requestBody ?? {},
    apiError: (context: any, status: number, message: string) => { context.status = status; context.body = { ok: false, message }; }
  });
  await gets.get('/api/web/v1/evolution')!({ authenticated: false } as any);
  assert.equal(calls.length, 0);
  const status = { authenticated: true } as any;
  await gets.get('/api/web/v1/evolution')!(status);
  assert.deepEqual(calls[0], ['status', 'player']);
  const detail = { authenticated: true, params: { id: '5' } } as any;
  await gets.get('/api/web/v1/evolution/mutations/:id')!(detail);
  assert.deepEqual(calls[1], ['detail', 'player', 5]);
  const preview = { authenticated: true, params: { id: '5' }, requestBody: { action: 'pause' } } as any;
  await posts.get('/api/web/v1/evolution/mutations/:id/preview')!(preview);
  assert.deepEqual(calls[2], ['preview', 'player', 5, 'pause']);
  const invalid = { authenticated: true, params: { id: '5' }, requestBody: { action: 'archive' } } as any;
  await posts.get('/api/web/v1/evolution/mutations/:id/preview')!(invalid);
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 3);
  const confirm = { authenticated: true, requestBody: { token: 't', idempotencyKey: 'k' } } as any;
  await posts.get('/api/web/v1/evolution/mutations/confirm')!(confirm);
  assert.deepEqual(calls[3], ['confirm', 'player', 't', 'k']);
  assert.deepEqual(confirm.body.refresh, ['summary', 'evolution', 'character']);
  await posts.get('/api/web/v1/evolution/progression/preview')!({ authenticated: false });
  await posts.get('/api/web/v1/evolution/progression/confirm')!({ authenticated: false });
  assert.equal(calls.length, 4);
  const growth = { authenticated: true, requestBody: { kind: 'inject', code: 'conservative' } } as any;
  await posts.get('/api/web/v1/evolution/progression/preview')!(growth);
  assert.deepEqual(calls[4], ['growth-preview', 'player', growth.requestBody]);
  const growthConfirm = { authenticated: true, requestBody: { token: 't', idempotencyKey: 'k' } } as any;
  await posts.get('/api/web/v1/evolution/progression/confirm')!(growthConfirm);
  assert.deepEqual(calls[5], ['growth-confirm', 'player', 't', 'k']);
  assert.deepEqual(growthConfirm.body.refresh, ['summary', 'evolution', 'character', 'inventory']);
});
