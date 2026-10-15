import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

test('growth quotes recheck ownership, location and state; each confirmed reward executes once', async () => {
  let level = 20, onsite = true, date = '2026-10-01', writes = 0, recalculations = 0;
  const requests = new Map<string, any>(); let sequence = 0;
  const uuid = () => `00000000-0000-0000-0000-${String(++sequence).padStart(12, '0')}`;
  const quote = () => ({ kind: 'inject', fromLevel: level, toLevel: level + 1, costs: level === 20 ? {} : { sample: 3 } });
  const modules: Record<string, any> = {
    'node:crypto': { randomUUID: uuid },
    '../database/pool': { withTransaction: async (work: any) => work({}) },
    '../game/alchemy-journal.service': {
      craftCharacterId: async (_: any, user: string) => user === 'player' ? 7 : 8,
      createCraftRequest: async (_: any, owner: number, kind: string, snapshot: any) => {
        assert.ok(kind.length <= 24); const token = uuid(); requests.set(token, { owner, kind, snapshot }); return token;
      },
      craftRequestFor: async (_: any, owner: number, kind: string, token: string) => {
        const row = requests.get(token); if (!row || row.owner !== owner || row.kind !== kind || row.expired && !row.result) throw new Error('凭据已失效'); return row;
      },
      completeCraftRequest: async (_: any, owner: number, token: string, result: any) => { assert.equal(requests.get(token).owner, owner); requests.get(token).result = result; }
    },
    '../game/character.service': { recalculateCharacterStats: async () => { recalculations++; } },
    '../game/evolution.service': {
      requireEvolutionLabTarget: async () => { if (!onsite) throw new Error('请前往研究室'); return { characterId: 7, target: {} }; },
      previewEvolutionInjectionInTransaction: async () => quote(),
      injectEvolutionInTransaction: async () => { const before = level++; writes++; return { toLevel: level, fromLevel: before }; },
      evolutionBusinessDate: () => date,
      acceptEvolutionObservationInTransaction: async (_: any, _user: string, type: string, preview: boolean) => { if (!preview) writes++; return { type, name: '观察' }; },
      claimEvolutionObservationInTransaction: async (_: any, _user: string, preview: boolean) => { if (!preview) writes++; return { name: '报酬', items: { sample: 3 } }; },
      toggleShapingTraitInTransaction: async (_: any, _user: string, id: number, preview: boolean) => { if (!preview) writes++; return { traits: [{ id, mutation_name: '定型' }], selectedIds: [id], required: 1 }; }
    }
  };
  const loaded = { exports: {} as any };
  const source = readFileSync(new URL('../src/app-api/evolution-progression.service.ts', import.meta.url), 'utf8');
  new Function('require', 'module', 'exports', transformSync(source, { loader: 'ts', format: 'cjs' }).code)((name: string) => modules[name] ?? assert.fail(name), loaded, loaded.exports);
  const { previewEvolutionProgression: preview, confirmEvolutionProgression: confirm, evolutionProgressionAction: parse } = loaded.exports;
  assert.throws(() => parse({ kind: 'inject', code: 'admin' }), /针剂/);
  assert.throws(() => parse({ kind: 'inject', code: 'conservative', part: 'head' }), /部位/);
  assert.throws(() => parse({ kind: 'select_trait', mutationId: '1' }), /无效/);
  let p = await preview('player', { kind: 'inject', code: 'conservative' }); assert.equal(writes, 0);
  await assert.rejects(confirm('intruder', p.token, p.idempotencyKey), /失效/);
  await assert.rejects(confirm('player', p.token, uuid()), /不匹配/);
  onsite = false; await assert.rejects(confirm('player', p.token, p.idempotencyKey), /研究室/); onsite = true;
  level++; await assert.rejects(confirm('player', p.token, p.idempotencyKey), /已变化/); level--;
  const result = await confirm('player', p.token, p.idempotencyKey); assert.equal(level, 21); assert.equal(recalculations, 1);
  onsite = false; assert.deepEqual(await confirm('player', p.token, p.idempotencyKey), result); assert.equal(writes, 1); onsite = true;
  p = await preview('player', { kind: 'inject', code: 'conservative' }); requests.get(p.token).expired = true;
  await assert.rejects(confirm('player', p.token, p.idempotencyKey), /失效/);
  for (const action of [{ kind: 'accept_observation', type: 'sample' }, { kind: 'claim_observation' }, { kind: 'select_trait', mutationId: 5 }]) {
    p = await preview('player', action); const before = writes;
    if (action.kind !== 'select_trait') { date = '2026-10-02'; await assert.rejects(confirm('player', p.token, p.idempotencyKey), /已变化/); date = '2026-10-01'; }
    await confirm('player', p.token, p.idempotencyKey); await confirm('player', p.token, p.idempotencyKey);
    assert.equal(writes, before + 1);
  }
});
