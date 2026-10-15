import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { assertTravelEnvironmentClear, environmentTravelPath, travelWalkingCells, type TravelEnvironmentObject } from '../src/game/environment-travel';

const adventure = readFileSync(new URL('../src/game/adventure.service.ts', import.meta.url), 'utf8');
const connected = readFileSync(new URL('../src/game/connected-travel.service.ts', import.meta.url), 'utf8');
const between = (source: string, first: string, last: string) => {
  const start = source.indexOf(first), end = source.indexOf(last, start);
  assert.ok(start >= 0 && end > start); return source.slice(start, end);
};
const load = (source: string, dependencies: Record<string, unknown>) => {
  const module = { exports: {} as any }, code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  new Function(...Object.keys(dependencies), 'module', 'exports', code)(...Object.values(dependencies), module, module.exports);
  return module.exports;
};
const point = (x = 0, y = 0) => ({ x, y, z: 0, regionId: 1 });
const member = (id: number, npc_code: string | null = null) => ({ id, user: npc_code ? '' : `account-${id}`, npc_code, current_region_id: 1, pos_x: 0, pos_y: 0, pos_z: 0, activity_status: 'active', current_hp: 20, region_name: '幽暗森林' });
const forest = [{ region_id: 1, min_x: -2, max_x: 8, min_y: -3, max_y: 3, min_z: 0, max_z: 0, is_enabled: 1, is_owner_only: 0, danger_level: 1 }];
const rock: TravelEnvironmentObject = { x: 2, y: 0, z: 0, name: '松动岩簇', blocking: true, footprint: [{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 1, dy: 1 }] };

