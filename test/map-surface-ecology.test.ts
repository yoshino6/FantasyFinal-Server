import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LocalMapCell } from '../src/game/local-exploration-route';
import { generateSurfaceScenery, sampleSurfaceEcology, sceneryPairSpacing, surfaceEcologySeed, fixedSurfaceRoads } from '../src/game/map-surface-scene';
import { sampleSurfaceEcologyV2, surfaceEcologySeedV2 } from '../src/game/map-ecology-field';
import { sampleSurfaceEcology as clientSample, surfaceEcologySeed as clientSeed } from '../../web/src/map-surface-ecology';
import { roundedSurfaceRoad } from '../../web/src/map-surface';
import { buildSurfaceV2Fixtures } from './create-map-surface-fixture';
import { generateEnvironmentForCells, environmentObjectCells } from '../src/game/map-environment.config';

const cells = (code = 'dark_forest', left = -24, bottom = -24, size = 49): LocalMapCell[] => Array.from({ length: size * size }, (_, index) => ({ x: left + index % size, y: bottom + Math.floor(index / size), z: 0, regionId: 1, regionCode: code, passable: true }));
const cellKey = (x: number, y: number) => `${Math.floor(x + .5)}:${Math.floor(y + .5)}:0`;

test('public ecology field agrees across server and Web at fractional, negative and distant coordinates', () => {
  assert.equal(sampleSurfaceEcology, sampleSurfaceEcologyV2);
  assert.equal(surfaceEcologySeed, surfaceEcologySeedV2);
  for (const scope of ['world:0', 'world:1', 'world:2']) {
    const seed = surfaceEcologySeed(scope);
    assert.equal(seed, clientSeed(scope));
    for (const x of [-2_000_000_000, -49.5, -16.0001, -.001, 0, .375, 17.9999, 2_000_000_000]) for (const y of [-31.25, -1, .125, 15.999]) {
      const server = sampleSurfaceEcology(x, y, seed), client = clientSample(x, y, seed);
      assert.deepEqual(server, client, 'ground shading and scenery must sample identical world conditions');
      assert.ok(Object.values(server).every(value => Number.isFinite(value) && value >= 0 && value <= 1));
    }
    for (const boundary of [-16, -1, 0, 16]) {
      const before = sampleSurfaceEcology(boundary - .00001, 3.75, seed), after = sampleSurfaceEcology(boundary + .00001, 3.75, seed);
      assert.ok(Object.keys(before).every(name => Math.abs(before[name as keyof typeof before] - after[name as keyof typeof after]) < .0001), 'neither game cells nor negative chunk boundaries restart the field');
    }
  }
  assert.notDeepEqual(sampleSurfaceEcology(0, 0, surfaceEcologySeed('world:0')), sampleSurfaceEcology(0, 0, surfaceEcologySeed('world:1')));
});

test('fixed road profiles preserve absent-v1 defaults and fail closed on unsupported generation versions', () => {
  const known = cells(), area = { region_id: 1, code: 'dark_forest', is_owner_only: 0, is_enabled: 1, danger_level: 1, min_x: -24, max_x: 24, min_y: -24, max_y: 24, min_z: 0, max_z: 0 };
  const focuses = [{ id: 'a', x: -5, y: -2, z: 0, regionId: 1 }, { id: 'b', x: 4, y: 2, z: 0, regionId: 1 }];
  assert.deepEqual(fixedSurfaceRoads(known, [area], focuses), fixedSurfaceRoads(known, [{ ...area, generation_version: 1 }], focuses));
  for (const generation_version of [0, 3, 1.5, NaN]) assert.throws(() => fixedSurfaceRoads(known, [{ ...area, generation_version }], focuses), /版本不受支持/);
  assert.throws(() => fixedSurfaceRoads([], [{ ...area, generation_version: 3 }], []), /版本不受支持/);
});

test('ecological clusters add authored group assets while preserving small individual plants and broad open space', () => {
  const known = cells('worldtree_meadow'), scene = generateSurfaceScenery(known, 'world:0', new Set());
  const patches = scene.filter(item => item.assetKey.startsWith('scenery_patch_')), companions = scene.filter(item => !item.assetKey.startsWith('scenery_patch_'));
  assert.ok(patches.length > 12 && companions.length > patches.length);
  assert.ok(patches.every(item => {
    const frame = Number(item.assetKey.slice('scenery_patch_'.length)), range = [1, 2, 3].includes(frame) ? [.88, 1.43] : [6, 7, 9].includes(frame) ? [.95, 1.6] : [1.05, 1.75];
    return item.scale >= range[0]! && item.scale <= range[1]!;
  }));
  assert.ok(companions.every(item => item.scale >= .25 && item.scale <= .75));
  assert.ok(scene.length < known.length * .35, 'large group artwork is not a reason to fill every cell');
  const occupied = new Set(scene.map(item => cellKey(item.x, item.y)));
  assert.ok(occupied.size < known.length * .3);
  assert.ok(scene.some(item => !Number.isInteger(item.x) && !Number.isInteger(item.y)));
  assert.ok(patches.some(patch => companions.some(item => item.id.slice(0, item.id.lastIndexOf(':')) === patch.id.slice(0, patch.id.lastIndexOf(':')))), 'some clusters retain a group and its companion details');
  for (let a = 0; a < scene.length; a++) for (let b = a + 1; b < scene.length; b++) assert.ok(Math.hypot(scene[a].x - scene[b].x, scene[a].y - scene[b].y) >= sceneryPairSpacing(scene[a], scene[b]) - .00001);
});

