import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as sourceGround from '../src/game/map-ground-window';
import { environmentHash } from '../src/game/map-environment.config';

const { prepareGroundWindow, groundWindowFor } = process.env.FF_GROUND_WINDOW_STAGE
  ? await import(pathToFileURL(process.env.FF_GROUND_WINDOW_STAGE).href) : sourceGround;

const origin = { x: 0, y: 0, z: 0, regionId: 1 };
const field = { regionId: 1, regionCode: 'worldtree_meadow', seed: 12345 };
const area = { region_id: 1, code: 'worldtree_meadow', danger_level: 1, is_owner_only: 0, is_enabled: 1,
  min_x: -50, max_x: 50, min_y: -50, max_y: 50, min_z: 0, max_z: 0 };

test('ground window prepares exactly two extra cells with the same terrain seeds and no interactive or hidden world data', () => {
  const result = prepareGroundWindow(origin, 3, [field], [area])!;
  assert.equal(result.cells.length, 61);
  assert.equal(result.padding, 2);
  assert.deepEqual(result.terrainFields, [field]);
  assert.ok(result.cells.every(cell => Math.abs(cell.x) + Math.abs(cell.y) <= 5 && cell.z === 0));
  assert.deepEqual(Object.keys(result).sort(), ['cells', 'padding', 'terrainFields']);
  assert.ok(result.cells.every(cell => Object.keys(cell).sort().join(',') === 'regionCode,regionId,x,y,z'));
});

test('private, disabled, instance and unauthorised higher-priority overlays stay blank instead of revealing the region below', () => {
  for (const overlay of [{ region_id: 9, code: 'private_story', is_owner_only: 1 }, { region_id: 9, code: 'dark_forest', is_enabled: 0 },
    { region_id: 9, code: 'dark_forest_dungeon' }, { region_id: 2, code: 'dark_forest' }]) {
    const result = prepareGroundWindow(origin, 3, [field], [area, { ...area, ...overlay, danger_level: 5, min_x: 3, min_y: -1, max_y: 1 }], 8)!;
    assert.ok(!result.cells.some(cell => cell.x >= 3 && cell.y >= -1 && cell.y <= 1));
    assert.ok(result.cells.every(cell => cell.regionId === 1));
  }
  const forest = { regionId: 2, regionCode: 'dark_forest', seed: 456 };
  const result = prepareGroundWindow(origin, 3, [field, forest], [area, { ...area, region_id: 2, code: 'dark_forest', danger_level: 3, min_x: 3 }])!;
  assert.ok(result.cells.some(cell => cell.regionId === 2)); assert.deepEqual(result.terrainFields, [field, forest]);
});

test('cached geometry cannot preserve a revoked area, stale seed or response mutation', () => {
  const first = prepareGroundWindow(origin, 3, [field], [area])!;
  first.cells[0].regionId = 999; first.terrainFields[0].seed = 999;
  const again = prepareGroundWindow(origin, 3, [field], [area])!;
  assert.ok(again.cells.every(cell => cell.regionId === 1)); assert.equal(again.terrainFields[0].seed, 12345);
  assert.equal(prepareGroundWindow(origin, 3, [field], [{ ...area, is_enabled: 0 }]), undefined);
  assert.equal(prepareGroundWindow(origin, 3, [field], [{ ...area, is_owner_only: 1 }]), undefined);
  assert.equal(prepareGroundWindow(origin, 3, [{ ...field, seed: 987 }], [area])!.terrainFields[0].seed, 987);
  assert.equal(prepareGroundWindow(origin, 3, [], [area]), undefined);
});

test('ground preparation rejects non-surface layers, malformed centers and excessive ranges', () => {
  for (const point of [{ ...origin, z: -1 }, { ...origin, z: 1 }, { ...origin, x: NaN }, { ...origin, regionId: 0 }]) {
    assert.equal(prepareGroundWindow(point, 3, [field], [area]), undefined);
  }
  for (const range of [-1, .5, Infinity, 33]) assert.equal(prepareGroundWindow(origin, range, [field], [area]), undefined);
  for (const padding of [-1, 0, 1, 2.5, NaN, Infinity, 13, '3', null]) {
    assert.equal(prepareGroundWindow(origin, 3, [field], [area], padding as any), undefined);
  }
});

