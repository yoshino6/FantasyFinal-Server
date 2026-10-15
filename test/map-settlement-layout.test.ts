import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { worldTreeAdvancedProfessions } from '../src/game/advanced-profession.config';
import { pathToFileURL } from 'node:url';
import * as sourceLayout from '../src/game/map-settlement-layout';
import type { SettlementCell, SettlementFocus, SettlementLayoutInput, SettlementRoad, SettlementSpriteMap } from '../src/game/map-settlement-layout';
const { clipSettlementLayout, isSettlementRegion, planSettlementLayout, planSettlementRoadside, settlementSceneryFootprint, SETTLEMENT_SPRITE_BOUNDS } = process.env.FF_SETTLEMENT_LAYOUT_STAGE
  ? await import(pathToFileURL(process.env.FF_SETTLEMENT_LAYOUT_STAGE).href) as typeof sourceLayout : sourceLayout;

const grid = (left = -40, bottom = -12, width = 81, height = 25, regionCode = 'baina_town'): SettlementCell[] => Array.from({ length: width * height }, (_, index) => ({
  x: left + index % width, y: bottom + Math.floor(index / width), z: 0, regionId: 1, regionCode, passable: true
}));
const focus = (x: number, y: number, id = `${x}:${y}`): SettlementFocus => ({ x, y, z: 0, regionId: 1, id });
const input = (cells = grid(), focuses = [focus(-30, 0), focus(30, 0)]): SettlementLayoutInput => ({ regionId: 1, regionCode: 'baina_town', z: 0, cells, focuses });
const pointKey = (point: { x: number; y: number }) => `${point.x}:${point.y}`;
const turnCount = (road: SettlementRoad) => road.points.slice(2).filter((point, index) => {
  const a = road.points[index], b = road.points[index + 1]; return point.x - b.x !== b.x - a.x || point.y - b.y !== b.y - a.y;
}).length;
const shuffled = <T>(items: readonly T[]) => [...items.filter((_, index) => index % 2), ...items.filter((_, index) => index % 2 === 0)].reverse();

test('settlements are exact public-floor matches; malformed and excessive inputs fail closed', () => {
  assert.equal(isSettlementRegion('baina_town'), true); assert.equal(isSettlementRegion('world_tree'), true);
  for (const code of ['worldtree_meadow', 'private_world_tree', 'baina_town ', null, 1]) assert.equal(isSettlementRegion(code), false);
  for (const patch of [{ z: 1 }, { z: -1 }, { regionId: 0 }, { regionId: NaN }, { regionCode: 'worldtree_meadow' }, { cells: null }, { focuses: null },
    { cells: Array(16_385).fill(null) }, { focuses: Array(129).fill(null) }]) assert.deepEqual(planSettlementLayout({ ...input(), ...patch } as any), { roads: [], scenery: [] });
  assert.deepEqual(planSettlementLayout(null as any), { roads: [], scenery: [] });
  assert.deepEqual(planSettlementLayout(input([], [])), { roads: [], scenery: [] });
});

test('shared default sprite measurements exactly match the independently authored Web atlas metadata', () => {
  const measured = JSON.parse(readFileSync(new URL('../../web/src/map-settlement-sprite-bounds.json', import.meta.url), 'utf8'));
  assert.deepEqual(SETTLEMENT_SPRITE_BOUNDS, Object.fromEntries(measured.slice(0, 5).map((bounds: unknown, index: number) => [`settlement_${index}`, bounds])));
});

test('shuffling complete geometry and changing every focus ID leaves full roads and scenery identical', () => {
  const original = input(grid(), [focus(-30, 0), focus(0, 0), focus(30, 0), focus(0, 9), focus(0, -9)]);
  const expected = planSettlementLayout(original);
  assert.equal(expected.roads.length, 4); assert.ok(expected.scenery.length > 0);
  const focuses = shuffled(original.focuses).map(point => ({ x: point.x, y: point.y, z: point.z, regionId: point.regionId,
    get id(): never { throw Error('private focus identity must never be read'); } }));
  focuses.push({ ...focus(0, 0, 'another-private-id') } as any);
  assert.deepEqual(planSettlementLayout({ ...original, cells: shuffled(original.cells), focuses }), expected);
  assert.ok(!JSON.stringify(expected).includes('private'));
});