const fixture = (party = false) => {
  const state = {
    members: party ? [member(2, 'story-npc'), member(3), member(7)] : [member(7)],
    target: { id: 91, pos_x: 4, pos_y: 0, pos_z: 0 } as any,
    travel: null as any, route: null as any, obstacles: [rock], clearing: new Set<number>(),
    operations: [] as any[], surfaceTravels: [] as any[], arrived: true, lookupFailure: false, surfaceFailure: false,
    areas: structuredClone(forest), maps: new Set([1, 2]), shorterRoute: false
  };
  const queries: { sql: string; args: any[] }[] = [], idle: number[] = [], events: string[] = [];
  let moves = 0, regularPlans = 0, transfers = 0;
  const leader = () => state.members.find(value => value.id === 7)!;
  const db = { execute: async (sql: string, args: any[] = []) => {
    queries.push({ sql, args }); events.push(sql);
    if (sql.startsWith('SELECT pm.party_id,p.leader_character_id')) return [state.members.length > 1 ? [{ party_id: 11, leader_character_id: 7 }] : []];
    if (sql.startsWith('SELECT c.*,p.qq_user_id AS user')) { assert.match(sql, /ORDER BY c.id FOR UPDATE/); return [structuredClone([...state.members].sort((a, b) => a.id - b.id))]; }
    if (sql.startsWith('SELECT a.*,r.danger_level')) return [state.areas];
    if (sql.startsWith('SELECT DISTINCT pi.character_id,r.id AS region_id')) return [[...state.maps].flatMap(region_id => state.members.map(value => ({ character_id: value.id, region_id })))];
    if (sql.startsWith('SELECT q.character_id FROM player_leaf_route_progress')) return [[]];
    if (sql.includes(' AS reason FROM player_travels') || sql.includes("SELECT '开采' AS reason")) return [[]];
    if (sql.startsWith('SELECT 1 FROM player_travels')) return [state.travel ? [{ one: 1 }] : []];
    if (sql.startsWith('SELECT 1 FROM player_resource_mining') || sql.startsWith('SELECT 1 FROM combat_members')) return [[]];
    if (sql.startsWith('SELECT 1 FROM monster_spawns')) return [[]];
    if (sql.startsWith('SELECT spawn_id FROM player_hunt_history') || sql.startsWith('SELECT id FROM player_hunt_history')) return [[]];
    if (sql.startsWith('SELECT s.id,s.pos_x')) return [state.target ? [state.target] : []];
    if (sql.startsWith('INSERT INTO player_hunt_history')) return [{}];
    if (sql.startsWith('INSERT INTO player_travel_routes')) { state.route = JSON.parse(args[2]); return [{}]; }
    if (sql.startsWith('INSERT INTO player_travels')) {
      state.travel = { region_id: args[1], target_x: args[2], target_y: args[3], target_z: args[4], target_spawn_id: args[5], activity_type: 'hunt', destination_kind: 'normal', arrived: 1, seconds: args[6], start_at_ms: 1000, arrival_at_ms: 1000 + args[6] * 1000 }; return [{}];
    }
    if (sql.startsWith('SELECT region_id,target_x')) return [state.travel ? [{ ...state.travel, arrived: Number(state.arrived) }] : []];
    if (sql.startsWith('SELECT pos_x,pos_y,pos_z FROM monster_spawns')) return [state.target ? [state.target] : []];
    if (sql.startsWith('SELECT token,plan_json FROM player_travel_routes')) return [state.route ? [{ token: 'saved-route-token', plan_json: JSON.stringify(state.route) }] : []];
    if (sql.startsWith('DELETE FROM player_travels ')) { state.travel = null; return [{}]; }
    if (sql.startsWith('DELETE FROM player_travel_routes ')) { state.route = null; return [{}]; }
    assert.fail(sql);
  } };
  const lookup = async (_db: unknown, cells: readonly { x: number; y: number; z: number }[]) => {
    if (state.lookupFailure) throw Object.assign(Error('synthetic database failure'), { code: 'ER_SYNTHETIC' });
    return state.obstacles.filter(value => value.footprint.some(occupied => cells.some(cell => cell.x === value.x + occupied.dx && cell.y === value.y + occupied.dy && cell.z === value.z)));
  };
  const huntHelper = load(between(connected, 'export const planEnvironmentHuntWalk=', 'export const saveTravelConfirmation='), { environmentTravelPath, environmentForCells: lookup });
  const signature = load(between(connected, 'export const travelPlanSignature=', 'export const planConnectedTravel='), {});
  const savedValidation = load(between(connected, 'export const assertSavedWalkTravelAllowed=', 'export const saveTravelConfirmation='), {
    travelWalkingCells, assertLeafDestination: async () => {}, assertEnvironmentTravelClear: (_db: unknown, legs: any) => assertTravelEnvironmentClear(legs, cells => lookup(db, cells))
  });
  const functions = load(`${between(adventure, 'export const huntMonster =', 'const elementValue =')}\n${between(adventure, 'export const completeTravel =', '/**\n * 延时移动')}`, {
    readLocalExplorationCharacter: async (connection: unknown) => { assert.equal(connection, db); return { ...leader() }; },
    characterFor: async (_user: string, connection: unknown) => { assert.equal(connection, db, 'authoritative characters are read inside the transaction'); return { ...leader() }; },
    withTransaction: async (work: (connection: unknown) => Promise<any>) => {
      const snapshot = structuredClone(state);
      try { return await work(db); } catch (error) { Object.assign(state, snapshot); throw error; }
    },
    assertEnvironmentIdle: async (_db: unknown, id: number) => {
      assert.ok(events.some(value => value.includes('ORDER BY c.id FOR UPDATE')), 'all party character locks precede job checks');
      idle.push(id); if (state.clearing.has(id)) throw Error('正在清理障碍物');
    },
    isInHome: async () => false, ensureForestGuideFreeAction: async () => {}, assertNoNegotiation: async () => {},
    ensureActionAvailable: (character: any) => { if (character.activity_status !== 'active' || character.current_hp <= 0) throw Error('当前无法行动'); },
    repairInvalidCombatFor: async () => false, visiblePursuitCondition: () => '1=1',
    localPositionFor: (character: any) => ({ x: character.pos_x, y: character.pos_y, z: character.pos_z, regionId: character.current_region_id }),
    planEnvironmentHuntWalk: huntHelper.planEnvironmentHuntWalk,
    assertEnvironmentTravelClear: (_db: unknown, legs: any) => assertTravelEnvironmentClear(legs, cells => lookup(db, cells)),
    parseTravelPlan: JSON.parse, randomUUID: () => 'synthetic-route-token',
    planConnectedTravel: async () => {
      regularPlans++; const plan = structuredClone(state.route);
      if (state.shorterRoute) plan.legs = [{ ...plan.legs[0], distance: 4, seconds: 4, waypoints: [point(), point(4)] }];
      return plan;
    }, travelPlanSignature: signature.travelPlanSignature, assertSavedWalkTravelAllowed: savedValidation.assertSavedWalkTravelAllowed,
    executeTravelTransfers: async () => { transfers++; return []; },
    moveToPosition: async (_db: unknown, _user: string, x: number, y: number) => { moves++; for (const value of state.members) { value.pos_x = x; value.pos_y = y; } return { kind: 'encounter', character: { ...leader() } }; },
    recordSurfaceTravelIn: async (connection: unknown, value: any) => { assert.equal(connection, db); assert.equal(leader().pos_x, value.legs.at(-1).to.x, 'trail follows successful actual arrival'); state.surfaceTravels.push(structuredClone(value)); if (state.surfaceFailure) throw Error('synthetic surface travel persistence failure'); },
    recordCharacterOperation: async (_db: unknown, operation: unknown) => { state.operations.push(operation); }
  });
  return { state, queries, idle, functions, counts: () => ({ moves, regularPlans, transfers }) };
};

