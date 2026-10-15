import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { assertExpectedLocalStep, LocalExplorationError, localDistance, localReachableCells, localShortestPath } from '../src/game/local-exploration-route';
import { environmentObjectCells } from '../src/game/map-environment.config';
import { surfaceSceneFor } from '../src/game/map-surface-scene';

const origin = { x: 0, y: 0, z: 0, regionId: 1 };
const diamond = (range: number, walls = new Set<string>()) => {
  const cells = [];
  for (let x = -range; x <= range; x++) for (let y = -range; y <= range; y++) {
    if (Math.abs(x) + Math.abs(y) <= range) cells.push({ x, y, z: 0, regionId: 1, passable: !walls.has(`${x}:${y}`) });
  }
  return cells;
};
const rejectsCode = (code: string) => (error: unknown) => error instanceof LocalExplorationError && error.code === code;

test('cardinal BFS preserves the original movement budget, handles walls, and excludes origin', () => {
  const walls = new Set(['1:0']);
  const path = localShortestPath(origin, { x: 2, y: 0, z: 0 }, diamond(4, walls), 4, 4);
  assert.equal(path.length, 4);
  assert.deepEqual(path.at(-1), { x: 2, y: 0, z: 0, regionId: 1, passable: true });
  let previous = origin;
  for (const point of path) {
    assert.equal(localDistance(previous, point), 1);
    assert.ok(localDistance(origin, point) <= 4);
    assert.equal(walls.has(`${point.x}:${point.y}`), false);
    previous = point;
  }
  assert.throws(() => localShortestPath(origin, { x: 2, y: 0, z: 0 }, diamond(4, walls), 3, 4), rejectsCode('NO_LOCAL_ROUTE'));
  assert.throws(() => localShortestPath(origin, { x: 3, y: 0, z: 0 }, diamond(4), 4, 2), rejectsCode('OUT_OF_RANGE'));
  assert.throws(() => localShortestPath(origin, { x: 1, y: 0, z: 1 }, diamond(4), 4, 4), rejectsCode('WRONG_LAYER'));
  assert.throws(() => localShortestPath(origin, { x: 1, y: 0, z: 0 }, diamond(4, walls), 4, 4), rejectsCode('BLOCKED_TARGET'));
  assert.deepEqual(localShortestPath(origin, origin, diamond(1), 1, 1), []);
});

test('reachability preserves passability while rejecting over-budget detours, isolated cells, bonus sight, and other floors', () => {
  const cells = [...diamond(4, new Set(['1:0'])), { x: 0, y: 0, z: 1, regionId: 2, passable: true }];
  const snapshot = structuredClone(cells);
  const marked = localReachableCells(origin, cells, 3, 4);
  const cell = (x: number, y: number, z = 0) => marked.find(candidate => candidate.x === x && candidate.y === y && candidate.z === z)!;
  assert.deepEqual(cells, snapshot, 'marking does not mutate terrain data');
  assert.equal(marked.length, cells.length, 'no unseen cells are added');
  assert.equal(cell(0, 0).reachable, true);
  assert.equal(cell(1, 0).passable, false); assert.equal(cell(1, 0).reachable, false);
  assert.equal(cell(2, 0).passable, true); assert.equal(cell(2, 0).reachable, false, 'four-step detour exceeds three-step budget');
  assert.equal(cell(0, 3).reachable, true, 'exact-budget endpoint remains reachable');
  assert.equal(cell(0, 4).passable, true); assert.equal(cell(0, 4).reachable, false, 'perceived cells do not bypass movement budget');
  assert.equal(cell(0, 0, 1).reachable, false);
  const larger = localReachableCells(origin, cells, 4, 4);
  assert.equal(larger.find(candidate => candidate.x === 2 && candidate.y === 0 && candidate.z === 0)?.reachable, true);
  assert.equal(localReachableCells(origin, cells, 4, 1).find(candidate => candidate.x === 0 && candidate.y === 2 && candidate.z === 0)?.reachable, false, 'base perception caps extra card sight');
  const isolated = localReachableCells(origin, diamond(4, new Set(['1:0', '3:0', '2:1', '2:-1'])), 4, 4);
  assert.equal(isolated.find(candidate => candidate.x === 2 && candidate.y === 0)?.passable, true);
  assert.equal(isolated.find(candidate => candidate.x === 2 && candidate.y === 0)?.reachable, false, 'enclosed but passable terrain is unreachable');
  for (const candidate of marked) {
    if (candidate.z !== origin.z || localDistance(origin, candidate) === 0) continue;
    let found = false;
    try { localShortestPath(origin, candidate, cells, 3, 4); found = true; } catch (error) { assert.ok(error instanceof LocalExplorationError); }
    assert.equal(candidate.reachable, found, `map/preview agreement at ${candidate.x}:${candidate.y}:${candidate.z}`);
  }
});

test('stale account positions, floor changes, diagonals, and repeated steps are rejected', () => {
  assert.doesNotThrow(() => assertExpectedLocalStep(origin, { x: 1, y: 0, z: 0 }, origin));
  assert.throws(() => assertExpectedLocalStep({ ...origin, x: 1 }, { x: 1, y: 0, z: 0 }, origin), rejectsCode('STALE_POSITION'));
  assert.throws(() => assertExpectedLocalStep({ ...origin, regionId: 2 }, { x: 1, y: 0, z: 0 }, origin), rejectsCode('STALE_POSITION'));
  for (const point of [{ x: 1, y: 1, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 0, y: 1, z: 1 }, origin]) {
    assert.throws(() => assertExpectedLocalStep(origin, point, origin), rejectsCode('INVALID_STEP'));
  }
});

