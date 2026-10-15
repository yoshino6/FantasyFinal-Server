import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { initializeMapSurfaceMarks } from '../src/database/map-surface-marks';
import { clipSurfacePaintToCell, surfaceMarkPaint } from '../src/game/map-surface-mark-geometry';
import { fixedSurfaceRoads, clipSurfaceRoads, generateSurfaceScenery, sceneryPairSpacing, surfaceSceneFor } from '../src/game/map-surface-scene';
import { readSurfaceMarks, recordSurfaceCombatMarkIn, recordSurfaceTravelIn, recordSurfaceWalkIn, resolveSurfaceScope, surfaceMarksFromRows, surfaceTravelSegments, surfaceWalkTtlMs, type SurfaceMarkRow } from '../src/game/map-surface-marks.service';
import { environmentObjectCells, generateEnvironmentForCells, type EnvironmentArea } from '../src/game/map-environment.config';
import type { LocalMapCell } from '../src/game/local-exploration-route';
import type { TravelLeg } from '../src/game/travel-path';
import { buildSurfaceFixtures } from './create-map-surface-fixture';

const cells = (left = -8, bottom = -8, size = 17): LocalMapCell[] => Array.from({ length: size * size }, (_, index) => ({ x: left + index % size, y: bottom + Math.floor(index / size), z: 0, regionId: 1, regionCode: 'dark_forest', passable: true }));
const row = (overrides: Partial<SurfaceMarkRow> = {}): SurfaceMarkRow => ({ event_key: 'anonymous-id', scope_key: 'world:0', region_id: 1, pos_x: 0, pos_y: 0, pos_z: 0, end_x: null, end_y: null, kind: 'blood', effect_seed: 17, intensity: .8, occurred_at_ms: 1000, expires_at_ms: 43_201_000, ...overrides } as SurfaceMarkRow);
const authorised = (point: { x: number; y: number }, known: readonly LocalMapCell[]) => known.some(cell => cell.passable && cell.regionId === 1 && cell.z === 0 && cell.regionCode && point.x >= cell.x - .5 && point.x <= cell.x + .5 && point.y >= cell.y - .5 && point.y <= cell.y + .5);
const area = { region_id: 1, code: 'dark_forest', is_owner_only: 0, is_enabled: 1, danger_level: 1, min_x: -50, max_x: 50, min_y: -50, max_y: 50, min_z: 0, max_z: 0 };
const envArea: EnvironmentArea = { regionId: 1, code: area.code, enabled: true, danger: 1, minX: -50, maxX: 50, minY: -50, maxY: 50, minZ: 0, maxZ: 0 };

test('hidden-centre splatter sends only authorised same-region polygon fragments and a visible anchor', () => {
  const known = cells(0, 0, 1), values = [row({ pos_x: 1 }), row({ event_key: 'other-region', pos_x: 1, region_id: 2 }), row({ event_key: 'other-instance', pos_x: 1, scope_key: 'instance:7' }), row({ event_key: 'other-floor', pos_x: 1, pos_z: 1 }), row({ event_key: 'outside-halo', pos_x: 3 })];
  const result = surfaceMarksFromRows(values, known, 'world:0', 2000);
  assert.equal(result.combatMarks.length, 1);
  const mark = result.combatMarks[0];
  assert.equal(mark.id, 'anonymous-id'); assert.ok(mark.fragments!.length > 0);
  assert.ok(authorised(mark, known)); assert.ok(mark.x !== 1 || mark.y !== 0, 'hidden origin is not used as a public anchor');
  assert.ok(mark.fragments!.every(fragment => fragment.opacity >= 0 && fragment.opacity <= 1 && fragment.points.length >= 3 && fragment.points.every(point => authorised(point, known))));
  assert.ok(!/pos_x|pos_y|bounds|origin|actor|character|qq_user/.test(JSON.stringify(mark)));
  assert.deepEqual(surfaceMarksFromRows(values, known.map(cell => ({ ...cell, passable: false })), 'world:0', 2000).combatMarks, []);
  assert.deepEqual(surfaceMarksFromRows(values, known.map(cell => ({ ...cell, regionCode: undefined })), 'world:0', 2000).combatMarks, []);
  assert.deepEqual(surfaceMarksFromRows(values, known.map(cell => ({ ...cell, regionCode: 'private_story' })), 'world:0', 2000).combatMarks, []);
});