test('actual hunt saves a detour and keeps one second per walked cell without map ownership queries', async () => {
  const { functions, state, queries, counts } = fixture();
  const result = await functions.huntMonster('account-7');
  assert.equal(result.kind, 'hunt'); assert.equal(result.seconds, 6); assert.equal(state.travel.seconds, 6);
  assert.deepEqual(state.route.start, point()); assert.deepEqual(state.route.target, point(4));
  assert.equal(state.route.legs[0].distance, 6); assert.equal(state.route.legs[0].seconds, 6);
  assert.ok(state.route.legs[0].waypoints.some((value: any) => value.y === -1));
  assert.deepEqual(state.route.members, [{ id: 7, user: 'account-7' }]);
  assert.ok(!queries.some(({ sql }) => sql.includes('player_inventory'))); assert.equal(counts().regularPlans, 0);
  assert.equal(state.members[0].pos_x, 0, 'creating a timer is not an arrival');
  assert.equal(state.surfaceTravels.length, 0, 'a planned route cannot leave future traces');
  const arrival = await functions.completeTravel('account-7');
  assert.equal(arrival.kind, 'encounter'); assert.equal(arrival.arrivalActivity, 'hunt'); assert.equal(arrival.character.pos_x, 4);
  assert.equal(state.travel, null); assert.equal(state.route, null); assert.equal(counts().moves, 1);
  assert.equal(state.surfaceTravels.length, 1); assert.equal(state.surfaceTravels[0].eventKey, 'travel:saved-route-token');
  assert.equal(state.surfaceTravels[0].startedAtMs, 1000); assert.equal(state.surfaceTravels[0].arrivalAtMs, 7000);
});

test('surface travel failure rolls back the arrival, timer and trail together; retry preserves original travel timestamps', async () => {
  const { functions, state } = fixture();
  await functions.huntMonster('account-7');
  const savedRoute = structuredClone(state.route), savedTimer = structuredClone(state.travel);
  state.surfaceFailure = true;
  await assert.rejects(functions.completeTravel('account-7'), /surface travel persistence failure/);
  assert.equal(state.members[0].pos_x, 0); assert.equal(state.surfaceTravels.length, 0);
  assert.deepEqual(state.route, savedRoute); assert.deepEqual(state.travel, savedTimer);
  state.surfaceFailure = false;
  await functions.completeTravel('account-7');
  assert.equal(state.surfaceTravels.length, 1); assert.equal(state.surfaceTravels[0].startedAtMs, savedTimer.start_at_ms); assert.equal(state.surfaceTravels[0].arrivalAtMs, savedTimer.arrival_at_ms);
  assert.equal(await functions.completeTravel('account-7'), null); assert.equal(state.surfaceTravels.length, 1);
});

test('actual hunt gates all real party members under sorted locks, skips NPC jobs, and rolls back busy starts', async () => {
  const example = fixture(true); example.state.clearing.add(3);
  await assert.rejects(example.functions.huntMonster('account-7'), /正在清理障碍物/);
  assert.deepEqual(example.idle, [3]); assert.equal(example.state.route, null); assert.equal(example.state.travel, null);
  example.state.clearing.clear(); example.idle.length = 0;
  await example.functions.huntMonster('account-7');
  assert.deepEqual(example.idle, [3, 7]); assert.deepEqual(example.state.route.members.map((value: any) => value.id), [2, 3, 7]);
  example.state.clearing.add(3);
  const cancelled = await example.functions.completeTravel('account-7');
  assert.equal(cancelled.kind, 'route_cancelled'); assert.match(cancelled.text, /正在清理障碍物/);
  assert.ok(example.state.members.every(value => value.pos_x === 0)); assert.equal(example.counts().moves, 0);
});