test('MST connects more than three roads, with one component containing every authorised focus', () => {
  const focuses = [-30, -20, -10, 0, 10, 20, 30].map(x => focus(x, 0)), result = planSettlementLayout(input(grid(), focuses));
  assert.equal(result.roads.length, focuses.length - 1);
  assert.equal(result.roads.reduce((sum, road) => sum + road.points.length - 1, 0), 60);
  const connected = new Set<string>(); result.roads.forEach(road => road.points.forEach(point => connected.add(pointKey(point))));
  for (const point of focuses) assert.ok(connected.has(pointKey(point)));
});

test('shortest paths choose the fewest turns and MST ranks feasible route length rather than Manhattan distance', () => {
  const result = planSettlementLayout(input(grid(0, 0, 11, 11), [focus(0, 0), focus(10, 10)]));
  assert.equal(result.roads[0].points.length, 21); assert.equal(turnCount(result.roads[0]), 1);
  const cells = grid(0, 0, 11, 11).map(cell => ({ ...cell, passable: !(cell.x === 2 && cell.y < 10) }));
  const paths = planSettlementLayout(input(cells, [focus(0, 0), focus(4, 0), focus(0, 6)]));
  assert.equal(paths.roads.length, 2);
  assert.deepEqual([paths.roads[0].points[0], paths.roads[0].points.at(-1)], [{ x: 0, y: 0 }, { x: 0, y: 6 }]);
  assert.deepEqual([paths.roads[1].points[0], paths.roads[1].points.at(-1)], [{ x: 0, y: 6 }, { x: 4, y: 0 }]);
  assert.ok(paths.roads[1].points.some(point => point.y === 10));
});

test('roads follow four-way original passability, bypass existing obstacles and never manufacture geometry', () => {
  const cells = grid(0, 0, 9, 9).map(cell => ({ ...cell, passable: !(cell.x === 4 && cell.y !== 8) }));
  const result = planSettlementLayout(input(cells, [focus(1, 1), focus(7, 1)]));
  assert.equal(result.roads.length, 1); assert.ok(result.roads[0].points.some(point => point.y === 8));
  const authorised = new Set(cells.filter(cell => cell.passable).map(pointKey));
  for (const road of result.roads) for (let index = 0; index < road.points.length; index++) {
    const point = road.points[index]; assert.ok(authorised.has(pointKey(point)));
    if (index) assert.equal(Math.abs(point.x - road.points[index - 1].x) + Math.abs(point.y - road.points[index - 1].y), 1);
  }
  assert.equal(cells.find(cell => cell.x === 4 && cell.y === 1)?.passable, false);
  const long = planSettlementLayout(input(grid(0, 0, 1701, 1), [focus(0, 0), focus(1700, 0)]));
  assert.equal(long.roads[0].points.length, 1701, 'full region routing must not stop at the old 1600-cell search budget');
});

test('disconnected authorised components produce a forest without tunnelling or connecting absent focuses', () => {
  const cells = grid(-10, -5, 21, 11).map(cell => ({ ...cell, passable: cell.x !== 0 }));
  const result = planSettlementLayout(input(cells, [focus(-8, 0), focus(-3, 0), focus(3, 0), focus(8, 0), focus(0, 0), focus(999, 0)]));
  assert.equal(result.roads.length, 2);
  assert.ok(result.roads.every(road => road.points.every(point => point.x < 0) || road.points.every(point => point.x > 0)));
});

test('blocked, private, foreign identity and malformed duplicate cells deny coordinates in either input order', () => {
  const cells = grid(0, 0, 13, 1), start = focus(0, 0), end = focus(12, 0);
  for (const patch of [{ passable: false }, { regionCode: 'private_story' }, { regionId: 9 }, { regionId: undefined }, { passable: 1 }]) {
    const denied = { ...cells[6], ...patch };
    assert.deepEqual(planSettlementLayout(input([...cells, denied] as any, [start, end])).roads, []);
    assert.deepEqual(planSettlementLayout(input([denied, ...cells] as any, [start, end])).roads, []);
  }
  assert.equal(planSettlementLayout(input([...cells, { ...cells[6], z: 1 }], [start, end])).roads.length, 1);
});