test('habitats vary inside one region and cold/dry/wet regions do not randomly mix incompatible plants', () => {
  const patchKeys = (code: string) => new Set(generateSurfaceScenery(cells(code), 'world:0', new Set()).filter(item => item.assetKey.startsWith('scenery_patch_')).map(item => item.assetKey));
  const forest = patchKeys('dark_forest');
  assert.ok(forest.size >= 3 && [...forest].some(key => ['scenery_patch_6', 'scenery_patch_7', 'scenery_patch_8'].includes(key)));
  assert.deepEqual([...patchKeys('frostcrown_plateau')], ['scenery_patch_13']);
  assert.ok([...patchKeys('ridge_foothills')].every(key => ['scenery_patch_12', 'scenery_patch_15'].includes(key)));
  assert.ok([...patchKeys('mistalgae_marsh')].every(key => ['scenery_patch_10', 'scenery_patch_11'].includes(key)));
});

test('new unique region codes inherit the matching ground family without changing known profiles', () => {
  const pairs = [['dark_forest_frontier', 'dark_forest'], ['frostcrown_plateau_frontier', 'frostcrown_plateau'], ['mistalgae_marsh_frontier', 'mistalgae_marsh'], ['morningdew_riverbank_frontier', 'morningdew_riverbank'], ['ridge_frontier', 'ridge_foothills'], ['eclipse_ruins_frontier', 'eclipse_ruins']];
  for (const [newCode, knownCode] of pairs) {
    const patches = (code: string) => generateSurfaceScenery(cells(code), 'world:0', new Set()).filter(item => item.assetKey.startsWith('scenery_patch_'));
    assert.deepEqual(patches(newCode!).map(item => [item.id, item.assetKey, item.scale, item.x, item.y]), patches(knownCode!).map(item => [item.id, item.assetKey, item.scale, item.x, item.y]));
  }
  const forest = generateSurfaceScenery(cells('dark_forest_frontier'), 'world:0', new Set());
  const understory = new Set(forest.filter(item => /^scenery_patch_(?:6|7|8|9|11)$/.test(item.assetKey)).map(item => item.assetKey));
  assert.ok(understory.size >= 4, 'forest shade selects varied authored low growth rather than one repeated fern');
});

test('v2 fixtures use true registrable-region generation for trees, rocks, passability and roads', () => {
  const fixtures = buildSurfaceV2Fixtures(), assets = new Set<string>();
  assert.equal(fixtures.length, 5);
  for (const fixture of fixtures) {
    assert.ok(fixture.generator.area.code.endsWith('_frontier'));
    assert.deepEqual(generateEnvironmentForCells([fixture.generator.area], fixture.cells, fixture.generator.protections), fixture.environment);
    assert.ok(fixture.environment.every(object => object.id.startsWith('env2:') && object.blocking && object.destructible));
    for (const object of fixture.environment) assets.add(object.assetKey);
    const blocked = new Set(fixture.environment.flatMap(environmentObjectCells).map(cell => `${cell.x}:${cell.y}:${cell.z}`));
    assert.ok(fixture.cells.every(cell => cell.passable === !blocked.has(`${cell.x}:${cell.y}:${cell.z}`)));
    assert.ok(fixture.cells.find(cell => cell.x === fixture.origin.x && cell.y === fixture.origin.y)?.passable);
    assert.ok(fixture.surfaceScene.roads.length > 0 && fixture.surfaceScene.roads.every(road => road.points.every(point => fixture.cells.some(cell => cell.x === point.x && cell.y === point.y && cell.passable))));
  }
  assert.deepEqual(assets, new Set(['living_oak', 'living_birch', 'living_pine', 'moss_boulder']));
});

test('medium-cover habitat carries flower groups while low-cover ground remains predominantly open', () => {
  const known = cells('worldtree_meadow'), scene = generateSurfaceScenery(known, 'world:0', new Set()), seed = surfaceEcologySeed('world:0');
  const bucket = (cover: number) => cover < .32 ? 'low' : cover < .60 ? 'medium' : 'high';
  const populations = { low: { cells: 0, groups: 0 }, medium: { cells: 0, groups: 0 }, high: { cells: 0, groups: 0 } };
  for (const cell of known) populations[bucket(sampleSurfaceEcology(cell.x, cell.y, seed).cover)].cells++;
  for (const item of scene.filter(item => item.assetKey.startsWith('scenery_patch_'))) populations[bucket(sampleSurfaceEcology(item.x, item.y, seed).cover)].groups++;
  const density = (name: keyof typeof populations) => populations[name].groups / populations[name].cells;
  assert.ok(scene.length > 600 && scene.length < 1024, 'a normal 49-cell-wide world window retains all candidates rather than clipping the denser layout at 600');
  assert.ok(density('medium') > .08 && density('low') < .03, 'middle habitat gets actual group artwork without uniformly filling sparse habitat');
  assert.ok(density('high') > density('medium'));
});

