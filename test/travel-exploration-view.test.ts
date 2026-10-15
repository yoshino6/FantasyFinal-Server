import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import { buildTravelVisual, travelObservationPoint } from '../src/game/travel-visual';
import type { TravelPlan } from '../src/game/connected-travel.service';

const servicePath = process.env.FF_TRAVEL_VIEW_SERVICE_STAGE ?? fileURLToPath(new URL('../src/game/adventure.service.ts', import.meta.url));
const staged = servicePath.endsWith('.js');
const source = readFileSync(servicePath, 'utf8');
const visualFunctions = staged ? await import(pathToFileURL(resolve(dirname(servicePath), 'travel-visual.js')).href) : { buildTravelVisual, travelObservationPoint };
const between = (start: string, end: string) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, start);
  return source.slice(first, last);
};
const load = (text: string, dependencies: Record<string, unknown>) => {
  const module = { exports: {} as any };
  const code = transformSync(text, { loader: 'ts', format: 'cjs' }).code;
  new Function(...Object.keys(dependencies), 'module', 'exports', code)(...Object.values(dependencies), module, module.exports);
  return module.exports;
};
const point = (x: number, y = 0, z = 0, regionId = 1) => ({ x, y, z, regionId });
const localPositionFor = (character: any) => point(character.pos_x, character.pos_y, character.pos_z, character.current_region_id);
const character = { id: 7, current_region_id: 1, pos_x: 0, pos_y: 0, pos_z: 0, region_name: '草原', level: 30 };
const plan: TravelPlan = { leaderId: 7, members: [{ id: 7, user: 'private-subject' }], start: point(0), target: point(8, 0, 0, 2), seconds: 8, destinationKind: 'normal',
  legs: [{ kind: 'walk', from: point(0), to: point(8, 0, 0, 2), distance: 8, seconds: 8, waypoints: [point(0), point(4), point(5, 0, 0, 2), point(8, 0, 0, 2)] }] };
const regions = [{ id: 1, code: 'worldtree_meadow', name: '草原', is_owner_only: 0, is_enabled: 1 }, { id: 2, code: 'dark_forest', name: '森林', is_owner_only: 0, is_enabled: 1 }];
const saved = { region_id: 2, target_x: 8, target_y: 0, target_z: 0, route_token: 'fixture-travel-id', plan_json: JSON.stringify(plan), start_at_ms: 1000, arrival_at_ms: 9000, server_now_ms: 6500 };
const surfaceRegionEnabled = (code: string, owner: number, enabled: number) => Boolean(enabled) && !owner && !/(?:arena|test|private|story|trial|dungeon|home)/i.test(code);
const reader = load(`${between('const readTravelExplorationView =', '/** A bounded, read-only view')}\nexport { readTravelExplorationView };`, {
  localPositionFor, parseTravelPlan: (value: string) => JSON.parse(value), surfaceRegionEnabled, ...visualFunctions
}).readTravelExplorationView;

test('actual travel view samples only saved move geometry and database time without moving the character', async () => {
  const queries: string[] = [], before = JSON.stringify(character);
  const db = { execute: async (sql: string, values: unknown[]) => {
    queries.push(sql); assert.match(sql.trim(), /^SELECT /);
    if (sql.includes('FROM player_travels')) { assert.deepEqual(values, [7]); return [[saved]]; }
    assert.deepEqual(values, [1, 2]); return [regions];
  } };
  const view = await reader(db, character);
  assert.deepEqual(view, { id: saved.route_token, serverNow: 6500, committedOrigin: point(0), position: { ...point(5, 0, 0, 2), regionCode: 'dark_forest', regionName: '森林' } });
  assert.match(queries[0], /UNIX_TIMESTAMP\(NOW\(6\)\)/);
  assert.match(queries[0], /activity_type='move'.*destination_kind='normal'/s);
  assert.match(queries[0], /route.state='active'/);
  assert.equal(JSON.stringify(character), before);
  assert.equal(JSON.stringify(view).includes('private-subject'), false);
});