test('every database-backed preview refreshes public/disabled/private boundaries using only SELECT and no supplied client coordinates', async () => {
  let calls = 0, enabled = 1;
  const db = { execute: async (sql: string, values: unknown[]) => {
    calls++; assert.match(sql.trim(), /^SELECT /); assert.match(sql, /is_owner_only,r.is_enabled/);
    assert.deepEqual(values, [0, 5, -5, 5, -5]); return [[{ ...area, is_enabled: enabled }]];
  } };
  const surface = { scopeToken: 'world:0', terrainFields: [field] };
  assert.equal((await groundWindowFor(db as any, origin, 3, surface))!.cells.length, 61);
  enabled = 0; assert.equal(await groundWindowFor(db as any, origin, 3, surface), undefined); assert.equal(calls, 2);
  assert.equal(await groundWindowFor(db as any, origin, 3, { ...surface, scopeToken: 'home:7' }), undefined); assert.equal(calls, 2);
});

test('movement-aware padding covers the entire visible frontier during a three-cell move and a 900ms reply', async () => {
  const range = 4, movement = { step: 3, speed: 4 };
  const db = { execute: async (_sql: string, values: unknown[]) => {
    assert.deepEqual(values, [0, 11, -11, 11, -11]); return [[area]];
  } };
  const result = (await groundWindowFor(db as any, origin, range, { scopeToken: 'world:0', terrainFields: [field] }, movement))!;
  assert.equal(result.padding, 7);
  assert.ok(movement.step / movement.speed * 1000 < 900);
  const old = prepareGroundWindow(origin, range, [field], [area])!;
  assert.ok(!old.cells.some(cell => cell.x === 0 && cell.y === 7));
  const available = new Set(result.cells.map(cell => `${cell.x}:${cell.y}`));
  // The client may finish all three known route cells before its 900ms response arrives.
  for (const [dx, dy] of [[0, 3], [3, 0], [0, -3], [-3, 0], [2, 1]]) {
    for (let y = -range; y <= range; y++) for (let x = -range; x <= range; x++) {
      if (Math.abs(x) + Math.abs(y) <= range) assert.ok(available.has(`${dx + x}:${dy + y}`));
    }
  }
});

test('padding uses the larger movement horizon, stays bounded, and keeps the SQL read and output radius identical', async () => {
  const surface = { scopeToken: 'world:0', terrainFields: [field] };
  for (const [movement, padding] of [
    [{ step: 1, speed: 1 }, 3], [{ step: 8, speed: 1 }, 9], [{ step: 1, speed: 4 }, 7],
    [{ step: 12, speed: 12 }, 12], [{ step: Number.MAX_VALUE, speed: Number.MAX_VALUE }, 12],
  ] as const) {
    const radius = 32 + padding;
    const db = { execute: async (_sql: string, values: unknown[]) => {
      assert.deepEqual(values, [0, radius, -radius, radius, -radius]); return [[area]];
    } };
    const result = (await groundWindowFor(db as any, origin, 32, surface, movement))!;
    assert.equal(result.padding, padding);
    assert.equal(result.cells.length, 1 + 2 * radius * (radius + 1));
    assert.ok(result.cells.length <= 3961 && result.cells.length < 4096);
    assert.ok(result.cells.every(cell => Math.abs(cell.x) + Math.abs(cell.y) <= radius));
  }
});