test('local routes prefer known interactive targets while preserving endpoints, authority and the original step budget', () => {
  const target = { x: 2, y: 0, z: 0 }, cells = diamond(4), occupied = [{ x: 1, y: 0, z: 0, regionId: 1 }];
  const detour = localShortestPath(origin, target, cells, 4, 4, occupied);
  assert.deepEqual(detour.map(cell => [cell.x, cell.y]), [[0, 1], [1, 1], [2, 1], [2, 0]]);
  assert.deepEqual(localShortestPath(origin, target, cells, 2, 4, occupied).map(cell => [cell.x, cell.y]), [[1, 0], [2, 0]], 'an over-budget detour does not turn passable terrain into a new wall');
  const corridor = cells.filter(cell => cell.y === 0);
  assert.equal(localShortestPath(origin, target, corridor, 4, 4, occupied).length, 2, 'one-cell passages retain the original encounter stop behavior');
  assert.equal(localShortestPath(origin, target, cells, 4, 4, [origin, target]).length, 2, 'starting on and deliberately approaching a target is allowed');
  for (const unknown of [{ x: 1, y: 0, z: 1 }, { x: 1, y: 0, z: 0, regionId: 99 }, { x: 100, y: 0, z: 0 }]) {
    assert.equal(localShortestPath(origin, target, cells, 4, 4, [unknown]).length, 2, 'different floor, region and unauthorised cells cannot affect a route');
  }
  assert.throws(() => localShortestPath(origin, target, diamond(4, new Set(['2:0'])), 4, 4, occupied), rejectsCode('BLOCKED_TARGET'), 'a deliberate target cannot bypass a real wall');
});