test('blood geometry is deterministic across window order and translated negative/large coordinates', () => {
  const paint = surfaceMarkPaint(-16, 17, 17, 'blood', .8);
  assert.deepEqual(surfaceMarkPaint(-16, 17, 17, 'blood', .8), paint);
  assert.ok(paint.length > 8 && paint[0].points.length >= 36);
  const broad = cells(-18, 15, 5), narrow = broad.filter(cell => cell.x === -15 && cell.y === 17);
  const broadMark = surfaceMarksFromRows([row({ pos_x: -16, pos_y: 17 })], broad, 'world:0', 2000).combatMarks[0];
  const narrowMark = surfaceMarksFromRows([row({ pos_x: -16, pos_y: 17 })], narrow, 'world:0', 2000).combatMarks[0];
  assert.ok(narrowMark.fragments!.length > 0);
  for (const fragment of narrowMark.fragments!) assert.ok(broadMark.fragments!.some(candidate => JSON.stringify(candidate) === JSON.stringify(fragment)), 'window changes only remove pieces, never regenerate a different splat');
  assert.deepEqual(surfaceMarksFromRows([row({ pos_x: -16, pos_y: 17 })], [...broad].reverse(), 'world:0', 2000), surfaceMarksFromRows([row({ pos_x: -16, pos_y: 17 })], broad, 'world:0', 2000));
  const big = 2_000_000_000;
  const clip = clipSurfacePaintToCell([{ x: big + .49, y: big + .49 }, { x: big + .52, y: big + .49 }, { x: big + .49, y: big + .52 }], { x: big, y: big });
  assert.ok(clip.length >= 3, 'relative polygon area keeps a tiny droplet at large integer map coordinates');
});

test('busy combat sites retain newest distinct residue without stacking retries or malformed values', () => {
  const rows = [row({ event_key: 'old', occurred_at_ms: 1000 }), row({ event_key: 'new', occurred_at_ms: 1500 }), row({ event_key: 'slime', kind: 'slime' }), row({ event_key: 'bad-seed', pos_x: 1, effect_seed: NaN }), row({ event_key: 'half-cell', pos_x: .5 }), row({ event_key: 'future', pos_x: 1, occurred_at_ms: 3000 })];
  const result = surfaceMarksFromRows(rows, cells(), 'world:0', 2000);
  assert.deepEqual(result.combatMarks.map(mark => mark.id), ['new', 'slime']);
  const longExpiry = surfaceMarksFromRows([row({ expires_at_ms: 1e14 }), row({ event_key: 'walk-long-expiry', kind: 'walk', end_x: 1, end_y: 0, expires_at_ms: 1e14 })], cells(), 'world:0', 2000);
  assert.equal(longExpiry.combatMarks[0].remainingMs, 43_200_000 - 1000); assert.equal(longExpiry.recentWalks[0].remainingMs, surfaceWalkTtlMs - 1000);
});

test('surface GET uses only bounded scoped SELECTs and a 1.5-cell edge halo, with no cleanup writes', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const db = { execute: async (sql: string, values: unknown[]) => { queries.push({ sql, values }); return [sql.includes("kind IN") ? [row({ pos_x: 2 })] : []]; } } as unknown as Pool;
  const known = [{ x: 0, y: 0, z: 0, regionId: 1, regionCode: 'dark_forest', passable: true }, { x: 1, y: 0, z: 0, regionId: 1, regionCode: 'dark_forest', passable: true }, { x: -1, y: 0, z: 0, regionId: 2, regionCode: 'worldtree_meadow', passable: true }, { x: 100, y: 100, z: 0, passable: false }, { x: 100, y: 100, z: 1, regionId: 8, regionCode: 'dark_forest', passable: true }, { x: 100, y: 100, z: 0, regionId: 9, regionCode: 'private_room', passable: true }];
  const result = await readSurfaceMarks(db, known, 'world:0', 2000);
  assert.equal(queries.length, 2); assert.ok(queries.every(query => query.sql.trim().startsWith('SELECT')));
  assert.match(queries[0].sql, /LIMIT 192$/); assert.match(queries[1].sql, /LIMIT 96$/);
  assert.deepEqual(queries[0].values, ['world:0', 0, 1, 2, 2000, 2000, -1, 1, 0, 0]);
  assert.deepEqual(queries[1].values, ['world:0', 0, 1, 2, 2000, 2000, -3, 3, -2, 2]);
  assert.equal(result.combatMarks.length, 1);
  await readSurfaceMarks(db, known, 'instance:7', 2000); assert.equal(queries.length, 2);
});

