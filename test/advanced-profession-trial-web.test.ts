import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('web mentor trial starts atomically and a durable key replays without opening another battle', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/advanced-profession-trial.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  type Request = { character_id: number; kind: string; state: string; snapshot_json: string; result_json: string };
  type State = { stage: number; atMentor: boolean; spawnId: number | null; activeSession: string | null;
    spawnCreates: number; battles: number; requests: Map<string, Request> };
  let state: State = { stage: 2, atMentor: true, spawnId: null, activeSession: null,
    spawnCreates: 0, battles: 0, requests: new Map() };
  let draft: State;
  let chooseFails = false;
  const connection = { execute: async (sql: string, args: unknown[] = []) => {
    if (sql.includes('FROM player_craft_requests WHERE token=')) {
      const row = draft.requests.get(String(args[0])); return [row ? [row] : []];
    }
    if (sql.includes('FROM combat_members cm JOIN combat_sessions cs')) {
      return [draft.activeSession && Number(args[0]) === 7 && args[2] === 'war_lord'
        ? [{ session_id: draft.activeSession, spawn_id: draft.spawnId }] : []];
    }
    if (sql.includes('INSERT INTO player_craft_requests')) {
      const [token, characterId, kind, snapshot, result] = args;
      assert.equal(String(kind).length <= 24, true);
      assert.equal(draft.requests.has(String(token)), false);
      draft.requests.set(String(token), { character_id: Number(characterId), kind: String(kind),
        state: 'complete', snapshot_json: String(snapshot), result_json: String(result) });
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const modules: Record<string, unknown> = {
    '../database/pool': { withTransaction: async (work: (connection: unknown) => Promise<unknown>) => {
      draft = { ...state, requests: new Map(state.requests) };
      const result = await work(connection);
      state = draft;
      return result;
    } },
    '../game/alchemy-journal.service': {
      craftCharacterId: async (_connection: unknown, user: string) => user === 'owner' ? 7 : 8,
      craftJson: (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value
    },
    '../game/advanced-profession.config': { advancedProfessionByCode: (code: string) =>
      code === 'war_lord' || code === 'elementalist' ? { code } : undefined },
    '../game/advanced-profession.service': { beginAdvancedProfessionTrialInTransaction: async (coreConnection: unknown, _user: string, code: string) => {
      assert.strictEqual(coreConnection, connection);
      if (!draft.atMentor) throw new Error('请前往世界树导师处。');
      if (draft.stage !== 3) throw new Error('请先完成前两段试炼。');
      if (code !== 'war_lord') throw new Error('职业路线不匹配。');
      if (!draft.spawnId) { draft.spawnId = 42; draft.spawnCreates++; }
      return { spawnId: draft.spawnId, profession: { code } };
    } },
    '../game/adventure.service': { chooseTargetInTransaction: async (coreConnection: unknown) => {
      assert.strictEqual(coreConnection, connection);
      if (chooseFails) throw new Error('队伍当前无法进入战斗。');
      draft.activeSession = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      draft.battles++;
      return { sessionId: draft.activeSession };
    } }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const start = loaded.exports.startWebAdvancedProfessionTrial;
  const firstKey = '11111111-1111-4111-8111-111111111111';
  const secondKey = '22222222-2222-4222-8222-222222222222';
  const thirdKey = '33333333-3333-4333-8333-333333333333';

  await assert.rejects(start('owner', 'war_lord', 'bad-key'), /编号无效/);
  await assert.rejects(start('owner', 'war_lord', firstKey), /前两段/);
  state.stage = 3; state.atMentor = false;
  await assert.rejects(start('owner', 'war_lord', firstKey), /世界树/);
  state.atMentor = true; chooseFails = true;
  await assert.rejects(start('owner', 'war_lord', firstKey), /无法进入战斗/);
  assert.deepEqual([state.spawnId, state.spawnCreates, state.battles, state.requests.size], [null, 0, 0, 0]);

  chooseFails = false;
  const started = await start('owner', 'war_lord', firstKey);
  assert.deepEqual([started.kind, started.spawnId, started.sessionId],
    ['battle_started', 42, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
  assert.deepEqual([state.spawnCreates, state.battles, state.requests.size], [1, 1, 1]);
  await assert.rejects(start('intruder', 'war_lord', firstKey), /已被使用/);
  await assert.rejects(start('owner', 'elementalist', firstKey), /已被使用/);
  const replay = await start('owner', 'war_lord', firstKey);
  assert.deepEqual([replay.kind, replay.sessionId, state.battles], ['battle_recovered', started.sessionId, 1]);

  const recovered = await start('owner', 'war_lord', secondKey);
  assert.deepEqual([recovered.kind, recovered.spawnId, state.battles, state.requests.size],
    ['battle_recovered', 42, 1, 2]);
  state.activeSession = null; state.stage = 4;
  const lateReplay = await start('owner', 'war_lord', firstKey);
  assert.deepEqual([lateReplay.kind, lateReplay.sessionId, state.battles], ['battle_recovered', started.sessionId, 1]);
  await assert.rejects(start('owner', 'war_lord', thirdKey), /前两段/);
  assert.equal(state.requests.size, 2);
});
