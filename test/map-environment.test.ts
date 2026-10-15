import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import {
  environmentDistance, environmentDrops, environmentObjectCells, environmentProtectedCell, generateEnvironmentForCells, parseEnvironmentObjectId,
  type EnvironmentArea, type EnvironmentCell, type GeneratedEnvironmentObject
} from '../src/game/map-environment.config';

const forest: EnvironmentArea = { regionId: 1, code: 'dark_forest', enabled: true, danger: 1, minX: -60, maxX: 59, minY: -60, maxY: 59, minZ: 0, maxZ: 0 };
const rect = (x: number, y: number, width: number, height: number): EnvironmentCell[] => Array.from({ length: width * height }, (_, index) => ({ x: x + index % width, y: y + Math.floor(index / width), z: 0 }));
const allCells = rect(-60, -60, 120, 120);

test('generation is deterministic across viewport order and partial multi-cell clipping', () => {
  const whole = generateEnvironmentForCells([forest], allCells);
  assert.ok(whole.length > 300);
  assert.deepEqual(generateEnvironmentForCells([forest], [...allCells].reverse()), whole);
  for (const object of whole.filter(object => object.blocking).slice(0, 70)) {
    const edge = environmentObjectCells(object).at(-1)!;
    assert.deepEqual(generateEnvironmentForCells([forest], [edge]).find(candidate => candidate.id === object.id), object);
  }
});

test('all occupancy is whole integer cells without overlap, and permanent lanes stay clear', () => {
  const objects = generateEnvironmentForCells([forest], allCells), occupied = new Set<string>();
  for (const object of objects) {
    assert.equal(object.footprint.length, object.width * object.height);
    assert.ok(Number.isInteger(object.x) && Number.isInteger(object.y));
    for (const cell of environmentObjectCells(object)) {
      const key = `${cell.x}:${cell.y}:${cell.z}`;
      assert.ok(!occupied.has(key), `overlap at ${key}`); occupied.add(key);
      assert.notEqual((cell.x % 6 + 6) % 6, 0);
      assert.notEqual((cell.y % 6 + 6) % 6, 0);
    }
  }
  const blockerCells = new Set(objects.filter(object => object.blocking).flatMap(environmentObjectCells).map(cell => `${cell.x}:${cell.y}`));
  const source = { x: -60, y: -60 }, reachable = new Set([`${source.x}:${source.y}`]), queue = [source];
  for (let index = 0; index < queue.length; index++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const point = { x: queue[index]!.x + dx!, y: queue[index]!.y + dy! }, key = `${point.x}:${point.y}`;
    if (point.x < -60 || point.x > 59 || point.y < -60 || point.y > 59 || blockerCells.has(key) || reachable.has(key)) continue;
    reachable.add(key); queue.push(point);
  }
  assert.equal(reachable.size + blockerCells.size, 14400, 'no free cells become isolated pockets');
});

test('higher priority overlays, closed areas and underground instance floors receive no surface obstacles', () => {
  const city = { ...forest, regionId: 2, code: 'baina_town', danger: 99, minX: -12, maxX: 12, minY: -12, maxY: 12 };
  const objects = generateEnvironmentForCells([forest, city], allCells);
  assert.ok(objects.some(object => object.regionId === 2 && !object.blocking));
  for (const object of objects.filter(object => object.blocking)) assert.ok(environmentObjectCells(object).every(cell => cell.x < -12 || cell.x > 12 || cell.y < -12 || cell.y > 12));
  assert.deepEqual(generateEnvironmentForCells([{ ...forest, enabled: false }], allCells), []);
  assert.deepEqual(generateEnvironmentForCells([{ ...forest, minZ: -10, maxZ: -10 }], allCells.map(cell => ({ ...cell, z: -10 }))), []);
  assert.throws(() => generateEnvironmentForCells([forest], [{ x: .5, y: 0, z: 0 }]), /整数整格/);
});