// Compile the actual service functions with a database adapter. This does not
// import the real pool module (whose initialization creates/updates a database).
const serviceSource = readFileSync(new URL('../src/game/adventure.service.ts', import.meta.url), 'utf8');
const between = (start: string, end: string) => {
  const first = serviceSource.indexOf(start), last = serviceSource.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `${start} source boundary`);
  return serviceSource.slice(first, last);
};
const planningSource = between('const readLocalExplorationCharacter =', 'const moveToPosition =');
const movingSource = between('const moveToPosition =', 'export const move =');
const stepSource = between('export const localExplorationRouteStep =', 'const coordinateInteractionTargetsFor =');
const load = (source: string, dependencies: Record<string, unknown>) => {
  const loaded = { exports: {} as any };
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs' }).code.replace(/\bimport\(/g, '__fixtureImport(');
  new Function(...Object.keys(dependencies), '__fixtureImport', 'module', 'exports', compiled)(...Object.values(dependencies), async (name: string) => (dependencies.require as (name: string) => unknown)(name), loaded, loaded.exports);
  return loaded.exports;
};

const baseDependencies = {
  LocalExplorationError, localReachableCells, localShortestPath, assertExpectedLocalStep,
  isLocalPosition: (point: any, region = false) => point && [point.x, point.y, point.z].every(Number.isSafeInteger) && (!region || (Number.isSafeInteger(point.regionId) && point.regionId > 0)),
  heartCorrections: new WeakMap(), heartGrowthAdjustment: async () => null,
  jsonObject: (value: any) => typeof value === 'string' ? JSON.parse(value) : value ?? {},
  explorationCardProfile: async () => ({}), inventoryForCharacter: async () => ({ movementSpeed: 3 }),
  finalAttribute: () => 20, perceptionRange: () => 3,
  equippedEnchantmentEffects: async () => ({ mapPerceptionBonus: 1 }),
  environmentForCells: async () => [], environmentClearStatus: async () => null,
  surfaceSceneFor: async () => undefined, groundWindowFor: async () => undefined, recordSurfaceWalkIn: async () => {},
  isInHome: async () => false,
  nearbyPointsForWindow: async () => ({ points: [] }),
  assertEnvironmentIdle: async () => {}, environmentBlockerAt: async () => null, environmentObjectCells,
  assertOwnerOnlyRegionAccess: async (_db: unknown, _user: string, ownerOnly: boolean, enabled: boolean) => { if (ownerOnly || !enabled) throw Error('区域未开放'); },
  require: (name: string) => name === './leaf-route.service' ? { assertLeafDestination: async () => {} } : assert.fail(`unexpected import ${name}`)
};

test('route target reads reuse visibility filters without refreshing bounties or exposing unheld/locked buildings', async () => {
  const fixture = { id: 1, current_region_id: 1, pos_x: 0, pos_y: 0, pos_z: 0 };
  const window = { cells: diamond(4), range: 4, actionRange: 4 };
  let nearbyReads = 0, buildingReads = 0;
  const db = { execute: async (sql: string, args: unknown[]) => {
    assert.match(sql.trim(), /^SELECT /, 'planning only reads saved game state');
    if (sql.includes('SELECT c.*,r.name')) return [[fixture]];
    assert.match(sql, /n.interaction_kind='building'.*r.is_enabled=1.*r.is_owner_only=0/s);
    assert.deepEqual(args, [1, 2], 'only held public maps contribute static building positions');
    buildingReads++;
    return [[{ code: 'guild_counter', interaction_kind: 'building', region_id: 2, x: 12, y: 0, z: 0 }, { code: 'evolution_lab', interaction_kind: 'building', region_id: 1, x: 4, y: 0, z: 0 }, { code: 'home_station', interaction_kind: 'building', region_id: 1, x: 3, y: 0, z: 0 }]];
  } };
  const service = load(planningSource, {
    ...baseDependencies,
    nearbyPointsForWindow: async (user: string, character: unknown, connection: unknown, cells: unknown, readOnly: boolean, compact: unknown) => {
      assert.equal(user, 'fixture-user'); assert.equal(connection, db); assert.deepEqual(character, fixture);
      assert.equal(cells, window.cells); assert.equal(readOnly, true); assert.equal(compact, window);
      nearbyReads++; return { points: [{ type: '怪物', x: 1, y: 0, z: 0, regionId: 1, code: 'private-id' }] };
    },
    evolutionLabUnlockedFor: async () => false,
    withoutHomeStationResidents: (rows: { code: string }[]) => rows.filter(row => row.code !== 'home_station')
  });
  assert.deepEqual(await service.knownRouteTargetsFor('fixture-user', db, window, [1, 2, 2, -1]), [{ x: 1, y: 0, z: 0, regionId: 1 }, { x: 12, y: 0, z: 0, regionId: 2 }]);
  assert.equal(nearbyReads, 1); assert.equal(buildingReads, 1);
});

test('actual local preview applies known-target preferences without changing the map passability contract', async () => {
  const db = { execute: async (sql: string) => {
    assert.match(sql.trim(), /^SELECT /);
    if (sql.includes('SELECT c.*,r.name')) return [[{ id: 1, current_region_id: 1, pos_x: 0, pos_y: 0, pos_z: 0, region_name: 'town', level: 40 }]];
    if (sql.includes('map_region_areas')) return [[{ region_id: 1, code: 'town', is_enabled: 1, is_owner_only: 0, min_x: -8, max_x: 8, min_y: -8, max_y: 8 }]];
    if (sql.includes('player_movement_settings')) return [[{ movement_step: 4 }]];
    if (sql.includes('party_members')) return [[]];
    assert.fail(sql);
  } };
  const service = load(planningSource, {
    ...baseDependencies, getPool: async () => db, perceptionRange: () => 4,
    inventoryForCharacter: async () => ({ movementSpeed: 4 }),
    nearbyPointsForWindow: async (_user: string, _character: unknown, connection: unknown, cells: any[], readOnly: boolean) => {
      assert.equal(connection, db); assert.equal(readOnly, true);
      assert.ok(cells.some(cell => cell.x === 1 && cell.y === 0 && cell.passable));
      return { points: [{ type: '矿脉', x: 1, y: 0, z: 0, regionId: 1 }] };
    }
  });
  const preview = await service.localExplorationRoutePreview('fixture-user', 2, 0, 0);
  assert.deepEqual(preview.path.map((cell: any) => [cell.x, cell.y]), [[0, 1], [1, 1], [2, 1], [2, 0]]);
  assert.equal(preview.stepMilliseconds, 250);
  const map = await service.localExplorationMap('fixture-user');
  assert.equal(map.cells.find((cell: any) => cell.x === 1 && cell.y === 0).passable, true, 'preferences do not alter collision or direction buttons');
});

test('planning uses real overlapping area priority, only exposes the perception diamond, and never writes', async () => {
  const queries: string[] = [];
  let savedStep: number | undefined;
  const areas = [
    { region_id: 2, danger_level: 9, code: 'private', is_enabled: 1, is_owner_only: 1, min_x: 1, max_x: 1, min_y: 0, max_y: 0 },
    { region_id: 1, danger_level: 1, code: 'town', is_enabled: 1, is_owner_only: 0, min_x: -4, max_x: 4, min_y: -4, max_y: 4 }
  ];
  const db = { execute: async (sql: string) => {
    queries.push(sql);
    assert.match(sql.trim(), /^SELECT /i, 'preview SQL remains read-only');
    if (sql.includes('SELECT c.*,r.name')) return [[{ id: 1, current_region_id: 1, pos_x: 0, pos_y: 0, pos_z: 0, region_name: 'town', level: 10 }]];
    if (sql.includes('map_region_areas')) return [areas];
    if (sql.includes('player_movement_settings')) return [[...(savedStep === undefined ? [] : [{ movement_step: savedStep }])]];
    if (sql.includes('party_members')) return [[]];
    assert.fail(sql);
  } };
  const service = load(planningSource, { ...baseDependencies, getPool: async () => db, dungeonCellAt: async () => assert.fail('surface must not read dungeon contents') });
  const map = await service.localExplorationMap('fake-user');
  assert.equal(map.range, 4);
  assert.deepEqual(map.movement, { step: 1, maximum: 3, speed: 3 });
  assert.equal(map.cells.length, 41);
  assert.equal(map.cells.some((cell: any) => Math.abs(cell.x) + Math.abs(cell.y) > 4), false);
  assert.deepEqual(map.cells.find((cell: any) => cell.x === 1 && cell.y === 0), { x: 1, y: 0, z: 0, passable: false, reachable: false });
  assert.equal(map.cells.every((cell: any) => typeof cell.reachable === 'boolean'), true);
  assert.equal(map.cells.find((cell: any) => cell.x === 0 && cell.y === 0).reachable, true);
  assert.equal(map.cells.find((cell: any) => cell.x === 0 && cell.y === 1).reachable, true);
  assert.equal(map.cells.find((cell: any) => cell.x === 0 && cell.y === 1).regionCode, 'town', 'permitted cells retain their authoritative region code through reachability');
  assert.equal(map.cells.find((cell: any) => cell.x === 0 && cell.y === 2).reachable, false);
  assert.equal(queries.some(sql => /INSERT|UPDATE|DELETE/.test(sql)), false);
  await assert.rejects(service.localExplorationRoutePreview('fake-user', 2, 0, 0), rejectsCode('OUT_OF_RANGE'));
  savedStep = 3;
  const expanded = await service.localExplorationMap('fake-user');
  assert.deepEqual(expanded.movement, { step: 3, maximum: 3, speed: 3 });
  assert.deepEqual(expanded.cells.find((cell: any) => cell.x === 2 && cell.y === 0), { x: 2, y: 0, z: 0, regionId: 1, regionCode: 'town', passable: true, reachable: false });
  assert.equal(expanded.cells.find((cell: any) => cell.x === 0 && cell.y === 3).reachable, true);
  assert.equal(expanded.cells.find((cell: any) => cell.x === 0 && cell.y === 4).reachable, false, 'bonus observation remains outside base action range');
  await assert.rejects(service.localExplorationRoutePreview('fake-user', 2, 0, 0), rejectsCode('NO_LOCAL_ROUTE'));
  assert.equal(queries.some(sql => /INSERT|UPDATE|DELETE/.test(sql)), false);
});

test('route timing uses effective map speed independently of selected step size', async () => {
  let speed = 8, selectedStep = 4;
  const db = { execute: async (sql: string) => {
    assert.match(sql.trim(), /^SELECT /i, 'speed preview remains read-only');
    if (sql.includes('SELECT c.*,r.name')) return [[{ id: 1, current_region_id: 1, pos_x: 0, pos_y: 0, pos_z: 0, region_name: 'town', level: 40 }]];
    if (sql.includes('map_region_areas')) return [[{ region_id: 1, code: 'town', is_enabled: 1, is_owner_only: 0, min_x: -8, max_x: 8, min_y: -8, max_y: 8 }]];
    if (sql.includes('player_movement_settings')) return [[{ movement_step: selectedStep }]];
    if (sql.includes('party_members')) return [[]];
    assert.fail(sql);
  } };
  const service = load(planningSource, {
    ...baseDependencies, getPool: async () => db, perceptionRange: () => 8,
    inventoryForCharacter: async () => ({ movementSpeed: speed }), dungeonCellAt: async () => assert.fail('surface preview')
  });
  const fast = await service.localExplorationRoutePreview('fake-user', 4, 0, 0);
  assert.equal(fast.path.length, 4);
  assert.equal(fast.stepMilliseconds, 125);
  assert.equal(fast.path.length * fast.stepMilliseconds, 500);
  speed = 7.5;
  const burdened = await service.localExplorationMap('fake-user');
  assert.deepEqual(burdened.movement, { step: 4, maximum: 7, speed: 7.5 }, 'fractional effective speed is retained instead of using floored range');
  const fractional = await service.localExplorationRoutePreview('fake-user', 4, 0, 0);
  assert.equal(fractional.stepMilliseconds, 1000 / 7.5);
  selectedStep = 1;
  const short = await service.localExplorationRoutePreview('fake-user', 1, 0, 0);
  assert.equal(short.stepMilliseconds, fractional.stepMilliseconds, 'selected step changes reach, not walking speed');
  await assert.rejects(service.localExplorationRoutePreview('fake-user', 2, 0, 0), rejectsCode('OUT_OF_RANGE'));
});

test('underground previews use only actual perceived corridor cells, without revealing the full maze', async () => {
  const lookedUp: [number, number][] = [];
  const db = { execute: async (sql: string) => {
    assert.match(sql.trim(), /^SELECT /i);
    if (sql.includes('SELECT c.*,r.name')) return [[{ id: 1, current_region_id: 1, pos_x: 0, pos_y: 0, pos_z: 0, region_name: '地下迷宫', level: 10 }]];
    if (sql.includes('map_region_areas')) return [[{ region_id: 1, code: 'dark_forest_dungeon', is_enabled: 1, is_owner_only: 0, min_x: -20, max_x: 20, min_y: -20, max_y: 20 }]];
    if (sql.includes('player_movement_settings')) return [[{ movement_step: 3 }]];
    if (sql.includes('party_members')) return [[]];
    assert.fail(sql);
  } };
  const service = load(planningSource, { ...baseDependencies, getPool: async () => db, dungeonCellAt: async (_db: unknown, _id: number, x: number, y: number) => { lookedUp.push([x, y]); return y === 0; } });
  const map = await service.localExplorationMap('fake-user');
  assert.equal(map.range, 1); assert.equal(map.actionRange, 1); assert.equal(map.cells.length, 5);
  assert.equal(map.cells.filter((cell: any) => cell.passable).length, 3);
  assert.equal(map.cells.filter((cell: any) => cell.reachable).length, 3);
  assert.ok(map.cells.filter((cell: any) => cell.passable).every((cell: any) => cell.regionCode === 'dark_forest_dungeon'));
  assert.ok(map.cells.filter((cell: any) => !cell.passable).every((cell: any) => cell.regionId === undefined && cell.regionCode === undefined), 'stone walls do not gain region identity');
  assert.ok(map.cells.every((cell: any) => cell.reachable === cell.passable), 'perceived underground corridor endpoints are one step away');
  assert.ok(lookedUp.every(([x, y]) => Math.abs(x) + Math.abs(y) <= 1));
  await assert.rejects(service.localExplorationRoutePreview('fake-user', 0, 1, 0), rejectsCode('BLOCKED_TARGET'));
});

test('actual map blocks every whole footprint cell, retains its terrain, and direction metadata remains read-only', async () => {
  const queries: string[] = [];
  let step = 3, dungeon = false, job: unknown = null;
  const obstacle = { id: 'env1:dark_forest:1:0:0:0', name: '缠结树根', x: 1, y: 0, z: 0, regionId: 1, blocking: true, destructible: true, footprint: [{ dx: 0, dy: 0 }, { dx: 0, dy: 1 }] };
  const db = { execute: async (sql: string) => {
    queries.push(sql); assert.match(sql.trim(), /^SELECT /i, 'map and direction queries cannot move or settle');
    if (sql.includes('SELECT c.*,r.name')) return [[{ id: 1, current_region_id: 1, pos_x: 0, pos_y: 0, pos_z: 0, region_name: dungeon ? '地下迷宫' : '幽暗森林', level: 10 }]];
    if (sql.includes('map_region_areas')) return [[{ region_id: 1, code: dungeon ? 'dark_forest_dungeon' : 'dark_forest', danger_level: 1, is_enabled: 1, is_owner_only: 0, min_x: -4, max_x: 4, min_y: -4, max_y: 4 }]];
    if (sql.includes('player_movement_settings')) return [[{ movement_step: step }]];
    if (sql.includes('party_members')) return [[]];
    assert.fail(sql);
  } };
  const service = load(planningSource, {
    ...baseDependencies, getPool: async () => db, inventoryForCharacter: async () => ({ movementSpeed: 4 }), perceptionRange: () => 4,
    environmentForCells: async (_db: unknown, cells: any[]) => {
      assert.ok(cells.every(cell => cell.passable && cell.regionId === 1), 'only permitted perceived cells reach environment lookup');
      return dungeon ? [] : cells.some(cell => environmentObjectCells(obstacle).some(occupied => occupied.x === cell.x && occupied.y === cell.y)) ? [obstacle] : [];
    },
    environmentClearStatus: async () => job, dungeonCellAt: async () => true
  });
  const map = await service.localExplorationMap('fake-user');
  for (const [x, y] of [[1, 0], [1, 1]]) {
    assert.deepEqual(map.cells.find((cell: any) => cell.x === x && cell.y === y), { x, y, z: 0, regionId: 1, regionCode: 'dark_forest', passable: false, reachable: false });
  }
  assert.equal(map.cells.find((cell: any) => cell.x === 2 && cell.y === 0).passable, true);
  assert.equal(map.cells.find((cell: any) => cell.x === 2 && cell.y === 0).reachable, false, 'a four-step detour exceeds the saved three-step budget');
  await assert.rejects(service.localExplorationRoutePreview('fake-user', 2, 0, 0), rejectsCode('NO_LOCAL_ROUTE'));
  await assert.rejects(service.localExplorationRoutePreview('fake-user', 1, 1, 0), rejectsCode('BLOCKED_TARGET'));
  step = 4;
  const preview = await service.localExplorationRoutePreview('fake-user', 2, 0, 0);
  assert.equal(preview.path.length, 4);
  assert.ok(preview.path.every((cell: any) => !environmentObjectCells(obstacle).some(occupied => occupied.x === cell.x && occupied.y === cell.y)));
  const surface = await service.environmentDirectionState('fake-user');
  assert.equal(surface.isDungeon, false); assert.equal(surface.directions.右.canMove, false);
  assert.equal(surface.directions.右.objectId, obstacle.id); assert.equal(surface.directions.右.destructible, true);
  assert.equal(surface.directions.左.canMove, true);
  job = { id: 'job-1', objectId: obstacle.id, ready: false, remainingSeconds: 5 };
  const clearing = await service.environmentDirectionState('fake-user');
  assert.ok(Object.values(clearing.directions).every((direction: any) => direction.canMove === false));
  assert.equal(clearing.directions.左.label, '左·清理中');
  dungeon = true; job = null;
  const maze = await service.environmentDirectionState('fake-user');
  assert.equal(maze.isDungeon, true, 'explicit region type remains a dungeon even at a four-way intersection');
  assert.ok(Object.values(maze.directions).every((direction: any) => direction.canMove === true));
  assert.ok(queries.length > 0 && queries.every(sql => /^SELECT/i.test(sql.trim())));
});

test('route transactions lock first, reject competing stale steps, and preserve encounter interruption', async () => {
  const state = { id: 1, current_region_id: 1, pos_x: 0, pos_y: 0, pos_z: 0, region_name: 'town', activity_status: 'active', level: 1 };
  const logs: string[][] = [], commits: number[] = [];
  const surfaceWalks: any[] = [];
  let obstacle: any = null, clearing = false, obstructionChecks = 0, surfaceFailure = false, snapshotFailure = false;
  let snapshotReads = 0, transactionDb: unknown;
  let tail = Promise.resolve();
  const service = load(`${planningSource}\n${movingSource}\n${stepSource}`, {
    ...baseDependencies, getPool: async () => assert.fail('step must use its transaction'),
    surfaceSceneFor: async (db: unknown, current: typeof origin, cells: any[]) => {
      assert.equal(db, transactionDb, 'perception reads the connection that owns the movement lock');
      assert.equal(current.x, state.pos_x, 'snapshot uses the actual in-transaction landing');
      assert.ok(cells.every(cell => cell.z === state.pos_z && Math.abs(cell.x - current.x) + Math.abs(cell.y - current.y) <= 4));
      snapshotReads++;
      if (snapshotFailure) throw Error('synthetic snapshot read failure');
      return { scopeToken: 'world:0', snapshotId: `step:${current.x}`, serverNowMs: 1234 };
    },
    recordSurfaceWalkIn: async (_db: unknown, points: any[]) => {
      assert.equal(points.at(-1).x, state.pos_x, 'the actual position update precedes its transactional trail');
      surfaceWalks.push(structuredClone(points));
      if (surfaceFailure) throw Error('synthetic surface persistence failure');
    },
    assertEnvironmentIdle: async () => { if (clearing) throw Error('正在清理障碍物'); },
    environmentBlockerAt: async (_db: unknown, cell: any) => {
      obstructionChecks++;
      return obstacle && environmentObjectCells(obstacle).some(occupied => occupied.x === cell.x && occupied.y === cell.y && occupied.z === cell.z) ? obstacle : null;
    },
    withTransaction: async (work: (db: unknown) => Promise<unknown>) => {
      const preceding = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await preceding;
      const snapshot = { ...state }, trailCount = surfaceWalks.length, log: string[] = []; logs.push(log);
      const db = { execute: async (sql: string, args: any[] = []) => {
        log.push(sql);
        if (sql.includes('SELECT c.*,r.name')) return [[{ ...state }]];
        if (sql.includes('FROM map_region_areas')) return [[{ region_id: 1, code: 'town', is_enabled: 1, is_owner_only: 0, min_x: -20, max_x: 20, min_y: -20, max_y: 20 }]];
        if (sql.includes('player_movement_settings')) return [[{ movement_step: 3 }]];
        if (sql.includes('SELECT c.id,c.current_region_id')) return [[{ ...state }]];
        if (sql.startsWith('SELECT r.id,r.code')) return [[{ id: 1, code: 'town', name: 'town', is_owner_only: 0, is_enabled: 1 }]];
        if (sql.startsWith('UPDATE characters SET current_region_id')) { state.current_region_id = args[0]; state.pos_x = args[1]; state.pos_y = args[2]; return [{}]; }
        if (sql.includes('SELECT current_region_id,pos_x,pos_y,pos_z')) return [[{ ...state }]];
        if (sql.includes('SELECT code FROM map_regions')) return [[{ code: 'town' }]];
        if (sql.includes('FROM monster_spawns') && sql.includes('SELECT s.id,s.template_id')) return [[...(state.pos_x === 2 ? [{ id: 77, template_id: 8, name: '守路怪物' }] : [])]];
        if (sql.includes('SELECT danger_level,is_owner_only,is_spawn_enabled')) return [[{ danger_level: 0 }]];
        if (sql.includes('SELECT description FROM map_move_texts')) return [[{ description: '向前走了一格' }]];
        if (/^SELECT/.test(sql.trim())) return [[]];
        if (/^(DELETE|INSERT)/.test(sql.trim())) return [{}];
        assert.fail(sql);
      } };
      transactionDb = db;
      try { const result = await work(db); commits.push(state.pos_x); return result; }
      catch (error) { Object.assign(state, snapshot); surfaceWalks.length = trailCount; throw error; }
      finally { release(); }
    },
    characterFor: async () => ({ ...state }), isInHome: async () => false,
    assertNoNegotiation: async () => {}, repairInvalidCombatFor: async () => false,
    ensureActionAvailable: (character: any) => { if (character.activity_status !== 'active') throw Error('不可行动'); },
    visiblePursuitCondition: () => '1=1', monsterAttributeColumns: '', recordCardMovement: async () => {}, talentMovementArrived: async () => [],
    recordWarrantSighting: async () => {}, createCityPursuitEncounter: async () => null, recordAchievement: () => {}, goblinKingArrival: async () => null,
    appraisalProfileFor: async () => ({}), materializeMonsters: (rows: any[]) => rows,
    partyCombatants: async () => [{ ...state, speed: 20 }], monsterCombatStats: () => ({ speed: 1 }),
    isCityPursuit: () => false, resetCardMovementCharge: async () => {}, kingbeastMapTargets: (rows: any[]) => rows,
    coordinateInteractionTargetsFor: async () => [], dungeonCellAt: async () => true
  });
  const simultaneous = await Promise.allSettled([
    service.localExplorationRouteStep('fake-user', 1, 0, 0, origin),
    service.localExplorationRouteStep('fake-user', 0, 1, 0, origin)
  ]);
  assert.equal(simultaneous.filter(result => result.status === 'fulfilled').length, 1, simultaneous.map(result => result.status === 'rejected' ? String(result.reason?.stack ?? result.reason) : result.status).join('\n'));
  const rejected = simultaneous.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejectsCode('STALE_POSITION')(rejected.reason));
  assert.deepEqual(commits, [1]);
  const success = simultaneous.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<any>;
  assert.deepEqual(success.value.localMap.origin, success.value.position);
  assert.equal(success.value.localMap.origin.x, 1);
  assert.equal(success.value.localMap.surfaceScene.snapshotId, 'step:1');
  assert.equal(snapshotReads, 1, 'stale competing steps cannot create a new perception window');
  assert.equal(surfaceWalks.length, 1, 'competing stale retries do not leave a second trail');
  assert.ok(logs.every(log => log[0].includes('FROM characters') && log[0].includes('FOR UPDATE')));
  assert.equal(logs[1].length, 2, 'stale attempt only locks and checks the authoritative character row');
  const encounter = await service.localExplorationRouteStep('fake-user', 2, 0, 0, { ...origin, x: 1 });
  assert.equal(encounter.kind, 'encounter'); assert.equal(encounter.moved, true);
  assert.equal(encounter.position.x, 2); assert.equal(encounter.spawns[0].id, 77);
  assert.deepEqual(encounter.localMap.origin, encounter.position);
  assert.equal(encounter.localMap.surfaceScene.snapshotId, 'step:2');
  obstacle = { id: 'env1:dark_forest:3:0:0:0', name: '覆苔倒木', x: 3, y: 0, z: 0, regionId: 1, footprint: [{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }] };
  await assert.rejects(service.localExplorationRouteStep('fake-user', 3, 0, 0, { ...origin, x: 2 }), rejectsCode('ENVIRONMENT_BLOCKED'));
  assert.equal(state.pos_x, 2); assert.deepEqual(commits, [1, 2], 'an obstacle appearing after a preview prevents the actual step');
  const beforeStale = obstructionChecks;
  await assert.rejects(service.localExplorationRouteStep('fake-user', 1, 0, 0, origin), rejectsCode('STALE_POSITION'));
  assert.equal(obstructionChecks, beforeStale, 'stale coordinates are rejected before any environment or movement work');
  obstacle = null; clearing = true;
  await assert.rejects(service.localExplorationRouteStep('fake-user', 3, 0, 0, { ...origin, x: 2 }), /正在清理障碍物/);
  assert.equal(state.pos_x, 2); clearing = false;
  state.activity_status = 'resting';
  await assert.rejects(service.localExplorationRouteStep('fake-user', 3, 0, 0, { ...origin, x: 2 }), /不可行动/);
  assert.equal(state.pos_x, 2, 'rejected action preserves the last committed step');
  assert.equal(surfaceWalks.length, 2, 'obstacle, stale, clearing and resting failures leave no extra traces');
  assert.equal(snapshotReads, 2, 'movement rejections never return or read a destination snapshot');
  state.activity_status = 'active'; surfaceFailure = true;
  await assert.rejects(service.localExplorationRouteStep('fake-user', 3, 0, 0, { ...origin, x: 2 }), /surface persistence failure/);
  assert.equal(state.pos_x, 2, 'a failed mark write rolls the actual movement back in the same transaction');
  assert.equal(surfaceWalks.length, 2); assert.deepEqual(commits, [1, 2]);
  surfaceFailure = false; snapshotFailure = true;
  await assert.rejects(service.localExplorationRouteStep('fake-user', 3, 0, 0, { ...origin, x: 2 }), /snapshot read failure/);
  assert.equal(state.pos_x, 2, 'snapshot failure rolls back the position instead of exposing an uncommitted window');
  assert.equal(surfaceWalks.length, 2); assert.deepEqual(commits, [1, 2]);
  snapshotFailure = false;
  const retry = await service.localExplorationRouteStep('fake-user', 3, 0, 0, { ...origin, x: 2 });
  assert.deepEqual(retry.localMap.origin, retry.position);
  assert.deepEqual(commits, [1, 2, 3]); assert.equal(surfaceWalks.length, 3);
});

