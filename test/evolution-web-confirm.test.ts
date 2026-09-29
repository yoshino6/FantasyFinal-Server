import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('web evolution exposes actual mutation candidates and confirms an onsite toggle once', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/evolution.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const requests = new Map<string, { owner: number; kind: string; snapshot: any; result: any }>();
  let sequence = 0;
  let atLab = false;
  let state = 'deviation';
  let toggles = 0;
  let recalculations = 0;
  const connection = {};
  const uuid = () => `00000000-0000-0000-0000-${String(++sequence).padStart(12, '0')}`;
  const panel = () => ({
    character: { level: 23, experience: 5, realm_stage: 3 },
    profile: { unlocked_level: 23, injection_count: 3, evolution_scale: 2, adaptation_pressure: 1,
      stability: 62, symbiosis_trait_code: null, lineage_marks_json: '{}', final_traits_json: '[]' },
    materials: [{ code: 'evolution_stable_medium', quantity: 3 }], injections: [], injectionNames: {},
    mutations: [{ id: 5, mutation_name: '余像症', body_part: 'eye', mutation_state: state,
      tier: 1, source_injection: 'perception', effect_json: '{"accuracyPct":-3}', description: '效果：偏差' }],
    history: [{ event_type: 'evolution.injected', payload: '{"code":"perception"}', created_at: '2026-09-28' }]
  });
  const core = {
    bodyPartNames: { eye: '眼部' },
    evolutionPanel: async () => panel(),
    evolutionLabSite: async () => ({ unlocked: true, atSite: atLab, target: { id: 'evolution_lab', x: -6, y: 7 } }),
    requireEvolutionLabTarget: async () => {
      if (!atLab) throw new Error('你已经离开该目标坐标，无法继续互动。');
      return { characterId: 7, target: { id: 'evolution_lab', name: '演化研究室' } };
    },
    mutationDetail: async () => panel().mutations[0],
    setMutationPausedInTransaction: async (_connection: unknown, _user: string, mutationId: number, paused: boolean, preview: boolean) => {
      if (!atLab) throw new Error('你已经离开该目标坐标，无法继续互动。');
      if ((paused && state !== 'deviation') || (!paused && state !== 'paused')) throw new Error('变异状态已变化。');
      const quote = { characterId: 7, mutationId, name: '余像症', bodyPart: 'eye', stateBefore: state,
        stateAfter: paused ? 'paused' : 'deviation', paused, effectEnabledBefore: paused, effectEnabledAfter: !paused };
      if (!preview) { state = quote.stateAfter; toggles++; }
      return quote;
    }
  };
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: uuid },
    '../database/pool': { getPool: async () => connection, withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work(connection) },
    '../game/alchemy-journal.service': {
      craftCharacterId: async () => 7,
      createCraftRequest: async (_connection: unknown, owner: number, kind: string, snapshot: any) => {
        const token = uuid(); requests.set(token, { owner, kind, snapshot, result: null }); return token;
      },
      craftRequestFor: async (_connection: unknown, owner: number, kind: string, token: string) => {
        const request = requests.get(token);
        if (!request || request.owner !== owner || request.kind !== kind) throw new Error('Invalid request');
        return request;
      },
      completeCraftRequest: async (sameConnection: unknown, _owner: number, token: string, result: any) => {
        assert.equal(sameConnection, connection); requests.get(token)!.result = result;
      }
    },
    '../game/character.service': { recalculateCharacterStats: async (sameConnection: unknown) => {
      assert.equal(sameConnection, connection); recalculations++;
    } },
    '../game/evolution.service': core
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const service = loaded.exports;

  const remote = await service.evolutionStatus('player');
  assert.deepEqual(remote.mutations[0].availableActions, []);
  assert.equal('effect' in remote.mutations[0], false);
  atLab = true;
  const onsite = await service.evolutionStatus('player');
  assert.deepEqual(onsite.mutations[0].availableActions, ['pause']);
  assert.deepEqual(onsite.mutations[0].effect, { accuracyPct: -3 });
  const preview = await service.previewEvolutionMutation('player', 5, 'pause');
  assert.deepEqual([preview.quote.stateBefore, preview.quote.stateAfter, toggles], ['deviation', 'paused', 0]);
  atLab = false;
  await assert.rejects(service.confirmEvolutionMutation('player', preview.token, preview.idempotencyKey), /离开该目标坐标/);
  atLab = true;
  const settled = await service.confirmEvolutionMutation('player', preview.token, preview.idempotencyKey);
  assert.deepEqual(await service.confirmEvolutionMutation('player', preview.token, preview.idempotencyKey), settled);
  assert.deepEqual([state, toggles, recalculations], ['paused', 1, 1]);
  const resume = await service.previewEvolutionMutation('player', 5, 'resume');
  await service.confirmEvolutionMutation('player', resume.token, resume.idempotencyKey);
  assert.deepEqual([state, toggles, recalculations], ['deviation', 2, 2]);
});