test('NPC buffers connect to clear lanes, while a character beside a blocker does not erase it', () => {
  const object = generateEnvironmentForCells([forest], allCells).find(object => object.blocking)!;
  const protections = [{ x: object.x, y: object.y, z: 0, radius: 2 }];
  assert.ok(!generateEnvironmentForCells([forest], allCells, protections).some(candidate => candidate.id === object.id));
  const neighbour = { x: object.x - 1, y: object.y, z: 0, radius: 0 };
  assert.equal(environmentProtectedCell({ x: object.x, y: object.y, z: 0 }, [neighbour]), false);
  assert.ok(generateEnvironmentForCells([forest], allCells, [neighbour]).some(candidate => candidate.id === object.id));
  assert.equal(environmentDistance(object, { x: object.x - 1, y: object.y, z: 0, regionId: 1 }), 1);
  assert.equal(environmentDistance(object, { x: object.x, y: object.y, z: -10, regionId: 1 }), Infinity);
});

test('ecologies differ, drops remain stable and fixed objects never grant drops', () => {
  const rock = generateEnvironmentForCells([{ ...forest, code: 'rediron_pass' }], allCells);
  const ice = generateEnvironmentForCells([{ ...forest, code: 'frostcrown_plateau' }], allCells);
  assert.ok(rock.some(object => object.assetKey === 'red_rocks'));
  assert.ok(ice.some(object => object.assetKey === 'ice_cluster'));
  assert.ok(!rock.some(object => object.templateId === 'forest_log'));
  for (const object of [...rock, ...ice]) {
    assert.deepEqual(environmentDrops(object), environmentDrops({ ...object }));
    if (!object.destructible) assert.deepEqual(environmentDrops(object), []);
    for (const drop of environmentDrops(object)) assert.ok(drop.quantity >= 1 && drop.quantity <= 3);
  }
});

const service = (poolApi?: Record<string, unknown>) => {
  const source = readFileSync(new URL('../src/game/map-environment.service.ts', import.meta.url), 'utf8');
  const module = { exports: {} as Record<string, any> };
  const require = (id: string) => {
    if (id === 'node:crypto') return { randomUUID: () => 'fixture-job' };
    if (id.includes('database/pool')) return poolApi ?? { withTransaction: () => { throw new Error('offline test must not open a database'); } };
    if (id.includes('inventory-binding')) return { grantInventory: async (db: any, character: number, item: number, binding: any) => db.grant(character, item, binding.unbound) };
    if (id.includes('map-hidden-mentor.locations')) return { mapHiddenMentorLocations: [] };
    if (id.includes('map-environment.config')) return { environmentDistance, environmentDrops, environmentObjectCells, environmentProtectedCell, generateEnvironmentForCells, parseEnvironmentObjectId };
    throw new Error(`unexpected import ${id}`);
  };
  new Function('require', 'module', 'exports', transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code)(require, module, module.exports);
  return module.exports;
};

const settlementFixture = () => {
  const object = generateEnvironmentForCells([forest], allCells).find(object => object.destructible)!;
  let job: any = { character_id: 10, object_id: object.id, job_id: 'fixture-job', region_id: 1, origin_x: object.x - 1, origin_y: object.y, origin_z: 0, object_json: object, finishes_at: new Date(), remaining_seconds: 0 };
  const character = { id: 10, current_region_id: 1, pos_x: object.x - 1, pos_y: object.y, pos_z: 0, activity_status: 'active', current_hp: 100, adventurer_registered: 1 };
  let state = false, grants = 0, reward: any;
  const db = {
    grant: async (_character: number, _item: number, quantity: number) => { grants += quantity; },
    execute: async (sql: string, args: any[] = []) => {
      if (sql.includes('FROM characters c JOIN players')) { assert.match(sql, /FOR UPDATE/); return [[character]]; }
      if (sql.includes('FROM player_environment_jobs j WHERE j.character_id')) return [job ? [job] : []];
      if (sql.includes('FROM map_regions r LEFT JOIN map_region_areas')) return [[{ region_id: forest.regionId, code: forest.code, danger_level: forest.danger, is_enabled: 1, min_x: forest.minX, max_x: forest.maxX, min_y: forest.minY, max_y: forest.maxY, min_z: 0, max_z: 0 }]];
      if (sql.includes('FROM map_environment_region_profiles')) return [[]];
      if (sql.includes('FROM map_npcs WHERE pos_x')) return [[]];
      if (sql.startsWith("SELECT '移动'")) return [[]];
      if (sql.startsWith('INSERT IGNORE INTO map_environment_states')) { const was = state; state = true; return [{ affectedRows: was ? 0 : 1 }]; }
      if (sql.startsWith('SELECT id,code,name FROM item_definitions')) return [[{ id: 3, code: object.dropCode, name: '基础建材' }]];
      if (sql.startsWith('INSERT IGNORE INTO player_item_codex')) return [{ affectedRows: 1 }];
      if (sql.startsWith('INSERT INTO map_environment_rewards')) { assert.ok(!reward); reward = JSON.parse(args[3]); return [{ affectedRows: 1 }]; }
      if (sql.startsWith('DELETE FROM player_environment_jobs')) { job = null; return [{ affectedRows: 1 }]; }
      if (sql.startsWith('SELECT rewards_json')) return [reward ? [{ rewards_json: reward }] : []];
      throw new Error(`unexpected SQL ${sql}`);
    }
  };
  return { object, db, character, getJob: () => job, getGrants: () => grants, hasState: () => state };
};