test('QQ direction state and Web map share continuous authorised cells across a region boundary', async () => {
  const character = { id: 1, current_region_id: 1, pos_x: 0, pos_y: 0, pos_z: 0, region_name: '世界树草原', level: 10 };
  const areas = [
    { region_id: 1, code: 'worldtree_meadow', is_enabled: 1, is_owner_only: 0, min_x: -10, max_x: 0, min_y: -10, max_y: 10 },
    { region_id: 2, code: 'dark_forest', is_enabled: 1, is_owner_only: 0, min_x: 1, max_x: 10, min_y: -10, max_y: 10 }
  ];
  const obstacle = { id: 'env1:dark_forest:2:0:0:0', name: '林边倒木', x: 2, y: 0, z: 0, regionId: 2, blocking: true, destructible: true, footprint: [{ dx: 0, dy: 0 }, { dx: 0, dy: 1 }] };
  const db = { execute: async (sql: string) => {
    assert.match(sql.trim(), /^SELECT /i);
    if (sql.includes('SELECT c.*,r.name')) return [[{ ...character }]];
    if (sql.includes('map_region_areas')) return [areas];
    if (sql.includes('player_movement_settings')) return [[{ movement_step: 3 }]];
    if (sql.includes('party_members')) return [[]];
    assert.fail(sql);
  } };
  const service = load(planningSource, {
    ...baseDependencies, getPool: async () => db, dungeonCellAt: async () => assert.fail('public boundary is not a maze'),
    environmentForCells: async (_db: unknown, cells: any[]) => {
      assert.deepEqual([...new Set(cells.map(cell => cell.regionId))].sort(), [1, 2]);
      assert.ok(cells.every(cell => cell.z === 0 && Math.abs(cell.x - character.pos_x) + Math.abs(cell.y - character.pos_y) <= 4));
      return [obstacle];
    }
  });
  const before = await service.localExplorationMap('boundary-user');
  assert.equal(before.cells.length, 41);
  assert.deepEqual(before.cells.find((cell: any) => cell.x === 1 && cell.y === 0), { x: 1, y: 0, z: 0, regionId: 2, regionCode: 'dark_forest', passable: true, reachable: true });
  assert.equal((await service.environmentDirectionState('boundary-user', before)).directions.右.canMove, true, 'current-region bounds cannot block an authorised neighbouring cell');
  const route = await service.localExplorationRoutePreview('boundary-user', 1, 0, 0);
  assert.equal(route.path[0].regionId, 2);
  Object.assign(character, { current_region_id: 2, pos_x: 1, region_name: '幽暗密林' });
  const after = await service.localExplorationMap('boundary-user'), directions = await service.environmentDirectionState('boundary-user', after);
  assert.equal(after.cells.length, 41);
  assert.equal(directions.directions.左.canMove, true, 'the prior map remains visible and traversable after crossing');
  assert.equal(directions.directions.右.canMove, false);
  assert.equal(directions.directions.右.objectId, obstacle.id);
  for (const occupied of environmentObjectCells(obstacle)) {
    const cell = after.cells.find((cell: any) => cell.x === occupied.x && cell.y === occupied.y);
    assert.equal(cell.regionCode, 'dark_forest'); assert.equal(cell.passable, false);
  }
});

