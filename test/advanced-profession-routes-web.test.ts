import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('web advanced profession routes require a session and expose only supported quest actions', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/advanced-profession-routes.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const calls: unknown[][] = [];
  let panelFails = false;
  let panelSession = 'battle-session';
  const gets = new Map<string, (ctx: any) => Promise<void>>();
  const posts = new Map<string, (ctx: any) => Promise<void>>();
  const router = { get: (path: string, handler: (ctx: any) => Promise<void>) => { gets.set(path, handler); },
    post: (path: string, handler: (ctx: any) => Promise<void>) => { posts.set(path, handler); } };
  const modules: Record<string, unknown> = {
    '../game/app-channel.service': { appSessionQqUser: async () => 'player' },
    './app-command.service': { appQuickPanel: async () => {
      if (panelFails) throw new Error('panel read failed after commit');
      return { battle: { sessionId: panelSession } };
    } },
    './advanced-profession-trial.service': {
      startWebAdvancedProfessionTrial: async (...args: unknown[]) => {
        calls.push(['start_trial', ...args]);
        return { kind: 'battle_started', professionCode: 'war_lord', spawnId: 42, sessionId: 'battle-session' };
      }
    },
    './advanced-profession.service': {
      advancedProfessionStatus: async (...args: unknown[]) => { calls.push(['status', ...args]); return { candidates: [] }; },
      advancedProfessionDetail: async (...args: unknown[]) => { calls.push(['detail', ...args]); return { candidate: { code: 'war_lord' } }; },
      previewAdvancedProfessionAction: async (...args: unknown[]) => { calls.push(['preview', ...args]); return { token: 'token' }; },
      confirmAdvancedProfessionAction: async (...args: unknown[]) => { calls.push(['confirm', ...args]); return { stageAfter: 1 }; }
    }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  loaded.exports.registerAdvancedProfessionApiRoutes(router, '/api/web/v1', {
    requireSession: async (ctx: any) => ctx.authenticated ? { playerId: 7 } : null,
    parseBody: async (ctx: any) => ctx.requestBody ?? {},
    apiError: (ctx: any, status: number, message: string) => { ctx.status = status; ctx.body = { ok: false, message }; }
  });
  await gets.get('/api/web/v1/advanced-professions')!({ authenticated: false });
  assert.equal(calls.length, 0);
  const status: any = { authenticated: true };
  await gets.get('/api/web/v1/advanced-professions')!(status);
  assert.deepEqual(status.body.candidates, []);
  const detail: any = { authenticated: true, params: { code: 'war_lord' } };
  await gets.get('/api/web/v1/advanced-professions/:code')!(detail);
  assert.equal(detail.body.candidate.code, 'war_lord');
  const invalidCode: any = { authenticated: true, params: { code: '../hidden' } };
  await gets.get('/api/web/v1/advanced-professions/:code')!(invalidCode);
  assert.equal(invalidCode.status, 400);
  const preview: any = { authenticated: true, params: { code: 'war_lord' }, requestBody: { action: 'switch_quest' } };
  await posts.get('/api/web/v1/advanced-professions/:code/preview')!(preview);
  assert.equal(preview.body.token, 'token');
  const unsupported: any = { authenticated: true, params: { code: 'war_lord' }, requestBody: { action: 'start_trial' } };
  await posts.get('/api/web/v1/advanced-professions/:code/preview')!(unsupported);
  assert.equal(unsupported.status, 400);
  await posts.get('/api/web/v1/advanced-professions/:code/trial/start')!({ authenticated: false });
  const start: any = { authenticated: true, params: { code: 'war_lord' }, requestBody: { idempotencyKey: 'uuid' } };
  await posts.get('/api/web/v1/advanced-professions/:code/trial/start')!(start);
  assert.deepEqual([start.body.kind, start.body.spawnId, start.body.panel.battle.sessionId],
    ['battle_started', 42, 'battle-session']);
  panelFails = true;
  const retry: any = { authenticated: true, params: { code: 'war_lord' }, requestBody: { idempotencyKey: 'uuid' } };
  await posts.get('/api/web/v1/advanced-professions/:code/trial/start')!(retry);
  assert.deepEqual([retry.body.ok, retry.body.panel], [true, null]);
  panelFails = false;
  panelSession = 'other-session';
  const stalePanel: any = { authenticated: true, params: { code: 'war_lord' }, requestBody: { idempotencyKey: 'uuid' } };
  await posts.get('/api/web/v1/advanced-professions/:code/trial/start')!(stalePanel);
  assert.equal(stalePanel.body.panel, null);
  const confirm: any = { authenticated: true, requestBody: { token: 't', idempotencyKey: 'k' } };
  await posts.get('/api/web/v1/advanced-professions/confirm')!(confirm);
  assert.deepEqual(confirm.body.refresh, ['advanced-professions', 'character', 'inventory', 'map']);
  assert.deepEqual(calls, [['status', 'player'], ['detail', 'player', 'war_lord'],
    ['preview', 'player', 'war_lord', 'switch_quest'], ['start_trial', 'player', 'war_lord', 'uuid'],
    ['start_trial', 'player', 'war_lord', 'uuid'], ['start_trial', 'player', 'war_lord', 'uuid'],
    ['confirm', 'player', 't', 'k']]);
});
