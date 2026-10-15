import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import type { PoolConnection } from 'mysql2/promise';
import { flushTitanWounds, enqueueTitanWound } from '../src/game/titan-wound';
import { combatUnitLabel } from '../src/game/combat-unit-label';
import { observeSurfaceCombatHp, readSurfaceCombatState, recordSurfaceCombatSettlementIn, type SurfaceCombatState } from '../src/game/map-surface-combat';

const source = readFileSync(new URL('../src/game/adventure.service.ts', import.meta.url), 'utf8');
const section = (start: string, end: string) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `missing production declaration ${start}`);
  return source.slice(a, b);
};
const origin = { scopeKey: 'world:0', regionId: 3, x: -17, y: 8, z: 0 };
const frozen = (): SurfaceCombatState => ({ version: 1, origin: { ...origin }, seed: 123, damage: { blood: 0, slime: 0, debris: 0, magic: 0 } });
const fixture = (options: { mode?: string; state?: string; damage?: number; wounds?: number; withSurface?: boolean; liveMembers?: number; liveTargets?: number; usableTargets?: number } = {}) => {
  const saved = frozen(); saved.damage.blood = options.damage ?? 0;
  const session = { mode: options.mode ?? 'pve', state: options.state ?? 'active', cooldowns: { preservedReward: 42, ...(options.withSurface === false ? {} : { __surfaceCombat: saved }) } as any, combat_id: 'battle-flow', turn_no: 2 };
  const member = { id: 1, name: '离线测试角色', current_region_id: 3, pos_x: -17, pos_y: 8, pos_z: 0, current_hp: 100, hp_max: 100, current_mp: 10, is_defeated: 0, cooldowns: enqueueTitanWound({}, options.wounds ?? 0, 2).cooldowns };
  const marks = new Map<string, any>(), calls: string[] = [];
  const connection = { execute: async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith('SELECT mode,cooldowns')) return [[{ ...session }], []];
    if (sql.startsWith('SELECT mode,state,cooldowns')) return [[structuredClone(session)], []];
    if (sql.includes('AS live_members')) return [[{ live_members: options.liveMembers ?? 1, live_target_rows: options.liveTargets ?? 1, usable_targets: options.usableTargets ?? 1 }], []];
    if (sql.startsWith("UPDATE combat_sessions SET state='defeat'")) { const active = session.state === 'active'; if (active) session.state = 'defeat'; return [{ affectedRows: Number(active) }, []]; }
    if (sql.startsWith('UPDATE combat_sessions SET state=?')) { const active = session.state === 'active'; if (active) session.state = String(values[0]); return [{ affectedRows: Number(active) }, []]; }
    if (sql.startsWith('UPDATE combat_sessions SET cooldowns=JSON_SET')) { session.cooldowns.__surfaceCombat = JSON.parse(String(values[0])); return [{ affectedRows: 1 }, []]; }
    if (sql.startsWith('UPDATE combat_members SET current_hp=') || sql.startsWith('UPDATE characters SET current_hp=') || sql.startsWith('UPDATE player_companions SET injured=') || sql.startsWith('UPDATE characters c JOIN') || sql.startsWith('UPDATE combat_members SET pending_action=') || sql.startsWith('DELETE FROM combat_status_effects') || sql.startsWith('DELETE FROM combat_spirits')) return [{ affectedRows: 1 }, []];
    throw new Error(`Unexpected fixture SQL: ${sql}`);
  } } as unknown as PoolConnection;
  const noop = async () => undefined;
  const dependencies = {
    flushTitanWounds, combatUnitLabel, observeSurfaceCombatHp, readSurfaceCombatState,
    recordSurfaceCombatSettlementIn: (db: PoolConnection, id: string, state?: SurfaceCombatState | null) => recordSurfaceCombatSettlementIn(db, id, state, async (_db, value) => { calls.push('mark'); if (!marks.has(value.eventKey)) marks.set(value.eventKey, structuredClone(value)); }),
    combatMembers: async () => [member], combatTargets: async () => [{ id: 2, template_code: 'ball_rabbit', traits_json: [] }],
    activeCombatFor: async () => session.state === 'active' ? session : null,
    characterFor: async () => ({ id: 1 }), withTransaction: (work: (db: PoolConnection) => unknown) => work(connection), assertNoNegotiation: noop,
    recordPveCombatSettlement: noop, clearSummonedTargets: noop, clearCombatSpirits: noop,
    prepareBossAmbushHandoff: async () => false, restoreLivingCombatTargets: noop, restoreFallenKingbeastCourt: noop,
    isCityPursuit: () => false, isBossTestMonster: () => false, isAdvancedProfessionTrialMonster: () => false,
    cityPursuitTrait: () => null, settleCityPursuitDefeat: async () => ({ text: '' }), consumeBattleBuffs: noop,
    evacuateDungeonDefeat: async () => { calls.push('evacuate'); member.current_region_id = 88; member.pos_x = 999; return true; },
    finishNpcSparring: async () => { calls.push('spar'); return '切磋结束'; }
  };
  const declarations = [section('const jsonObject =', 'const stringList ='), section('const settleBattleWounds =', '/** 地下迷宫内战败时'),
    section('const repairInvalidCombatFor =', 'export const chooseTargetInTransaction ='),
    section('const settleForcedCombatDefeat =', '/** 自动战斗超过安全回合数'),
    section('export const forceAutoBattleDefeat =', '/** 三分钟内没有任何有效战斗回应时')].join('\n');
  const code = transformSync(`const { ${Object.keys(dependencies).join(',')} } = require('fixture');\n${declarations}\nexport { repairInvalidCombatFor, settleForcedCombatDefeat };`, { loader: 'ts', format: 'cjs', target: 'es2022' }).code.replace(/\bimport\(/g, '__fixtureImport(');
  const result = { exports: {} as any };
  new Function('require', '__fixtureImport', 'module', 'exports', code)((name: string) => { assert.equal(name, 'fixture'); return dependencies; }, async (name: string) => {
    assert.equal(name, './finance-settlement'); return { recordFinanceCombatOutcome: noop };
  }, result, result.exports);
  return { ...result.exports, session, member, connection, marks, calls };
};

