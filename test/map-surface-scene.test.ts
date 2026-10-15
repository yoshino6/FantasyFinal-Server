import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import type { PoolConnection } from 'mysql2/promise';
import { generateSurfaceScenery, planSurfaceRoad, clipSurfaceRoads } from '../src/game/map-surface-scene';
import { recordSurfaceWalkIn, recordSurfaceCombatMarkIn, resolveSurfaceScope, surfaceMarkAge, surfaceMarksFromRows, surfaceOpacityAtAge, surfaceTravelSegments, surfaceWalkTtlMs, type SurfaceMarkRow } from '../src/game/map-surface-marks.service';
import type { LocalMapCell } from '../src/game/local-exploration-route';
import type { TravelLeg } from '../src/game/travel-path';

const cells = (left = -12, bottom = -12, size = 25): LocalMapCell[] => Array.from({ length: size * size }, (_, index) => ({ x: left + index % size, y: bottom + Math.floor(index / size), z: 0, regionId: 1, regionCode: 'worldtree_meadow', passable: true }));
const row = (overrides: Partial<SurfaceMarkRow> = {}): SurfaceMarkRow => ({ event_key: 'opaque', scope_key: 'world:0', region_id: 1, pos_x: 0, pos_y: 0, pos_z: 0, end_x: 1, end_y: 0, kind: 'walk', effect_seed: 17, intensity: .08, occurred_at_ms: 1000, expires_at_ms: 901000, ...overrides } as SurfaceMarkRow);

test('stable free scatter uses fractional anchors, leaves open cells and respects blockers and focus buffers', () => {
  const area = cells(), blocked = new Set(['0:0:0', '1:0:0', '0:1:0', '1:1:0']);
  const focuses = [{ id: 'gate', x: 3, y: 3, z: 0, regionId: 1 }];
  const scene = generateSurfaceScenery(area, 'world:0', blocked, focuses);
  assert.deepEqual(generateSurfaceScenery([...area].reverse(), 'world:0', blocked, focuses), scene);
  assert.ok(scene.length > 30 && scene.length < area.length / 2);
  assert.ok(scene.every(item => !blocked.has(`${Math.floor(item.x + .5)}:${Math.floor(item.y + .5)}:0`) && Math.hypot(item.x - 3, item.y - 3) >= 1.29));
  assert.ok(scene.some(item => !Number.isInteger(item.x) && !Number.isInteger(item.y)));
  assert.ok(scene.every(item => /^scenery_patch_\d+$/.test(item.assetKey) ? item.scale >= .88 && item.scale <= 1.75 : item.scale >= .25 && item.scale <= .75 && /^scenery_\d+$/.test(item.assetKey)));
  const anchors = new Set(scene.map(item => `${Math.floor(item.x + .5)}:${Math.floor(item.y + .5)}`));
  assert.ok(anchors.size < scene.length, 'some small clusters share cells instead of a single slot');
});

test('overlapping windows retain identical scenery positions and ecology-specific forms', () => {
  const broad = generateSurfaceScenery(cells(), 'world:0', new Set());
  const small = generateSurfaceScenery(cells(-3, -3, 7), 'world:0', new Set());
  for (const item of small) assert.deepEqual(broad.find(candidate => candidate.id === item.id), item);
  const snow = generateSurfaceScenery(cells().map(cell => ({ ...cell, regionCode: 'frostcrown_plateau' })), 'world:0', new Set());
  assert.ok(snow.every(item => ['scenery_patch_13', 'scenery_32', 'scenery_36', 'scenery_37', 'scenery_38', 'scenery_39', 'scenery_40', 'scenery_41'].includes(item.assetKey)));
  assert.deepEqual(generateSurfaceScenery(cells().map(cell => ({ ...cell, z: -1 })), 'world:-1', new Set()), []);
});