test('surface schema creation is idempotent and only appends the missing window index', async () => {
  for (const hasIndex of [true, false]) {
    const sqls: string[] = [];
    const pool = { query: async (sql: string) => { sqls.push(sql); return [sql.startsWith('SELECT') && hasIndex ? [{ INDEX_NAME: 'idx_surface_window' }] : []]; } } as unknown as Pool;
    await initializeMapSurfaceMarks(pool);
    assert.match(sqls[0], /CREATE TABLE IF NOT EXISTS map_surface_marks/); assert.match(sqls[0], /PRIMARY KEY \(event_key\)/); assert.match(sqls[0], /idx_surface_expiry \(expires_at_ms\)/);
    assert.equal(sqls.filter(sql => sql.startsWith('ALTER')).length, hasIndex ? 0 : 1);
    assert.ok(sqls.every(sql => !/^\s*(DROP|TRUNCATE|DELETE|UPDATE)\b/.test(sql)));
  }
  for (const failure of [{ code: 'ER_DUP_KEYNAME', errno: 1061 }, { code: 'ER_PERMISSION_DENIED', errno: 1142 }]) {
    const pool = { query: async (sql: string) => { if (sql.startsWith('ALTER')) throw failure; return [[]]; } } as unknown as Pool;
    if (failure.errno === 1061) await initializeMapSurfaceMarks(pool);
    else await assert.rejects(initializeMapSurfaceMarks(pool), error => error === failure);
  }
});

test('fixed road centres survive window changes and cleared obstacles; public IDs are opaque', () => {
  const known = cells(-20, -20, 41), focuses = [{ id: 'npc:unseen-8842', x: -5, y: -2, z: 0, regionId: 1 }, { id: 'site:unseen-9911', x: 4, y: 2, z: 0, regionId: 1 }, { id: 'npc:other-7711', x: 8, y: -4, z: 0, regionId: 1 }];
  const roads = fixedSurfaceRoads(known, [area], focuses);
  assert.ok(roads.length >= 1 && roads.length <= 3);
  assert.ok(roads.every(road => /^road1:[a-f0-9]{24}$/.test(road.id))); assert.ok(!/unseen|npc:|site:/.test(JSON.stringify(roads)));
  const obstacles = generateEnvironmentForCells([envArea], known, focuses.map(focus => ({ ...focus, radius: 2 })));
  const blocked = new Set(obstacles.filter(object => object.blocking).flatMap(environmentObjectCells).map(point => `${point.x}:${point.y}`));
  assert.ok(roads.every(road => road.points.every(point => !blocked.has(`${point.x}:${point.y}`))));
  const small = known.filter(cell => cell.x >= -3 && cell.x <= 2 && cell.y >= -4 && cell.y <= 4);
  const smallRoads = fixedSurfaceRoads(small.map(cell => ({ ...cell, passable: false })), [area], [...focuses].reverse());
  for (const road of smallRoads) assert.deepEqual(roads.find(candidate => candidate.id === road.id), road, 'the complete plan does not depend on visible passability/cleanup');
  const liveCells = small.map(cell => ({ ...cell, passable: !(cell.x === 0 && cell.y === 0) }));
  assert.ok(clipSurfaceRoads(smallRoads, liveCells).every(road => road.points.every(point => liveCells.some(cell => cell.x === point.x && cell.y === point.y && cell.passable))));
  const closed = [{ ...area, region_id: 2, is_owner_only: 1, danger_level: 9, min_x: -1, max_x: 1, min_y: -50, max_y: 50 }, area];
  assert.deepEqual(fixedSurfaceRoads(known, closed, focuses.slice(0, 2)), [], 'roads cannot cross a private covering map');
});

test('scatter thins deterministically across negative chunk edges, with stable minimum spacing', () => {
  const broad = generateSurfaceScenery(cells(-32, -32, 49), 'world:0', new Set());
  for (let a = 0; a < broad.length; a++) for (let b = a + 1; b < broad.length; b++) assert.ok(Math.hypot(broad[a].x - broad[b].x, broad[a].y - broad[b].y) >= sceneryPairSpacing(broad[a], broad[b]) - .00001);
  for (const left of [-32, -17, -16, -1, 0]) {
    const small = generateSurfaceScenery(cells(left, -17, 9), 'world:0', new Set());
    for (const item of small) assert.deepEqual(broad.find(candidate => candidate.id === item.id), item);
  }
  const blocked = new Set(['-16:-16:0']);
  const filtered = generateSurfaceScenery(cells(-32, -32, 49), 'world:0', blocked);
  for (const item of filtered) assert.deepEqual(broad.find(candidate => candidate.id === item.id), item);
  const otherRegionFocus = [{ id: 'unseen-neighbour', regionId: 2, z: 0, x: broad[0].x, y: broad[0].y }];
  const otherRegionRoad = [{ id: 'neighbour-road', regionId: 2, width: .72, points: [{ x: -32, y: broad[0].y }, { x: 32, y: broad[0].y }] }];
  assert.deepEqual(generateSurfaceScenery(cells(-32, -32, 49), 'world:0', new Set(), otherRegionFocus, otherRegionRoad), broad, 'neighbour region entering view cannot thin the existing region again');
});