test('missing or mismatched old routes and private, closed or instance regions omit the travel view', async () => {
  for (const value of [undefined, { ...saved, plan_json: '{broken' }, { ...saved, target_x: 99 },
    { ...saved, plan_json: JSON.stringify({ ...plan, destinationKind: 'home' }) },
    { ...saved, plan_json: JSON.stringify({ ...plan, legs: plan.legs.map(leg => ({ ...leg, waypoints: undefined })) }) }]) {
    const db = { execute: async (sql: string) => sql.includes('FROM player_travels') ? [[...(value ? [value] : [])]] : [regions] };
    assert.equal(await reader(db, character), undefined);
  }
  for (const forbidden of [{ is_owner_only: 1 }, { is_enabled: 0 }, { code: 'dark_forest_dungeon' }, { code: 'player_home' }]) {
    const db = { execute: async (sql: string) => sql.includes('FROM player_travels') ? [[saved]] : [[regions[0], { ...regions[1], ...forbidden }]] };
    assert.equal(await reader(db, character), undefined);
  }
  const changed = { ...character, pos_x: 1 };
  assert.equal(await reader({ execute: async () => [[saved]] }, changed), undefined);
  const failure = { code: 'ER_DBACCESS_DENIED_ERROR' };
  await assert.rejects(reader({ execute: async (sql: string) => { if (sql.includes('FROM player_travels')) return [[saved]]; throw failure; } }, character), error => error === failure);
});

const mapFixture = (options: { inHome?: boolean; dungeon?: boolean; denied?: boolean } = {}) => {
  const actual = { ...character, ...(options.dungeon ? { region_name: '地下迷宫' } : {}) };
  const view = { id: saved.route_token, serverNow: saved.server_now_ms, position: { ...point(5, 0, 0, 2), regionCode: 'dark_forest', regionName: '森林' }, committedOrigin: point(0) };
  const origins: any[] = [], scopes: string[] = [], environmentCharacterIds: unknown[] = [];
  let viewReads = 0, nearbyReads = 0;
  const db = { execute: async (sql: string) => { assert.match(sql.trim(), /^SELECT /); return [[]]; } };
  const service = load(`${between(`${staged ? '' : 'export '}const localExplorationMap =`, '/** QQ 与网页共用')}\n${staged ? 'export { localExplorationMap };' : ''}`, {
    getPool: async () => db, readLocalExplorationCharacter: async () => actual, localPositionFor,
    heartCorrections: new WeakMap(), heartGrowthAdjustment: async () => ({}), explorationCardProfile: async () => ({}),
    inventoryForCharacter: async () => ({ movementSpeed: 2 }), finalAttribute: () => 20, perceptionRange: () => 3,
    equippedEnchantmentEffects: async () => ({}), isInHome: async () => Boolean(options.inHome),
    readTravelExplorationView: async () => { viewReads++; return view; },
    perceivedLocalMapCells: async (_db: unknown, _user: string, origin: any) => { origins.push({ ...origin }); return [{ ...origin, regionCode: origin.regionId === 1 ? 'worldtree_meadow' : 'dark_forest', passable: !(options.denied && origin.regionId === 2) }]; },
    environmentForCells: async (_db: unknown, _cells: any, id: unknown) => { environmentCharacterIds.push(id); return [{ id: 'tree', canClear: true, blocking: false }]; },
    environmentObjectCells: () => [], environmentClearStatus: async () => null,
    surfaceSceneFor: async (_db: unknown, origin: any) => { scopes.push(`world:${origin.z}`); return { scopeToken: `world:${origin.z}` }; },
    groundWindowFor: async () => undefined,
    nearbyPointsForWindow: async (_user: string, observer: any, _db: unknown, cells: any[], readOnly: boolean) => {
      nearbyReads++; assert.equal(readOnly, true); assert.equal(observer.current_region_id, 2); assert.equal(cells[0].x, 5);
      return { points: [{ name: '沿途树木', observedOnly: true }], range: 3, actionRange: 3 };
    },
    localReachableCells: (_origin: any, cells: any[]) => cells.map(cell => ({ ...cell, reachable: true }))
  });
  return { actual, origins, scopes, environmentCharacterIds, read: (requested?: 'travel') => service.localExplorationMap('fixture-user', db, requested), counters: () => ({ viewReads, nearbyReads }) };
};