test('fixed roads take only cardinal legal cells and clipped output never reveals unknown cells', () => {
  const area = cells(0, 0, 7).map(cell => ({ ...cell, passable: !(cell.x === 3 && cell.y !== 6) }));
  const road = planSurfaceRoad({ id: 'a', x: 1, y: 1, z: 0, regionId: 1 }, { id: 'b', x: 5, y: 1, z: 0, regionId: 1 }, area)!;
  assert.ok(road.points.some(point => point.y === 6));
  road.points.forEach((point, index) => { assert.ok(area.find(cell => cell.x === point.x && cell.y === point.y)?.passable); if (index) assert.equal(Math.abs(point.x - road.points[index - 1].x) + Math.abs(point.y - road.points[index - 1].y), 1); });
  const visible = area.filter(cell => cell.x < 3);
  assert.ok(clipSurfaceRoads([road], visible).every(fragment => fragment.points.every(point => point.x < 3)));
  assert.equal(planSurfaceRoad({ id: 'a', x: 1, y: 1, z: 0, regionId: 1 }, { id: 'b', x: 5, y: 1, z: 1, regionId: 1 }, area), null);
});

test('footprints start opaque, fade linearly and expire at ten minutes', () => {
  assert.equal(surfaceWalkTtlMs, 600_000);
  assert.equal(surfaceOpacityAtAge(1, 0, 'walk'), 1);
  assert.equal(surfaceOpacityAtAge(1, 300_000, 'walk'), .5);
  assert.equal(surfaceOpacityAtAge(1, 600_000, 'walk'), 0);
  assert.equal(surfaceMarkAge(1000, 601000, 601000), null);
  assert.equal(surfaceMarkAge(1001, 601001, 1000), null);
  assert.deepEqual(surfaceMarkAge(1000, 601000, 601000 - 1), { ageMs: 599999, remainingMs: 1 });
});

test('read path excludes stale, future, different scope, blocked and partly hidden geometry and all identities', () => {
  const area = cells(-1, -1, 3), rows = [row(), row({ event_key: 'expired', expires_at_ms: 999 }), row({ event_key: 'future', occurred_at_ms: 5000 }), row({ event_key: 'private', scope_key: 'private:1' }), row({ event_key: 'hidden', end_x: 2 }), row({ event_key: 'blood', kind: 'blood', end_x: null, end_y: null })];
  const read = surfaceMarksFromRows(rows, area, 'world:0', 2000);
  assert.deepEqual(read.recentWalks.map(mark => mark.id), ['opaque']);
  assert.deepEqual(read.combatMarks.map(mark => mark.id), ['blood']);
  assert.ok(!/character|player|qq|user/.test(JSON.stringify(read)));
  assert.deepEqual(surfaceMarksFromRows(rows, area.map(cell => ({ ...cell, passable: false })), 'world:0', 2000), { recentWalks: [], combatMarks: [] });
});

test('mark budgets bound busy sites without a walk flood removing all combat slots', () => {
  const rows = Array.from({ length: 400 }, (_, index) => { const x = index % 20 - 10, y = Math.floor(index / 20) - 10; return row({ event_key: String(index), kind: index % 2 ? 'walk' : 'blood', pos_x: x, pos_y: y, end_x: x + 1, end_y: y }); });
  const result = surfaceMarksFromRows(rows, cells(), 'world:0', 2000);
  assert.equal(result.recentWalks.length, 192); assert.ok(result.combatMarks.length > 0 && result.combatMarks.length <= 48);
  assert.ok(result.combatMarks.reduce((sum, mark) => sum + (mark.fragments?.length ?? 0), 0) <= 768);
});

const fakeDb = (region = { code: 'worldtree_meadow', is_owner_only: 0, is_enabled: 1 }) => {
  const inserts: unknown[][] = [], keys = new Set<string>(), sqls: string[] = [];
  const connection = { execute: async (sql: string, values: unknown[] = []) => {
    sqls.push(sql);
    if (sql.startsWith('SELECT code')) return [[region]];
    if (sql.startsWith('INSERT INTO map_surface_marks')) { assert.match(sql, /ON DUPLICATE KEY UPDATE event_key=event_key$/); for (let index = 0; index < values.length; index += 13) { const mark = values.slice(index, index + 13); if (!keys.has(String(mark[0]))) { keys.add(String(mark[0])); inserts.push(mark); } } return [{ affectedRows: 1 }]; }
    if (sql.startsWith('DELETE')) return [{ affectedRows: 0 }];
    throw Error(`unexpected fake SQL ${sql}`);
  } } as unknown as PoolConnection;
  return { connection, inserts, keys, sqls };
};
test('walk persistence records verified adjacent segments once and never inserts guessed diagonal paths', async () => {
  const db = fakeDb(), points = [{ regionId: 1, x: 0, y: 0, z: 0 }, { regionId: 1, x: 1, y: 0, z: 0 }, { regionId: 1, x: 1, y: 1, z: 0 }];
  const occurredAtMs = Date.now() - 1000;
  await recordSurfaceWalkIn(db.connection, points, { eventKey: 'same-event', occurredAtMs });
  await recordSurfaceWalkIn(db.connection, points, { eventKey: 'same-event', occurredAtMs });
  assert.equal(db.inserts.length, 2);
  assert.equal(db.inserts[0][12], occurredAtMs + surfaceWalkTtlMs);
  assert.ok(!JSON.stringify(db.inserts).includes('same-event'), 'internal event source is hashed in persistence and client IDs');
  await recordSurfaceWalkIn(db.connection, [points[0], points[2]]);
  assert.equal(db.inserts.length, 2);
});