test('idle gate sees cleanup committed after an older transaction snapshot', async () => {
  const fixture = settlementFixture(), api = service();
  fixture.getJob().remaining_seconds = 10;
  const locks: string[] = [];
  const db = { execute: async (sql: string, args: unknown[]) => {
    if (sql === 'SELECT id FROM characters WHERE id=? FOR UPDATE') {
      assert.deepEqual(args, [10]);
      locks.push('character');
      return [[{ id: 10 }]];
    }
    assert.match(sql, /FROM player_environment_jobs/);
    assert.deepEqual(locks, ['character'], 'the character lock must precede the job lock');
    locks.push('job');
    // REPEATABLE READ can retain the earlier empty snapshot; a locking read sees the committed job.
    return [sql.includes('FOR UPDATE') ? [fixture.getJob()] : []];
  } };
  await assert.rejects(api.assertEnvironmentIdle(db, 10), /正在清理/);
  assert.deepEqual(locks, ['character', 'job']);
});

test('a party follower cannot start cleanup while only the leader has a travel job', async () => {
  const fixture = settlementFixture(), api = service();
  let checkedPartyTravel = false;
  const db = { execute: async (sql: string, args: unknown[]) => {
    if (sql.includes('FROM characters c JOIN players')) {
      assert.match(sql, /FOR UPDATE/);
      return [[fixture.character]];
    }
    if (sql.includes('FROM player_environment_jobs j WHERE j.character_id')) return [[]];
    if (sql.includes('FROM party_members own')) {
      assert.deepEqual(args, [10]);
      assert.match(sql, /JOIN player_travels t ON t.character_id=fellow.character_id/);
      checkedPartyTravel = true;
      return [[{ character_id: 20 }]]; // No travel on follower 10; leader 20 is travelling.
    }
    throw new Error(`unexpected SQL ${sql}`);
  } };
  await assert.rejects(api.environmentStartClearIn(db, 'fixture-follower', fixture.object.id), /队伍正在前往或寻怪/);
  assert.equal(checkedPartyTravel, true);
  assert.equal(fixture.getGrants(), 0);
});

test('background and explicit settlement share a single receipt after process restart', async () => {
  const fixture = settlementFixture();
  const queueDb = { execute: async (sql: string) => {
    assert.match(sql, /WHERE j\.finishes_at<=NOW\(\)/);
    return [[{ qq_user_id: 'fixture-user', object_id: fixture.object.id }]];
  } };
  const api = service({ getPool: async () => queueDb, withTransaction: async (work: (db: unknown) => Promise<unknown>) => work(fixture.db) });
  assert.deepEqual(await api.settleDueEnvironmentClearings(), { settled: 1, failed: 0 });
  const amount = fixture.getGrants();
  assert.ok(amount > 0);
  // A restarted worker can still hold the stale due-job snapshot; the unique receipt wins.
  const restarted = service({ getPool: async () => queueDb, withTransaction: async (work: (db: unknown) => Promise<unknown>) => work(fixture.db) });
  assert.deepEqual(await restarted.settleDueEnvironmentClearings(), { settled: 0, failed: 0 });
  const manual = await restarted.environmentFinishClearIn(fixture.db, 'fixture-user', fixture.object.id);
  assert.equal(manual.alreadySettled, true);
  assert.equal(fixture.getGrants(), amount);
});