test('real scene assembly keeps only authorised layer/regions, drops null landmarks and returns anonymous roads', async () => {
  const queries: string[] = [];
  const db = { execute: async (sql: string) => {
    queries.push(sql);
    if (sql.startsWith('SELECT code')) return [[{ code: area.code, is_owner_only: 0, is_enabled: 1 }]];
    if (sql.includes('FROM map_region_areas')) return [[area, { ...area, region_id: 9, code: 'private_room', is_owner_only: 1 }]];
    if (sql.includes('FROM map_npcs')) return [[{ id: 'npc:null', region_id: 1, x: null, y: null, z: 0 }, { id: 'npc:hidden-8511', region_id: 1, x: -5, y: -2, z: 0 }, { id: 'entrance:hidden-9123', region_id: 1, x: 4, y: 2, z: 0 }]];
    if (sql.includes('FROM map_surface_marks')) return [[]];
    assert.fail(sql);
  } } as unknown as Pool;
  const known = [...cells(), { x: 0, y: 0, z: 1, regionId: 1, regionCode: area.code, passable: true }, { x: 100, y: 100, z: 0, regionId: 9, regionCode: 'private_room', passable: true }];
  const scene = await surfaceSceneFor(db, { x: 0, y: 0, z: 0, regionId: 1 }, known, []);
  assert.ok(scene); assert.ok(scene.roads.length > 0); assert.equal(scene.terrainFields.length, 1);
  assert.ok(scene.scenery.every(item => item.z === 0 && item.regionId === 1));
  assert.ok(!/npc:hidden|entrance:hidden|npc:null/.test(JSON.stringify(scene)));
  assert.ok(queries.every(sql => sql.trim().startsWith('SELECT'))); assert.equal(queries.filter(sql => sql.includes('FROM map_npcs')).length, 1);
});

test('public scope rejects private, disabled, home, story, arena and underground contexts', async () => {
  for (const region of [{ code: 'dark_forest', is_owner_only: 1, is_enabled: 1 }, { code: 'dark_forest', is_owner_only: 0, is_enabled: 0 }, ...['home', 'private_room', 'story_forest', 'eternal_arena', 'trial_stage', 'dark_forest_dungeon', ''].map(code => ({ code, is_owner_only: 0, is_enabled: 1 }))]) {
    const queries: string[] = [];
    const db = { execute: async (sql: string) => { queries.push(sql); assert.ok(sql.startsWith('SELECT')); return [[region]]; } } as unknown as PoolConnection;
    const point = { regionId: 1, x: 0, y: 0, z: 0 };
    assert.equal(await resolveSurfaceScope(db, point), null);
    await recordSurfaceCombatMarkIn(db, { ...point, eventKey: 'combat', scopeKey: 'world:0', kind: 'blood' });
    await recordSurfaceWalkIn(db, [point, { ...point, x: 1 }]);
    assert.ok(queries.every(sql => sql.startsWith('SELECT')));
  }
  const db = { execute: async () => assert.fail('an underground or unknown instance scope must not query public marks') } as unknown as PoolConnection;
  assert.equal(await resolveSurfaceScope(db, { regionId: 1, x: 0, y: 0, z: -1 }), null);
  assert.equal(await surfaceSceneFor(db, { regionId: 1, x: 0, y: 0, z: -1 }, cells().map(cell => ({ ...cell, z: -1 })), []), undefined);
});