test('old timed steps do not refresh and private/underground scopes do not write', async () => {
  const db = fakeDb(), points = [{ regionId: 1, x: 0, y: 0, z: 0 }, { regionId: 1, x: 1, y: 0, z: 0 }];
  await recordSurfaceWalkIn(db.connection, points, { occurredAtMs: Date.now() - surfaceWalkTtlMs - 100 });
  assert.equal(db.inserts.length, 0);
  const privateDb = fakeDb({ code: 'private_room', is_owner_only: 1, is_enabled: 1 });
  await recordSurfaceWalkIn(privateDb.connection, points);
  assert.equal(privateDb.inserts.length, 0);
  assert.equal(await resolveSurfaceScope(db.connection, { ...points[0], z: -2 }), null);
});

test('combat persistence is deterministic and does not refresh TTL on retry', async () => {
  const db = fakeDb(), value = { eventKey: 'combat:stable', scopeKey: 'world:0', regionId: 1, x: 0, y: 0, z: 0, kind: 'blood' as const, occurredAtMs: Date.now() - 1000 };
  await recordSurfaceCombatMarkIn(db.connection, value);
  await recordSurfaceCombatMarkIn(db.connection, { ...value, occurredAtMs: Date.now() });
  assert.equal(db.inserts.length, 1);
  assert.equal(db.inserts[0][11], value.occurredAtMs);
});

test('travel timing preserves separate leg timestamps, excludes transfer geometry, and rejects missing authoritative paths/timing', () => {
  const from = { regionId: 1, x: 0, y: 0, z: 0 }, middle = { regionId: 1, x: 2, y: 0, z: 0 }, remote = { regionId: 2, x: 100, y: 100, z: 0 }, end = { regionId: 2, x: 100, y: 102, z: 0 };
  const legs: TravelLeg[] = [{ kind: 'walk', from, to: middle, distance: 2, seconds: 2, waypoints: [from, middle] }, { kind: 'portal', from: middle, to: remote, distance: 1, seconds: 1 }, { kind: 'walk', from: remote, to: end, distance: 2, seconds: 2, waypoints: [remote, end] }];
  const result = surfaceTravelSegments(legs, 1000, 6000);
  assert.equal(result.length, 2); assert.deepEqual(result[0].times, [2000, 3000]); assert.deepEqual(result[1].times, [5000, 6000]);
  assert.equal(result[1].points[0].x, 100);
  assert.deepEqual(surfaceTravelSegments([{ ...legs[0], waypoints: undefined }], 1000, 6000), []);
  assert.deepEqual(surfaceTravelSegments([{ ...legs[0], seconds: undefined }], 1000, 6000), []);
});

test('actual movement hook is after successful position write; preview is read-only and legacy env1 IDs untouched', () => {
  const adventure = readFileSync(new URL('../src/game/adventure.service.ts', import.meta.url), 'utf8');
  const move = adventure.slice(adventure.indexOf('const moveToPosition ='), adventure.indexOf('export const move', adventure.indexOf('const moveToPosition =')));
  assert.ok(move.indexOf('UPDATE characters') < move.indexOf('recordSurfaceWalkIn(connection'));
  assert.ok(move.includes('!allowRestingArrival && surfaceWalk.length > 1'));
  const preview = adventure.slice(adventure.indexOf('export const localExplorationRoutePreview'), adventure.indexOf('const moveToPosition ='));
  assert.ok(!preview.includes('recordSurfaceWalkIn'));
  const config = readFileSync(new URL('../src/game/map-environment.config.ts', import.meta.url), 'utf8');
  assert.ok(config.includes('environmentGeneratorVersion = 1'));
});