test('actual automatic forced settlement observes deferred HP loss and writes frozen ground before evacuation', async () => {
  const f = fixture({ wounds: 20 });
  const result = await f.forceAutoBattleDefeat('offline-fixture', '离线自动战斗上限');
  assert.equal(result.ended, true); assert.equal(result.log, '离线自动战斗上限');
  assert.equal(f.session.state, 'defeat'); assert.equal(f.member.current_hp, 80);
  assert.equal(f.session.cooldowns.__surfaceCombat.damage.blood, .2);
  assert.equal(f.session.cooldowns.preservedReward, 42);
  assert.deepEqual(f.calls, ['mark', 'evacuate']);
  const mark = f.marks.get('combat:battle-flow');
  for (const [key, value] of Object.entries(origin)) assert.equal(mark[key], value);
  assert.equal(f.member.pos_x, 999);
  await f.settleForcedCombatDefeat(f.connection, 'battle-flow');
  assert.equal(f.marks.size, 1); assert.equal(f.calls.filter((call: string) => call === 'mark').length, 1, 'already finalized session never emits another event');
});

test('actual forced settlement requires HP evidence and excludes spar/story and un-frozen old sessions', async () => {
  for (const options of [{}, { withSurface: false, wounds: 20 }, { mode: 'spar', wounds: 20 }, { mode: 'story', wounds: 20 }]) {
    const f = fixture(options); await f.forceAutoBattleDefeat('offline-fixture');
    assert.equal(f.marks.size, 0);
    if (options.mode) assert.deepEqual(f.calls, ['spar']);
  }
});

test('actual invalid-session repair settles delayed wounds and uses saved evidence without generating combat rewards', async () => {
  for (const [state, liveMembers, liveTargets] of [['defeat', 0, 1], ['victory', 1, 0], ['escaped', 1, 1]] as const) {
    const f = fixture({ wounds: 30, liveMembers, liveTargets, usableTargets: 0 });
    assert.equal(await f.repairInvalidCombatFor(f.connection, 1), true);
    assert.equal(f.session.state, state); assert.equal(f.member.current_hp, 70);
    assert.equal(f.session.cooldowns.__surfaceCombat.damage.blood, .3);
    assert.equal(f.marks.size, 1); assert.equal(f.marks.get('combat:battle-flow').x, origin.x);
    assert.equal(await f.repairInvalidCombatFor(f.connection, 1), false);
  }
  const active = fixture({ wounds: 30 });
  assert.equal(await active.repairInvalidCombatFor(active.connection, 1), false); assert.equal(active.member.current_hp, 100); assert.equal(active.marks.size, 0);
  const clean = fixture({ liveMembers: 0 }); await clean.repairInvalidCombatFor(clean.connection, 1); assert.equal(clean.marks.size, 0);
});