test('actual local-map changes only the optional observation window and preserves actions and scope', async () => {
  const f = mapFixture(), before = JSON.stringify(f.actual);
  const ordinary = await f.read();
  assert.deepEqual(ordinary.origin, point(0)); assert.equal(ordinary.travelView, undefined); assert.equal(ordinary.cells[0].reachable, true);
  assert.equal(f.counters().viewReads, 0);
  const observed = await f.read('travel');
  assert.equal(observed.origin.x, 5); assert.equal(observed.travelView.serverNow, 6500); assert.deepEqual(observed.travelView.committedOrigin, point(0));
  assert.equal(observed.environment[0].canClear, false); assert.equal(observed.cells[0].reachable, false); assert.equal(observed.nearby.points[0].observedOnly, true);
  assert.deepEqual(f.environmentCharacterIds, [7, undefined]);
  assert.deepEqual(f.scopes, ['world:0', 'world:0']);
  assert.equal(JSON.stringify(f.actual), before);
});

test('actual local-map falls back to committed origin when permissions or instance scope prohibit observation', async () => {
  const denied = mapFixture({ denied: true }), result = await denied.read('travel');
  assert.deepEqual(result.origin, point(0)); assert.equal(result.travelView, undefined); assert.equal(result.nearby, undefined);
  assert.deepEqual(denied.origins.map(origin => origin.x), [5, 0]);
  assert.equal(result.environment[0].canClear, true); assert.equal(denied.counters().nearbyReads, 0);
  for (const option of [{ inHome: true }, { dungeon: true }]) {
    const f = mapFixture(option), response = await f.read('travel');
    assert.equal(f.counters().viewReads, 0); assert.equal(response.travelView, undefined); assert.deepEqual(response.origin, point(0));
  }
});

test('actual GET route only accepts the travel view selector, never supplied origin or progress', async () => {
  const routerPath = process.env.FF_TRAVEL_VIEW_ROUTER_STAGE ?? fileURLToPath(new URL('../src/app-api/router.ts', import.meta.url));
  const routerSource = readFileSync(routerPath, 'utf8'), quote = routerPath.endsWith('.js') ? '"' : "'";
  const start = routerSource.indexOf(`router.get(apiPath(${quote}/explore/local-map${quote})`), end = routerSource.indexOf(`router.get(apiPath(${quote}/explore/environment${quote})`, start);
  assert.ok(start >= 0 && end > start, 'actual local-map GET route boundaries');
  let handler: (context: any) => Promise<void> = async () => {}, calls: any[][] = [];
  const code = routerSource.slice(start, end).replace(/await import\((['"])\.\.\/game\/adventure\.service(?:\.js)?\1\)/, 'await loadAdventure()');
  load(code, { router: { get: (_path: string, value: any) => { handler = value; } }, apiPath: (path: string) => path,
    requireSession: async () => ({}), appSessionQqUser: async () => 'session-user',
    loadAdventure: async () => ({ localExplorationMap: async (...args: any[]) => { calls.push(args); return { origin: point(0) }; } }) });
  for (const query of [{ view: 'travel', x: 9999, y: 9999, progress: 1 }, { view: 'arbitrary', x: 9999 }, { view: ['travel'] }, {}]) await handler({ query });
  assert.deepEqual(calls, [['session-user', undefined, 'travel'], ['session-user', undefined, undefined], ['session-user', undefined, undefined], ['session-user', undefined, undefined]]);
});