test('omitted or malformed movement keeps the legacy two-cell padding without coercing strings', async () => {
  const db = { execute: async (_sql: string, values: unknown[]) => {
    assert.deepEqual(values, [0, 5, -5, 5, -5]); return [[area]];
  } };
  const surface = { scopeToken: 'world:0', terrainFields: [field] };
  for (const movement of [undefined, null, {}, { step: NaN, speed: Infinity }, { step: -5, speed: -3 },
    { step: '8', speed: '3' }, { step: true, speed: false }, { step: 0, speed: 0 }]) {
    const result = (await groundWindowFor(db as any, origin, 3, surface, movement as any))!;
    assert.equal(result.padding, 2); assert.equal(result.cells.length, 61);
  }
});

test('cached geometry keeps its requested padding even when two ranges produce the same radius', () => {
  const widePadding = prepareGroundWindow(origin, 3, [field], [area], 4)!;
  const oldCaller = prepareGroundWindow(origin, 5, [field], [area])!;
  assert.deepEqual(widePadding.cells, oldCaller.cells);
  assert.equal(widePadding.padding, 4); assert.equal(oldCaller.padding, 2);
  widePadding.padding = 12;
  assert.equal(prepareGroundWindow(origin, 3, [field], [area], 4)!.padding, 4);
});

test('expanded previews refresh revocations and never read private scopes, other layers or malformed centers', async () => {
  let calls = 0;
  let areas = [area];
  const db = { execute: async (sql: string, values: unknown[]) => {
    calls++; assert.match(sql.trim(), /^SELECT /);
    assert.deepEqual(values, [0, 9, -9, 9, -9]); return [areas];
  } };
  const surface = { scopeToken: 'world:0', terrainFields: [field] };
  const movement = { step: 4, speed: 4 };
  const first = (await groundWindowFor(db as any, origin, 2, surface, movement))!;
  assert.ok(first.cells.some(cell => cell.x === 9));
  areas = [area, { ...area, region_id: 9, code: 'private_story', danger_level: 5, is_owner_only: 1, min_x: 5 }];
  const second = (await groundWindowFor(db as any, origin, 2, surface, movement))!;
  assert.ok(!second.cells.some(cell => cell.x >= 5));
  areas = [{ ...area, is_enabled: 0 }];
  assert.equal(await groundWindowFor(db as any, origin, 2, surface, movement), undefined);
  for (const scopeToken of ['world:1', 'home:7', 'private:1']) {
    assert.equal(await groundWindowFor(db as any, origin, 2, { ...surface, scopeToken }, movement), undefined);
  }
  for (const point of [{ ...origin, z: 1 }, { ...origin, z: -1 }, { ...origin, x: NaN }, { ...origin, y: .5 }, { ...origin, regionId: 0 }]) {
    assert.equal(await groundWindowFor(db as any, point, 2, surface, movement), undefined);
  }
  assert.equal(calls, 3);
});

test('public ground receipt prepares a newly adjacent public region before that region is observed', async () => {
  const forest = { ...area, region_id: 2, code: 'dark_forest', danger_level: 3, min_x: 6 };
  const db = { execute: async (sql: string, values: unknown[]) => {
    assert.match(sql.trim(), /^SELECT /); assert.deepEqual(values, [0, 11, -11, 11, -11]);
    return [[area, forest]];
  } };
  const surface = { scopeToken: 'world:0', terrainFields: [field] };
  const result = (await groundWindowFor(db as any, origin, 4, surface, { step: 3, speed: 4 }))!;
  assert.equal(result.scopeToken, 'world:0');
  assert.ok(result.cells.some(cell => cell.x === 6 && cell.y === 0 && cell.regionId === 2));
  assert.deepEqual(result.terrainFields, [field, { regionId: 2, regionCode: 'dark_forest', seed: environmentHash('surface1:world:0:dark_forest') }]);
  assert.deepEqual(surface.terrainFields, [field]);
  assert.ok(result.cells.every(cell => Object.keys(cell).sort().join(',') === 'regionCode,regionId,x,y,z'));
  assert.deepEqual(Object.keys(result).sort(), ['cells', 'padding', 'scopeToken', 'terrainFields']);
  // Low-level callers still receive only their explicitly registered fields and no receipt.
  const strict = prepareGroundWindow(origin, 4, [field], [area, forest], 7)!;
  assert.equal(strict.scopeToken, undefined);
  assert.ok(!strict.cells.some(cell => cell.regionId === 2));
});