test('roadside fixed rhythm places both sides, retains rest benches and excludes full alpha envelopes', () => {
  const cells = grid(-48, -12, 97, 25), focuses = [focus(-42, 0), focus(42, 0)], result = planSettlementLayout(input(cells, focuses));
  const roadCells = new Set(result.roads.flatMap(road => road.points.map(pointKey))), occupied = new Set<string>();
  assert.ok(result.scenery.length > 15); assert.deepEqual(new Set(result.scenery.map(item => item.assetKey)), new Set(['settlement_0', 'settlement_1', 'settlement_2']));
  assert.ok(result.scenery.some(item => item.y < 0)); assert.ok(result.scenery.some(item => item.y > 0));
  for (const item of result.scenery) {
    assert.equal(item.rotation, 0); assert.equal(item.flip, false); assert.ok(Number.isInteger(item.x) && Number.isInteger(item.y));
    assert.equal(item.scale, [.95, .72, .95, .8, .9][Number(item.assetKey.slice(-1))]);
    const footprint = settlementSceneryFootprint(item); assert.equal(footprint.length, item.assetKey === 'settlement_0' ? 2 : 1, 'final 256px lantern alpha reaches the upper cell; planter and bench stay in their anchor cell');
    for (const point of footprint) {
      const key = pointKey(point); assert.ok(!roadCells.has(key) && !occupied.has(key)); occupied.add(key);
      assert.ok(cells.some(cell => pointKey(cell) === key && cell.passable && cell.regionId === item.regionId && cell.z === item.z));
      assert.ok(focuses.every(focus => Math.abs(point.x - focus.x) + Math.abs(point.y - focus.y) > 2));
    }
  }
  const world = planSettlementLayout({ ...input(cells.map(cell => ({ ...cell, regionCode: 'world_tree' })), focuses), regionCode: 'world_tree' });
  assert.deepEqual(new Set(world.scenery.map(item => item.assetKey)), new Set(['settlement_3', 'settlement_4', 'settlement_2']));
});

test('junctions and turns reserve radius two, and exclusions reject the entire alpha footprint', () => {
  const cells = grid(-30, -30, 61, 61), focuses = [focus(-24, 0), focus(24, 0), focus(0, 0), focus(0, 24), focus(0, -24)];
  const result = planSettlementLayout(input(cells, focuses));
  for (const item of result.scenery) for (const point of settlementSceneryFootprint(item)) assert.ok(Math.abs(point.x) + Math.abs(point.y) > 2);
  const subject = result.scenery[0], upper = settlementSceneryFootprint(subject).find(point => point.y !== subject.y)!;
  const fallback = planSettlementRoadside({ ...input(cells, focuses), roads: result.roads, exclusions: [upper] });
  assert.ok(!fallback.some(item => item.id === subject.id));
  const rect = { left: upper.x - .5, right: upper.x + .5, south: upper.y - .5, north: upper.y + .5 };
  assert.deepEqual(planSettlementRoadside({ ...input(cells, focuses), roads: result.roads, exclusions: [rect] }), fallback);
  assert.deepEqual(planSettlementRoadside({ ...input(cells, focuses), roads: [] }), []);
  assert.deepEqual(planSettlementRoadside({ ...input(cells, focuses), roads: [{ ...result.roads[0], points: [{ x: -24, y: 0 }, { x: 24, y: 0 }] }] }), []);
});

test('measured sprite bounds reserve actual alpha rather than an assumed one-cell anchor', () => {
  const cells = grid(-40, -8, 81, 17), base = input(cells), roads = planSettlementLayout(base).roads;
  const bounds: SettlementSpriteMap = Object.fromEntries(Array.from({ length: 5 }, (_, asset) => [`settlement_${asset}`, { left: .1, top: .1, width: .8, height: .8, anchorX: .5, anchorY: .9 }]));
  const scenery = planSettlementRoadside({ ...base, roads, spriteBounds: bounds }); assert.ok(scenery.length);
  const subject = scenery[0], footprint = settlementSceneryFootprint(subject, bounds);
  assert.ok(footprint.some(point => point.y === subject.y + 1));
  const visible = cells.filter(cell => !(cell.x === subject.x && cell.y === subject.y + 1));
  assert.ok(!clipSettlementLayout({ roads, scenery }, visible, bounds).scenery.some(item => item.id === subject.id));
  assert.deepEqual(planSettlementRoadside({ ...base, roads, spriteBounds: { settlement_0: { ...bounds.settlement_0!, width: NaN } } }).filter(item => item.assetKey === 'settlement_0'), []);
});