test('committed step snapshots retain real map permissions, scope boundaries, and the current layer', async () => {
  const state = { id: 1, current_region_id: 1, pos_x: 0, pos_y: 0, pos_z: 0, region_name: 'town', level: 10 };
  const area = (region_id: number, code: string, min_x: number, max_x: number, z = 0, is_owner_only = 0) => ({ region_id, code, min_x, max_x, min_y: -20, max_y: 20, min_z: z, max_z: z, is_owner_only, is_enabled: 1 });
  const areas = [area(9, 'private_room', 2, 2, 0, 1), area(8, 'other_floor', -20, 20, 1), area(1, 'town', -20, 0), area(2, 'worldtree_meadow', 1, 20), area(3, 'dark_forest_dungeon', -20, 20, -1)];
  let allowOwner = false, markReads = 0, transactions = 0;
  const characterPosition = () => ({ x: state.pos_x, y: state.pos_y, z: state.pos_z, regionId: state.current_region_id });
  const region = () => areas.find(candidate => candidate.region_id === state.current_region_id)!;
  const db = { execute: async (sql: string, args: any[] = []) => {
    assert.match(sql.trim(), /^SELECT /, 'snapshot planning cannot change game state');
    if (sql.includes('SELECT c.*,r.name')) return [[{ ...state }]];
    if (sql.includes('FROM map_region_areas')) {
      assert.equal(args[0], state.pos_z, 'both the map and surface scene query only the committed floor');
      return [areas.filter(candidate => candidate.min_z <= args[0] && candidate.max_z >= args[0])];
    }
    if (sql.includes('player_movement_settings')) return [[{ movement_step: 3 }]];
    if (sql.includes('party_members')) return [[]];
    if (sql.includes('SELECT code') && sql.includes('FROM map_regions')) return [[region()]];
    if (sql.includes('FROM map_npcs')) { assert.ok([1, 2].includes(args[0])); assert.equal(args[1], 0); return [[]]; }
    if (sql.includes('FROM map_surface_marks')) { markReads++; assert.equal(args[0], 'world:0'); assert.equal(args[1], 0); return [[]]; }
    assert.fail(sql);
  } };
  const service = load(`${planningSource}\n${stepSource}`, {
    ...baseDependencies, getPool: async () => assert.fail('snapshot must remain on its movement connection'), surfaceSceneFor,
    assertOwnerOnlyRegionAccess: async (_db: unknown, _user: string, ownerOnly: boolean) => { if (ownerOnly && !allowOwner) throw Error('私有区域'); },
    environmentForCells: async (connection: unknown, cells: any[]) => {
      assert.equal(connection, db);
      assert.ok(cells.every(cell => cell.z === state.pos_z && (allowOwner || cell.regionId !== 9)));
      return [];
    },
    dungeonCellAt: async (_db: unknown, _id: number, _x: number, y: number) => y === 0,
    withTransaction: async (work: (connection: unknown) => Promise<unknown>) => { transactions++; return work(db); },
    moveToPosition: async (_db: unknown, _user: string, x: number, y: number, _perception: boolean, _limit: number, _region: unknown, _rest: boolean, expected: typeof origin) => {
      assertExpectedLocalStep(characterPosition(), { x, y, z: state.pos_z }, expected);
      const destination = areas.find(candidate => candidate.min_z === state.pos_z && x >= candidate.min_x && x <= candidate.max_x)!;
      if (destination.is_owner_only && !allowOwner) throw Error('私有区域');
      Object.assign(state, { current_region_id: destination.region_id, pos_x: x, pos_y: y });
      return { character: { ...state }, kind: 'event' };
    },
    coordinateInteractionTargetsFor: async () => []
  });
  const publicStep = await service.localExplorationRouteStep('fake-user', 1, 0, 0, origin);
  assert.deepEqual(publicStep.position, { ...origin, x: 1, regionId: 2 });
  assert.deepEqual(publicStep.localMap.origin, publicStep.position);
  assert.deepEqual(publicStep.localMap.cells.find((cell: any) => cell.x === 2 && cell.y === 0), { x: 2, y: 0, z: 0, passable: false, reachable: false });
  assert.ok(publicStep.localMap.cells.every((cell: any) => cell.z === 0 && ![8, 9].includes(cell.regionId)));
  assert.equal(publicStep.localMap.surfaceScene.scopeToken, 'world:0');
  assert.deepEqual(publicStep.localMap.surfaceScene.terrainFields.map((field: any) => field.regionId).sort(), [1, 2]);
  assert.ok(markReads > 0);
  allowOwner = true;
  const priorReads = markReads;
  const privateStep = await service.localExplorationRouteStep('fake-user', 2, 0, 0, publicStep.position);
  assert.deepEqual(privateStep.localMap.origin, privateStep.position);
  assert.equal(privateStep.position.regionId, 9);
  assert.equal(privateStep.localMap.surfaceScene, undefined, 'authorized private origin never reuses the public world surface');
  assert.equal(markReads, priorReads, 'private origin does not query public player traces');
  Object.assign(state, { current_region_id: 3, pos_z: -1, region_name: '地下迷宫' });
  const underground = await service.localExplorationRouteStep('fake-user', 3, 0, -1, characterPosition());
  assert.deepEqual(underground.localMap.origin, underground.position);
  assert.equal(underground.localMap.range, 1);
  assert.ok(underground.localMap.cells.every((cell: any) => cell.z === -1 && (!cell.regionId || cell.regionId === 3)));
  assert.equal(underground.localMap.surfaceScene, undefined);
  assert.equal(markReads, priorReads, 'underground origin does not query public player traces');
  const before = transactions;
  await assert.rejects(service.localExplorationRouteStep('fake-user', 4, 0, 0, underground.position), rejectsCode('INVALID_STEP'));
  assert.equal(transactions, before, 'cross-floor step fails before opening a movement transaction');
});