test('fresh private, disabled and special-instance neighbors never gain terrain fields or reveal lower priority ground', async () => {
  for (const neighbor of [
    { code: 'private_story', is_owner_only: 1 }, { code: 'dark_forest', is_owner_only: 1 },
    { code: 'dark_forest', is_enabled: 0 }, { code: 'dark_forest_dungeon' }, { code: 'arena_trial' },
  ]) {
    const overlay = { ...area, region_id: 2, danger_level: 5, min_x: 6, ...neighbor };
    const db = { execute: async () => [[area, overlay]] };
    const result = (await groundWindowFor(db as any, origin, 4, { scopeToken: 'world:0', terrainFields: [field] }, { step: 3, speed: 4 }))!;
    assert.deepEqual(result.terrainFields, [field]);
    assert.ok(!result.cells.some(cell => cell.x >= 6));
  }
  const forest = { ...area, region_id: 2, code: 'dark_forest', danger_level: 3, min_x: 6 };
  const privateOverlay = { ...forest, region_id: 3, code: 'private_story', danger_level: 5, is_owner_only: 1 };
  const db = { execute: async () => [[area, forest, privateOverlay]] };
  const result = (await groundWindowFor(db as any, origin, 4, { scopeToken: 'world:0', terrainFields: [field] }, { step: 3, speed: 4 }))!;
  assert.deepEqual(result.terrainFields, [field]);
  assert.ok(!result.cells.some(cell => cell.x >= 6));
});

test('public neighbor expansion preserves existing field seeds and refuses conflicting ids or codes', async () => {
  const forest = { ...area, region_id: 2, code: 'dark_forest', danger_level: 3, min_x: 6 };
  const db = { execute: async () => [[area, forest]] };
  const savedForest = { regionId: 2, regionCode: 'dark_forest', seed: 987 };
  const existing = { scopeToken: 'world:0', terrainFields: [field, savedForest] };
  const result = (await groundWindowFor(db as any, origin, 4, existing, { step: 3, speed: 4 }))!;
  assert.deepEqual(result.terrainFields, [field, savedForest]);
  assert.deepEqual(existing.terrainFields, [field, savedForest]);
  for (const conflict of [{ regionId: 2, regionCode: 'other_public_region', seed: 321 },
    { regionId: 9, regionCode: 'dark_forest', seed: 654 }]) {
    const surface = { scopeToken: 'world:0', terrainFields: [field, conflict] };
    const blocked = (await groundWindowFor(db as any, origin, 4, surface, { step: 3, speed: 4 }))!;
    assert.deepEqual(blocked.terrainFields, [field]);
    assert.ok(!blocked.cells.some(cell => cell.x >= 6));
    assert.deepEqual(surface.terrainFields, [field, conflict]);
  }
  // Public neighbor enumeration cannot invent the original observed-origin authorization.
  assert.equal(await groundWindowFor(db as any, origin, 4, { scopeToken: 'world:0', terrainFields: [] }, { step: 3, speed: 4 }), undefined);
});

test('new public neighbor ground is revoked by the next fresh area read even after a cached receipt', async () => {
  let forest = { ...area, region_id: 2, code: 'dark_forest', danger_level: 3, min_x: 6 };
  const db = { execute: async () => [[area, forest]] };
  const surface = { scopeToken: 'world:0', terrainFields: [field] };
  const first = (await groundWindowFor(db as any, origin, 4, surface, { step: 3, speed: 4 }))!;
  assert.ok(first.terrainFields.some(item => item.regionId === 2));
  forest = { ...forest, is_owner_only: 1 };
  const revoked = (await groundWindowFor(db as any, origin, 4, surface, { step: 3, speed: 4 }))!;
  assert.deepEqual(revoked.terrainFields, [field]);
  assert.ok(!revoked.cells.some(cell => cell.x >= 6));
});