test('clipping uses original path indices, exact cell identity and independent cached output objects', () => {
  const base = input(), result = planSettlementLayout(base), visible = base.cells.filter(cell => cell.x >= -12 && cell.x <= 12);
  const clipped = clipSettlementLayout(result, visible); assert.ok(clipped.roads.length && clipped.scenery.length);
  assert.match(clipped.roads[0].id, /:cells:18-42$/);
  assert.ok(clipped.roads.every(road => road.points.every(point => point.x >= -12 && point.x <= 12)));
  const original = JSON.stringify(result); clipped.roads[0].points[0].x = 999; clipped.roads[0].width = 999; clipped.scenery[0].x = 999;
  assert.equal(JSON.stringify(result), original);
  const subject = result.scenery[0], upper = settlementSceneryFootprint(subject).at(-1)!;
  for (const patch of [{ passable: false }, { regionId: 9 }, { regionCode: 'private_story' }]) {
    const denied = { ...base.cells.find(cell => cell.x === upper.x && cell.y === upper.y)!, ...patch };
    assert.ok(!clipSettlementLayout(result, [...base.cells, denied]).scenery.some(item => item.id === subject.id));
    assert.ok(!clipSettlementLayout(result, [denied, ...base.cells]).scenery.some(item => item.id === subject.id));
  }
  assert.deepEqual(clipSettlementLayout(result, base.cells.map(cell => ({ ...cell, z: 1 }))), { roads: [], scenery: [] });
  const many = planSettlementLayout(input(grid(-50, -4, 101, 9), Array.from({ length: 11 }, (_, index) => focus(-50 + index * 10, 0))));
  assert.equal(clipSettlementLayout(many, grid(-50, -4, 101, 9)).roads.length, 10);
});

test('maximum supported complete geometry and 128 focuses stay deterministic and bounded', () => {
  const cells = grid(0, 0, 128, 128), focuses = Array.from({ length: 128 }, (_, index) => focus(index, index % 2 ? 126 : 1));
  const started = performance.now(), result = planSettlementLayout(input(cells, focuses)), elapsed = performance.now() - started;
  assert.equal(result.roads.length, 127);
  assert.ok(result.roads.reduce((sum, road) => sum + road.points.length, 0) <= cells.length * 2 + focuses.length);
  assert.ok(result.scenery.length <= cells.length);
  console.log(`settlement maximum fixture: ${cells.length} cells, ${focuses.length} focuses, ${result.roads.length} roads, ${result.scenery.length} props, ${elapsed.toFixed(1)} ms`);
});

test('actual compact world tree keeps its MST and radius-two entrances while finding sparse safe verges', () => {
  const bootstrap = readFileSync(new URL('../src/database/bootstrap.ts', import.meta.url), 'utf8');
  const entries = [...bootstrap.matchAll(/\(\(SELECT id FROM map_regions WHERE code='world_tree'\), '[^']+', '[^']+', '[^']*', (?:'(?:npc|building)', )?(-?\d+), (-?\d+), 0\)/g)];
  const focuses = entries.map(entry => focus(Number(entry[1]), Number(entry[2])));
  focuses.push(...worldTreeAdvancedProfessions.map(profession => focus(profession.mentor.x, profession.mentor.y)));
  const cells = grid(-10, -10, 20, 20, 'world_tree'), settings = { ...input(cells, focuses), regionCode: 'world_tree' };
  const result = planSettlementLayout(settings);
  assert.equal(new Set(focuses.map(pointKey)).size, 21); assert.equal(result.roads.length, 20);
  assert.ok(result.scenery.length >= 3); assert.deepEqual(new Set(result.scenery.map(item => item.assetKey)), new Set(['settlement_3', 'settlement_4', 'settlement_2']));
  assert.deepEqual(planSettlementLayout({ ...settings, cells: shuffled(cells), focuses: shuffled(focuses) }), result);
  const roadCells = new Set(result.roads.flatMap(road => road.points.map(pointKey))), critical = [...focuses];
  for (const identity of roadCells) {
    const [x, y] = identity.split(':').map(Number), adjacent = [[1, 0], [0, 1], [-1, 0], [0, -1]].map(([dx, dy]) => roadCells.has(`${x + dx}:${y + dy}`));
    if (adjacent.filter(Boolean).length !== 2 || !(adjacent[0] && adjacent[2] || adjacent[1] && adjacent[3])) critical.push(focus(x, y));
  }
  const occupied = new Set<string>();
  for (const item of result.scenery) for (const point of settlementSceneryFootprint(item)) {
    const identity = pointKey(point); assert.ok(!roadCells.has(identity) && !occupied.has(identity)); occupied.add(identity);
    assert.ok(cells.some(cell => pointKey(cell) === identity && cell.passable && cell.regionCode === 'world_tree'));
    assert.ok(critical.every(origin => Math.hypot(Math.max(Math.abs(point.x - origin.x) - .5, 0), Math.max(Math.abs(point.y - origin.y) - .5, 0)) > 2));
  }
  result.scenery.forEach((item, index) => result.scenery.slice(index + 1).forEach(other => assert.ok(Math.hypot(item.x - other.x, item.y - other.y) >= 4)));
});
