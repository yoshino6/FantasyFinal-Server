import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('Core evolution pause and resume require an unlocked onsite lab and preview without mutation', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/game/evolution.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  let stage = 8;
  let hasProfile = true;
  let atLab = false;
  let state = 'deviation';
  let events = 0;
  let operations = 0;
  const connection = {
    execute: async (sql: string, args: unknown[] = []) => {
      if (sql.includes('FROM characters c JOIN players p')) return [[{ id: 7, name: '冒险者', level: 23, experience: 0,
        realm_stage: 3, profession_code: 'warrior', evolution_stage: stage, current_region_id: 1,
        pos_x: -6, pos_y: 7, pos_z: 0 }]];
      if (sql.includes('FROM player_evolution_profiles WHERE character_id=')) return [hasProfile ? [{ character_id: 7 }] : []];
      if (sql.includes("FROM map_npcs WHERE code='evolution_lab'")) return [atLab ? [{ '1': 1 }] : []];
      if (sql.includes('FROM player_mutations') && sql.includes('description NOT LIKE')) return [[]];
      if (sql.includes('FROM player_mutations WHERE id=? AND character_id=?')) return [[{ id: 5, body_part: 'eye',
        mutation_code: 'old_deviation', mutation_name: '余像症', mutation_state: state, tier: 1,
        source_injection: 'perception', effect_json: '{}', description: '效果：偏差' }]];
      if (sql.startsWith('UPDATE player_mutations SET mutation_state=')) { state = sql.includes("mutation_state='paused'") ? 'paused' : 'deviation'; return [{ affectedRows: 1 }]; }
      if (sql.startsWith('INSERT INTO player_events')) { events++; return [{ insertId: events, affectedRows: 1 }]; }
      if (sql.includes('FROM map_npcs n JOIN map_regions r')) return [[{ region_id: 1, region_code: 'world_tree', region_name: '世界树',
        name: '演化研究室', pos_x: -6, pos_y: 7, pos_z: 0 }]];
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const modules: Record<string, unknown> = {
    './achievement-hooks': { achievementLevel: async () => undefined },
    '../database/pool': { getPool: async () => connection, withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work(connection) },
    './constants': { experienceRequiredForLevel: () => 0, realmLevelCap: () => 30 },
    './skill-point-ledger.service': { recordSkillPointChange: async () => undefined },
    './heart-question.service': { createHeartQuestionsForLevels: async () => undefined },
    './character-operation.service': { recordCharacterOperation: async () => { operations++; } },
    './mutation.config': { dynamicDamageMutationCodes: [], dynamicDamageReductionMutationCodes: [], mutationCatalog: [], mutationByCode: new Map() }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const evolution = loaded.exports;

  await assert.rejects(evolution.setMutationPausedInTransaction(connection, 'player', 5, true, true), /离开该目标坐标/);
  atLab = true;
  stage = 7;
  await assert.rejects(evolution.setMutationPausedInTransaction(connection, 'player', 5, true, true), /尚未向你显现/);
  stage = 8;
  hasProfile = false;
  await assert.rejects(evolution.setMutationPausedInTransaction(connection, 'player', 5, true, true), /尚未向你显现/);
  hasProfile = true;
  const site = await evolution.evolutionLabSite('player');
  assert.deepEqual([site.unlocked, site.atSite, site.target.x, site.target.y], [true, true, -6, 7]);
  atLab = false;
  await assert.rejects(evolution.mutationDetail('player', 5), /离开该目标坐标/);
  atLab = true;
  assert.equal((await evolution.mutationDetail('player', 5)).mutation_name, '余像症');
  const pause = await evolution.setMutationPausedInTransaction(connection, 'player', 5, true, true);
  assert.deepEqual([pause.stateBefore, pause.stateAfter, pause.effectEnabledBefore, pause.effectEnabledAfter], ['deviation', 'paused', true, false]);
  assert.deepEqual([state, events, operations], ['deviation', 0, 0]);
  await evolution.setMutationPausedInTransaction(connection, 'player', 5, true);
  assert.deepEqual([state, events, operations], ['paused', 1, 1]);
  await assert.rejects(evolution.setMutationPausedInTransaction(connection, 'player', 5, true, true), /只有偏差型/);
  const resume = await evolution.setMutationPausedInTransaction(connection, 'player', 5, false, true);
  assert.deepEqual([resume.stateBefore, resume.stateAfter, resume.effectEnabledBefore, resume.effectEnabledAfter], ['paused', 'deviation', false, true]);
  await evolution.setMutationPausedInTransaction(connection, 'player', 5, false);
  assert.deepEqual([state, events, operations], ['deviation', 2, 2]);
});