test('cluster positions survive camera windows, arrival order, other floors and blocked-cell filtering', () => {
  const known = cells(), broad = generateSurfaceScenery(known, 'world:0', new Set());
  assert.deepEqual(generateSurfaceScenery([...known].reverse(), 'world:0', new Set()), broad);
  assert.deepEqual(generateSurfaceScenery([...known.map(cell => ({ ...cell, z: 1 })), ...known], 'world:0', new Set()), broad);
  for (const left of [-24, -17, -1, 0, 16]) {
    const narrow = known.filter(cell => cell.x >= left && cell.x <= left + 8 && cell.y >= -4 && cell.y <= 4);
    for (const item of generateSurfaceScenery(narrow, 'world:0', new Set())) assert.deepEqual(broad.find(candidate => candidate.id === item.id), item);
  }
  const blocked = new Set(['0:0:0', '0:1:0', '1:0:0', '1:1:0']);
  for (const item of generateSurfaceScenery(known, 'world:0', blocked)) {
    assert.ok(!blocked.has(cellKey(item.x, item.y)));
    assert.deepEqual(broad.find(candidate => candidate.id === item.id), item, 'clearing and blocking remove only affected decorations');
  }
});

test('anonymous/private/conflicting cells fail closed and no visual layer invents interactive objects', () => {
  const known = cells('worldtree_meadow', -8, -8, 17), scene = generateSurfaceScenery(known, 'world:0', new Set());
  assert.ok(scene.length > 0);
  for (const invalid of [known.map(cell => ({ ...cell, regionCode: undefined })), known.map(cell => ({ ...cell, regionCode: 'private_room' })), known.map(cell => ({ ...cell, passable: false })), known.map(cell => ({ ...cell, regionId: -1 })), known.map(cell => ({ ...cell, x: cell.x + .5 }))]) assert.deepEqual(generateSurfaceScenery(invalid, 'world:0', new Set()), []);
  assert.deepEqual(generateSurfaceScenery(known, 'instance:8', new Set()), []);
  assert.deepEqual(generateSurfaceScenery([...known, ...known.map(cell => ({ ...cell, regionId: 2 }))], 'world:0', new Set()), []);
  assert.deepEqual(generateSurfaceScenery([...known.map(cell => ({ ...cell, regionId: 2 })), ...known], 'world:0', new Set()), []);
  assert.ok(!/blocking|destructible|dropCode|rewards|resourceId|templateId/.test(JSON.stringify(scene)));
});

test('larger cosmetic groups keep the committed road and landmark margins clear', () => {
  const known = cells(), focuses = [{ id: 'gate', regionId: 1, x: 0, y: 0, z: 0 }], roads = [{ id: 'road', regionId: 1, width: .72, points: [{ x: -24, y: 4 }, { x: 24, y: 4 }] }];
  const scene = generateSurfaceScenery(known, 'world:0', new Set(), focuses, roads);
  assert.ok(scene.length > 20);
  for (const item of scene) {
    const group = item.assetKey.startsWith('scenery_patch_');
    assert.ok(Math.hypot(item.x, item.y) >= 1.3 + (group ? item.scale * .3 : 0));
    assert.ok(Math.abs(item.y - 4) >= .32 + (group ? item.scale * .16 : 0));
  }
});

test('groups also clear the Web broad inner road curve without changing the committed route', () => {
  const known = cells(), road = { id: 'round-corner', regionId: 1, width: .72, points: [{ x: -12, y: -4 }, { x: 6, y: -4 }, { x: 6, y: 12 }] };
  const snapshot = JSON.stringify(road), curve = roundedSurfaceRoad(road.points, known, road.width), scene = generateSurfaceScenery(known, 'world:0', new Set(), [], [road]);
  assert.ok(curve.length > road.points.length);
  for (const item of scene) {
    let distance = Infinity;
    for (let index = 1; index < curve.length; index++) {
      const a = curve[index - 1], b = curve[index], dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((item.x - a.x) * dx + (item.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      distance = Math.min(distance, Math.hypot(item.x - a.x - t * dx, item.y - a.y - t * dy));
    }
    assert.ok(distance >= .32 + (item.assetKey.startsWith('scenery_patch_') ? item.scale * .16 : 0) - .005, 'sampling differences must not allow a cluster onto the broad curve');
  }
  assert.equal(JSON.stringify(road), snapshot, 'cosmetic margins cannot rewrite movement geometry');
});