test('long walks batch at 64 rows and expire each actual timed segment instead of refreshing arrival', async () => {
  const sqls: { sql: string; values: unknown[] }[] = [];
  const db = { execute: async (sql: string, values: unknown[]) => { sqls.push({ sql, values }); return [sql.startsWith('SELECT') ? [{ code: 'dark_forest', is_owner_only: 0, is_enabled: 1 }] : { affectedRows: 1 }]; } } as unknown as PoolConnection;
  const points = Array.from({ length: 131 }, (_, x) => ({ x, y: 0, z: 0, regionId: 1 }));
  const now = Date.now(), times = points.slice(1).map((_, index) => now - surfaceWalkTtlMs - 1000 + index * 1000);
  await recordSurfaceWalkIn(db, points, { eventKey: 'long-authoritative', segmentTimesMs: times });
  const inserts = sqls.filter(query => query.sql.startsWith('INSERT'));
  assert.equal(inserts.length, 2); assert.ok(inserts.every(query => query.values.length <= 64 * 13));
  const insertedRows = inserts.flatMap(query => Array.from({ length: query.values.length / 13 }, (_, index) => query.values.slice(index * 13, index * 13 + 13)));
  assert.equal(insertedRows.length, 128); assert.equal(insertedRows[0][11], times[2]); assert.equal(insertedRows[0][12], times[2] + surfaceWalkTtlMs);
  assert.ok(sqls.filter(query => query.sql.startsWith('DELETE')).every(query => /ORDER BY expires_at_ms LIMIT 128$/.test(query.sql)));
  const count = sqls.length;
  await recordSurfaceWalkIn(db, points, { segmentTimesMs: [] }); assert.equal(sqls.length, count, 'missing segment timing is not guessed');
  await recordSurfaceWalkIn(db, [{ x: 0x80000000, y: 0, z: 0, regionId: 1 }, { x: 0x80000001, y: 0, z: 0, regionId: 1 }]); assert.equal(sqls.length, count, 'out-of-range coordinates cannot be silently clamped by MySQL');
  await recordSurfaceCombatMarkIn(db, { x: 0, y: 0, z: 0, regionId: 1, eventKey: '', scopeKey: 'world:0', kind: 'blood' }); assert.equal(sqls.length, count);
});

test('saved travel uses full real paths and timestamps, skips transfers/private covers and remains idempotent', async () => {
  const from = { x: 0, y: 0, z: 0, regionId: 1 }, to = { x: 3, y: 0, z: 0, regionId: 1 }, leg: TravelLeg = { kind: 'walk', from, to, distance: 3, seconds: 3, waypoints: [from, to] };
  const now = Date.now(), inserted = new Map<string, unknown[]>(); let privateCover = false;
  const db = { execute: async (sql: string, values: unknown[]) => {
    if (sql.includes('FROM map_region_areas')) return [privateCover ? [{ ...area, is_owner_only: 1 }] : [area]];
    if (sql.startsWith('SELECT code')) return [[{ code: area.code, is_owner_only: 0, is_enabled: 1 }]];
    if (sql.startsWith('INSERT')) { for (let index = 0; index < values.length; index += 13) if (!inserted.has(String(values[index]))) inserted.set(String(values[index]), values.slice(index, index + 13)); return [{}]; }
    if (sql.startsWith('DELETE')) return [{}];
    assert.fail(sql);
  } } as unknown as PoolConnection;
  const value = { eventKey: 'saved-route-token', legs: [leg], startedAtMs: now - 4000, arrivalAtMs: now - 1000 };
  await recordSurfaceTravelIn(db, value); await recordSurfaceTravelIn(db, { ...value, startedAtMs: now - 3000, arrivalAtMs: now });
  assert.equal(inserted.size, 3); assert.deepEqual([...inserted.values()].map(mark => mark[11]), [now - 3000, now - 2000, now - 1000]);
  privateCover = true; await recordSurfaceTravelIn(db, { ...value, eventKey: 'new-private-route' }); assert.equal(inserted.size, 3);
  for (const invalid of [{ ...leg, waypoints: undefined }, { ...leg, distance: 2 }, { ...leg, waypoints: [from, { ...to, y: 1 }] }, { ...leg, seconds: NaN }]) assert.deepEqual(surfaceTravelSegments([invalid], value.startedAtMs, value.arrivalAtMs), []);
});

test('real-generator visual fixture covers five ecology pools and a hidden-centre halo without database setup', () => {
  const fixture = buildSurfaceFixtures();
  assert.equal(fixture.cases.length, 5); assert.equal(fixture.halo.surfaceScene.combatMarks.length, 1);
  assert.deepEqual(buildSurfaceFixtures(), fixture);
  for (const item of fixture.cases) assert.ok(item.stats.sceneryAtRange4 >= 6 && item.stats.sceneryAtRange4 <= 22 && item.surfaceScene.scenery.every(scenery => authorised(scenery, item.cells)));
  const halo = fixture.halo;
  assert.ok(halo.surfaceScene.combatMarks.every(mark => authorised(mark, halo.cells) && mark.fragments!.every(fragment => fragment.points.every(point => authorised(point, halo.cells)))));
});