test('arrival refuses moved targets, a newly blocked saved segment, and changed party membership', async () => {
  for (const change of [
    (example: ReturnType<typeof fixture>) => { example.state.target.pos_x = 5; },
    (example: ReturnType<typeof fixture>) => { const cell = travelWalkingCells(example.state.route.legs).find(value => value.y !== 0)!; example.state.obstacles.push({ ...rock, x: cell.x, y: cell.y, footprint: [{ dx: 0, dy: 0 }] }); },
    (example: ReturnType<typeof fixture>) => { example.state.members.push(member(8)); }
  ]) {
    const example = fixture(); await example.functions.huntMonster('account-7'); change(example);
    const result = await example.functions.completeTravel('account-7');
    assert.equal(result.kind, 'route_cancelled'); assert.equal(example.counts().moves, 0);
    assert.equal(example.state.travel, null); assert.equal(example.state.route, null);
    assert.ok(example.state.members.every(value => value.pos_x === 0));
  }
});

test('lost or cross-floor hunt targets clear both timer and route; legacy missing geometry never teleports', async () => {
  for (const change of [
    (example: ReturnType<typeof fixture>) => { example.state.target = null; },
    (example: ReturnType<typeof fixture>) => { example.state.target.pos_z = 1; },
    (example: ReturnType<typeof fixture>) => { example.state.route = null; }
  ]) {
    const example = fixture(); await example.functions.huntMonster('account-7'); change(example);
    const result = await example.functions.completeTravel('account-7');
    assert.ok(['hunt_target_lost', 'route_cancelled'].includes(result.kind));
    assert.equal(example.state.travel, null); assert.equal(example.state.route, null); assert.equal(example.counts().moves, 0);
  }
});

test('database failure rolls back a due hunt deletion; regular saved travel still completes through its original planner', async () => {
  const failed = fixture(); await failed.functions.huntMonster('account-7'); failed.state.lookupFailure = true;
  await assert.rejects(failed.functions.completeTravel('account-7'), /synthetic database failure/);
  assert.ok(failed.state.travel); assert.ok(failed.state.route); assert.equal(failed.counts().moves, 0);
  const normal = fixture(); await normal.functions.huntMonster('account-7'); normal.state.travel.activity_type = 'move'; normal.state.travel.target_spawn_id = null;
  const result = await normal.functions.completeTravel('account-7');
  assert.equal(result.kind, 'encounter'); assert.equal(result.arrivalActivity, 'move');
  assert.deepEqual(normal.counts(), { moves: 1, regularPlans: 1, transfers: 1 });
});

test('a shorter preferred walk after clearing preserves a valid saved route, while revoked original-path maps cancel', async () => {
  const safe = fixture(); await safe.functions.huntMonster('account-7');
  safe.state.travel.activity_type = 'move'; safe.state.travel.target_spawn_id = null;
  safe.state.obstacles = []; safe.state.shorterRoute = true;
  const arrived = await safe.functions.completeTravel('account-7');
  assert.equal(arrived.kind, 'encounter'); assert.equal(safe.counts().moves, 1, 'a cleared shortcut does not invalidate the already timed detour');
  const denied = fixture(); await denied.functions.huntMonster('account-7');
  denied.state.travel.activity_type = 'move'; denied.state.travel.target_spawn_id = null;
  denied.state.obstacles = []; denied.state.shorterRoute = true;
  denied.state.areas.unshift({ ...forest[0], region_id: 2, min_x: 2, max_x: 3, min_y: -1, max_y: -1, danger_level: 9 });
  denied.state.maps.delete(2);
  const cancelled = await denied.functions.completeTravel('account-7');
  assert.equal(cancelled.kind, 'route_cancelled'); assert.match(cancelled.text, /全员地图权限已经改变/);
  assert.equal(denied.counts().moves, 0, 'a valid new shortcut cannot authorize a saved path through a revoked region');
});