test('explicit settlement awards once and a repeated object settlement replays the receipt', async () => {
  const fixture = settlementFixture(), api = service();
  const first = await api.environmentFinishClearIn(fixture.db, 'fixture-user', fixture.object.id);
  assert.equal(first.kind, 'settled'); assert.equal(first.alreadySettled, false);
  const amount = fixture.getGrants(); assert.ok(amount > 0); assert.equal(fixture.getJob(), null); assert.ok(fixture.hasState());
  const second = await api.environmentFinishClearIn(fixture.db, 'fixture-user', fixture.object.id);
  assert.equal(second.alreadySettled, true); assert.equal(fixture.getGrants(), amount); assert.deepEqual(second.rewards, first.rewards);
});

test('early finish, moved character and cancellation cannot award or destroy the obstacle', async () => {
  const early = settlementFixture(), api = service(); early.getJob().remaining_seconds = 1;
  assert.equal((await api.environmentFinishClearIn(early.db, 'fixture-user')).kind, 'clearing');
  assert.equal(early.getGrants(), 0); assert.equal(early.hasState(), false);
  const moved = settlementFixture(); moved.character.pos_x--;
  await assert.rejects(api.environmentFinishClearIn(moved.db, 'fixture-user'), /离开清理位置/);
  assert.equal(moved.getGrants(), 0); assert.equal(moved.hasState(), false);
  const cancel = settlementFixture();
  assert.equal((await api.environmentCancelClearIn(cancel.db, 'fixture-user')).kind, 'cancelled');
  assert.equal(cancel.getGrants(), 0); assert.equal(cancel.hasState(), false);
});

test('GET collision reads stay read-only; explicit legacy protection persists after departure', async () => {
  const target = generateEnvironmentForCells([forest], allCells).find(object => object.blocking)!;
  const cell = environmentObjectCells(target)[0]!, states = new Map<string, any>();
  let protect = true, writes = 0;
  const db = { execute: async (sql: string, args: any[] = []) => {
    if (sql.includes('FROM map_regions r LEFT JOIN map_region_areas')) return [[{ region_id: forest.regionId, code: forest.code, danger_level: forest.danger, is_enabled: 1, min_x: forest.minX, max_x: forest.maxX, min_y: forest.minY, max_y: forest.maxY, min_z: 0, max_z: 0 }]];
    if (sql.startsWith('SELECT object_id,state,revision FROM map_environment_states')) return [[...states.values()].filter(state => args.includes(state.object_id))];
    if (sql.includes('FROM map_npcs WHERE pos_x')) return [protect ? [{ x: cell.x, y: cell.y, z: 0, radius: 0 }] : []];
    if (sql.startsWith('INSERT IGNORE INTO map_environment_states')) { writes++; states.set(args[0], { object_id: args[0], state: 'suppressed', revision: 1 }); return [{ affectedRows: 1 }]; }
    if (sql.includes('FROM player_environment_jobs j WHERE j.object_id')) return [[]];
    throw new Error(`unexpected SQL ${sql}`);
  } };
  const api = service();
  assert.equal(await api.environmentBlockerAt(db, cell), null);
  assert.equal(writes, 0, 'GET must not write suppression state');
  assert.equal(states.size, 0);
  await api.suppressEnvironmentForCells(db, [cell]);
  assert.equal(states.get(target.id)?.state, 'suppressed');
  protect = false;
  assert.equal(await api.environmentBlockerAt(db, cell), null);
  states.clear();
  assert.equal((await api.environmentBlockerAt(db, cell))?.id, target.id);
  states.set(target.id, { object_id: target.id, state: 'cleared', revision: 1 });
  assert.equal(await api.environmentBlockerAt(db, cell), null);
});
