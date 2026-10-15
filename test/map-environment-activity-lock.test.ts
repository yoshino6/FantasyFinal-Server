import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const fixture = (clearingId = 1) => {
  const locked = new Set<number>(), checked: number[] = [], writes: string[] = [];
  const actor = { id: 1, level: 10, current_region_id: 7, region_code: 'baina_town', pos_x: 4, pos_y: 5, pos_z: 0, activity_status: 'active' };
  const target = { ...actor, id: 2 };
  const db = { execute: async (sql: string) => {
    if (/^(?:UPDATE|DELETE|INSERT)/.test(sql)) {
      writes.push(sql);
      if (sql.startsWith('INSERT IGNORE INTO player_talent_state')) return [{ affectedRows: 0 }];
      throw new Error(`Unexpected gameplay mutation: ${sql}`);
    }
    if (sql.includes('FROM characters WHERE id IN')) { assert.match(sql, /FOR UPDATE/); locked.add(1); locked.add(2); return [[actor, target]]; }
    if (sql.includes('FROM characters WHERE game_id=')) { assert.match(sql, /FOR UPDATE/); locked.add(2); return [[target]]; }
    if (sql.includes('FROM characters c JOIN players')) { assert.match(sql, /FOR UPDATE/); locked.add(1); return [[actor]]; }
    if (sql.includes('FROM player_homes')) return [[{ id: 3, plot_x: 4, plot_y: 5, plot_z: 0 }]];
    if (sql.includes("FROM map_regions WHERE code='baina_town'")) return [[{ id: 7 }]];
    if (sql.includes('SELECT code FROM map_regions')) return [[{ code: 'baina_town' }]];
    if (sql.includes('FROM player_talent_events')) return [[]];
    if (sql.includes('SELECT revision FROM player_talent_state')) return [[{ revision: 0 }]];
    throw new Error(`Unexpected fixture query: ${sql}`);
  } };
  const load = (filename: string) => {
    const module = { exports: {} as Record<string, any> };
    const source = readFileSync(new URL(`../src/game/${filename}`, import.meta.url), 'utf8');
    const require = (id: string) => {
      if (id.includes('database/pool')) return { withTransaction: (callback: (db: unknown) => unknown) => callback(db) };
      if (id.includes('map-environment.service')) return { assertEnvironmentIdle: async (_db: unknown, characterId: number) => {
        assert.ok(locked.has(characterId), `character ${characterId} must be locked before checking its job`);
        checked.push(characterId);
        if (characterId === clearingId) throw new Error('正在清理覆苔倒木');
      } };
      if (id.includes('heart-question.service')) return { heartGrowthAdjustment: async () => null };
      if (id.includes('map-hidden-advanced-skills.config')) return { newAdvancedSkillDefinitions: [] };
      if (id.includes('spirit-summoner.config')) return { legacySpiritSummonerSkillCodes: [] };
      if (id.includes('home.service')) return { isInHome: async () => false };
      if (id.includes('talent-data')) return { ownedTalent: async () => ({ number: 'H06' }), emptyTalentData: () => ({}), readTalentData: async () => ({ settings: {}, flags: {}, jobs: [] }) };
      return {};
    };
    new Function('require', 'module', 'exports', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(require, module, module.exports);
    return module.exports;
  };
  return { db, load, checked, writes };
};

test('NPC sparring cannot start combat while the locked actor is clearing an obstacle', async () => {
  const state = fixture();
  await assert.rejects(state.load('npc-sparring.service.ts').startNpcSparring('fixture-user', 'guild_merchant'), /正在清理/);
  assert.deepEqual(state.checked, [1]);
  assert.deepEqual(state.writes, []);
});

for (const entry of ['cityPvp', 'fieldPvp', 'startPvpBattle', 'startAmbushPvpBattle']) {
  for (const clearingId of [1, 2]) test(`${entry} cannot pull clearing participant ${clearingId} into PvP`, async () => {
    const state = fixture(clearingId), service = state.load('pvp.service.ts');
    const args = entry === 'startAmbushPvpBattle' ? [1, 2, 99, {}] : ['fixture-user', 2];
    await assert.rejects(service[entry](...args), /正在清理/);
    assert.ok(state.checked.includes(clearingId));
    assert.equal(state.writes.length, 0);
  });
}

for (const entry of ['enterHome', 'leaveHome']) test(`${entry} preserves clearing job before changing location activity`, async () => {
  const state = fixture(), service = state.load('home.service.ts');
  await assert.rejects(service[entry]('fixture-user'), /正在清理/);
  assert.deepEqual(state.checked, [1]);
  assert.equal(state.writes.length, 0);
});

test('talent activity rejects clearing before changing the talent setting or job', async () => {
  const state = fixture(), service = state.load('talent.service.ts');
  await assert.rejects(service.talentActionWithConnection(state.db, 'fixture-user', 0, '设置', '险采', '开启'), /正在清理/);
  assert.deepEqual(state.checked, [1]);
  assert.ok(state.writes.every(sql => sql.startsWith('INSERT IGNORE INTO player_talent_state')));
});