test('new route endpoints preserve authentication, story handoff, committed map snapshots, and stale errors', async () => {
  const source = readFileSync(new URL('../src/app-api/router.ts', import.meta.url), 'utf8');
  const first = source.indexOf('  /** Planning reads saved state');
  const last = source.indexOf('  /**\n   * 探索方格的即时移动', first);
  assert.ok(first >= 0 && last > first);
  const handlers = new Map<string, (ctx: any) => Promise<void>>();
  let session: unknown = { displayName: '测试', loginId: 'test' }, story = true, steps = 0, coreCommands = 0, staleStep = true;
  const authoritative = { ...origin, x: 10 };
  const committedMap = { origin: { ...authoritative, x: 11 }, range: 3, cells: [], surfaceScene: { scopeToken: 'world:0' } };
  const adventure = {
    localExplorationMap: async () => ({ origin: authoritative, range: 3, actionRange: 2, movement: { step: 2, maximum: 3 }, cells: [] }),
    localExplorationRoutePreview: async () => ({ origin: authoritative, sightRange: 3, actionRange: 2, moveRange: 2, path: [{ ...authoritative, x: 11 }], stepMilliseconds: 260 }),
    localExplorationPosition: async () => authoritative,
    battleStatus: async () => ({ targets: [] }),
    localExplorationRouteStep: async () => {
      steps++;
      if (staleStep) throw new LocalExplorationError('STALE_POSITION', '坐标已变化', 409);
      return { kind: 'event', moved: true, position: committedMap.origin, localMap: committedMap };
    }
  };
  load(source.slice(first, last), {
    router: { get: (path: string, handler: (ctx: any) => Promise<void>) => handlers.set(`GET ${path}`, handler), post: (path: string, handler: (ctx: any) => Promise<void>) => handlers.set(`POST ${path}`, handler) },
    apiPath: (path: string) => path, requireSession: async () => session,
    parseBody: async (ctx: any) => ctx.input, appSessionQqUser: async () => 'fake-user',
    apiPrefix: '/api/web/v1', appMovementNeedsStory: async () => story,
    LocalExplorationError, assertExpectedLocalStep, isLocalPosition: baseDependencies.isLocalPosition,
    executeCoreGameCommand: async () => { coreCommands++; return {}; },
    signedCoreResponse: async () => ({ presentation: 'story', text: '初行故事', actions: [] }),
    appQuickPanel: async () => ({ summary: { position: authoritative } }),
    bearer: () => 'fake-token', randomUUID: () => 'fake-id',
    apiError: (ctx: any, status: number, message: string) => { ctx.status = status; ctx.body = { ok: false, message }; },
    require: (name: string) => name === '../game/adventure.service' ? adventure : assert.fail(name)
  });
  const map: any = {}; await handlers.get('GET /explore/local-map')!(map);
  assert.equal(map.body.ok, true); assert.deepEqual(map.body.origin, authoritative);
  const preview: any = { input: { x: 11, y: 0, z: 0 } }; await handlers.get('POST /explore/route/preview')!(preview);
  assert.equal(preview.body.path.length, 1); assert.equal(coreCommands, 0); assert.equal(steps, 0);
  const handoff: any = { input: { x: 11, y: 0, z: 0, expectedFrom: authoritative } };
  await handlers.get('POST /explore/route/step')!(handoff);
  assert.equal(handoff.body.moved, false); assert.equal(handoff.body.kind, 'story');
  assert.equal(handoff.body.localMap, undefined, 'story handoff does not fabricate a successful movement snapshot');
  assert.deepEqual(handoff.body.position, authoritative, 'story response uses actual origin rather than requested destination');
  assert.equal(coreCommands, 1); assert.equal(steps, 0);
  story = false;
  const stale: any = { input: handoff.input }; await handlers.get('POST /explore/route/step')!(stale);
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'STALE_POSITION');
  assert.equal(stale.body.localMap, undefined, 'failed movement cannot serialize a destination map');
  const invalid: any = { input: { ...handoff.input, x: 12 } }; await handlers.get('POST /explore/route/step')!(invalid);
  assert.equal(invalid.status, 400); assert.equal(invalid.body.code, 'INVALID_STEP'); assert.equal(steps, 1);
  staleStep = false;
  const moved: any = { input: handoff.input }; await handlers.get('POST /explore/route/step')!(moved);
  assert.equal(moved.body.moved, true); assert.deepEqual(moved.body.localMap, committedMap);
  assert.deepEqual(moved.body.localMap.origin, moved.body.position);
  session = null;
  const anonymous: any = { input: handoff.input }; await handlers.get('POST /explore/route/step')!(anonymous);
  assert.equal(anonymous.body, undefined); assert.equal(steps, 2);
});
