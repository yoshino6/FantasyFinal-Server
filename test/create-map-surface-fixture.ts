import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { environmentHash, environmentObjectCells, generateEnvironmentForCells, type EnvironmentArea } from '../src/game/map-environment.config';
import { environmentV2Seed } from '../src/game/map-environment-v2.config';
import { fixedSurfaceRoads, clipSurfaceRoads, generateSurfaceScenery, type MapSurfaceScene } from '../src/game/map-surface-scene';
import { surfaceMarksFromRows, type SurfaceMarkRow } from '../src/game/map-surface-marks.service';
import { surfaceBloodShapeCounts, surfaceMarkPaint } from '../src/game/map-surface-mark-geometry';
import type { LocalMapCell } from '../src/game/local-exploration-route';

// Pure, repeatable real-generator fixtures. This script opens no database or player account.
export const fixtureNowMs = 1_790_000_000_000;
const anonymousId = (value: string) => createHash('sha256').update(value).digest('hex');
const diamond = (radius: number, code: string, center = { x: 0, y: 0 }, regionId = 1): LocalMapCell[] => {
  const cells: LocalMapCell[] = [];
  for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) if (Math.abs(x) + Math.abs(y) <= radius) cells.push({ x: x + center.x, y: y + center.y, z: 0, regionId, regionCode: code, passable: true });
  return cells;
};
const mark = (kind: SurfaceMarkRow['kind'], x: number, y: number, seed: number, ageMs = 50_000): SurfaceMarkRow => ({ event_key: anonymousId(`${kind}:${seed}`), scope_key: 'world:0', region_id: 1, pos_x: x, pos_y: y, pos_z: 0, end_x: kind === 'walk' ? x + 1 : null, end_y: kind === 'walk' ? y : null, kind, effect_seed: seed, intensity: kind === 'walk' ? .08 : .72, occurred_at_ms: fixtureNowMs - ageMs, expires_at_ms: fixtureNowMs + (kind === 'walk' ? 900_000 : 43_200_000) - ageMs } as SurfaceMarkRow);

/** Distinct, registrable region codes; cameras sample the default real v2 seed.
 * Nothing positions a tree manually: environment, blockers, roads and plants
 * are all produced by the same pure functions used by the server.
 */
export const buildSurfaceV2Fixtures = () => [
  { key: 'living-meadow', label: '青叶原野·新区域', code: 'worldtree_meadow_frontier', x: 12, y: 0 },
  { key: 'living-forest', label: '青叶密林·新区域', code: 'dark_forest_frontier', x: 0, y: 0 },
  { key: 'living-wetland', label: '新芽湿地·新区域', code: 'mistalgae_marsh_frontier', x: 0, y: -12 },
  { key: 'living-snow', label: '常青雪原·新区域', code: 'frostcrown_plateau_frontier', x: 0, y: 0 },
  { key: 'living-ruins', label: '苔岩遗迹·新区域', code: 'eclipse_ruins_frontier', x: -12, y: 0 }
].map(({ key, label, code, x, y }, index) => {
  const regionId = 1001 + index, origin = { x, y, z: 0, regionId };
  const area = { region_id: regionId, code, is_owner_only: 0, is_enabled: 1, danger_level: 1, min_x: -100, max_x: 100, min_y: -100, max_y: 100, min_z: 0, max_z: 0, generation_version: 2, generation_seed: environmentV2Seed };
  const envArea: EnvironmentArea = { regionId, code, enabled: true, danger: 1, minX: -100, maxX: 100, minY: -100, maxY: 100, minZ: 0, maxZ: 0, generationVersion: 2, generationSeed: environmentV2Seed };
  const focuses = [{ id: 'fixture-v2-landmark-a', x: x - 6, y: y - 2, z: 0, regionId }, { id: 'fixture-v2-landmark-b', x: x + 6, y: y + 2, z: 0, regionId }];
  const known = diamond(7, code, origin, regionId), protections = focuses.map(focus => ({ ...focus, radius: 2 }));
  const environment = generateEnvironmentForCells([envArea], known, protections);
  const blocked = new Set(environment.filter(object => object.blocking).flatMap(environmentObjectCells).map(point => `${point.x}:${point.y}:${point.z}`));
  const cells = known.map(cell => ({ ...cell, passable: !blocked.has(`${cell.x}:${cell.y}:${cell.z}`) }));
  const fullRoads = fixedSurfaceRoads(cells, [area], focuses), roads = clipSurfaceRoads(fullRoads, cells);
  const scenery = generateSurfaceScenery(cells, 'world:0', blocked, focuses, fullRoads);
  const surfaceScene: MapSurfaceScene = { schemaVersion: 1, sceneryVersion: 1, scopeToken: 'world:0', snapshotId: `fixture:${key}`, serverNowMs: fixtureNowMs,
    terrainFields: [{ regionId, regionCode: code, seed: environmentHash(`surface1:world:0:${code}`) }], scenery, roads, recentWalks: [], combatMarks: [] };
  return { key, label, origin, sightRange: 7, cells, environment, surfaceScene, generator: { version: 2, seed: environmentV2Seed, area: envArea, focuses, protections },
    stats: { visibleCells: cells.length, scenery: scenery.length, sceneryAtRange4: generateSurfaceScenery(cells.filter(cell => Math.abs(cell.x - x) + Math.abs(cell.y - y) <= 4), 'world:0', blocked, focuses, fullRoads).length,
      obstacles: environment.filter(object => object.blocking).length, assets: [...new Set(environment.map(object => object.assetKey))], roads: roads.length } };
});

export const buildSurfaceFixtures = () => {
  const cases = [
    { key: 'meadow', label: '世界树草原', code: 'worldtree_meadow' },
    { key: 'forest', label: '暗影森林', code: 'dark_forest' },
    { key: 'wetland', label: '雾藻湿地', code: 'mistalgae_marsh' },
    { key: 'snow', label: '霜冠高原', code: 'frostcrown_plateau' },
    { key: 'ruins', label: '蚀日遗迹', code: 'eclipse_ruins' }
  ].map(({ key, label, code }) => {
    const area = { region_id: 1, code, is_owner_only: 0, is_enabled: 1, danger_level: 1, min_x: -50, max_x: 50, min_y: -50, max_y: 50, min_z: 0, max_z: 0 };
    const envArea: EnvironmentArea = { regionId: 1, code, enabled: true, danger: 1, minX: -50, maxX: 50, minY: -50, maxY: 50, minZ: 0, maxZ: 0 };
    const focuses = [{ id: 'fixture-landmark-a', x: -5, y: -2, z: 0, regionId: 1 }, { id: 'fixture-landmark-b', x: 4, y: 2, z: 0, regionId: 1 }];
    const known = diamond(7, code);
    const environment = generateEnvironmentForCells([envArea], known, focuses.map(focus => ({ ...focus, radius: 2 })));
    const blocked = new Set(environment.filter(object => object.blocking).flatMap(environmentObjectCells).map(point => `${point.x}:${point.y}:${point.z}`));
    const cells = known.map(cell => ({ ...cell, passable: !blocked.has(`${cell.x}:${cell.y}:${cell.z}`) }));
    const fullRoads = fixedSurfaceRoads(cells, [area], focuses);
    const roads = clipSurfaceRoads(fullRoads, cells), scenery = generateSurfaceScenery(cells, 'world:0', blocked, focuses, fullRoads);
    const rows = [...Array.from({ length: 7 }, (_, index) => mark('walk', index - 3, 0, index + 10, index * 40_000)), mark('blood', -2, 2, 17), mark('slime', 3, -2, 31, 3_600_000)];
    const marks = surfaceMarksFromRows(rows, cells, 'world:0', fixtureNowMs);
    const scene: MapSurfaceScene = { schemaVersion: 1, sceneryVersion: 1, scopeToken: 'world:0', snapshotId: `fixture:${key}`, serverNowMs: fixtureNowMs, terrainFields: [{ regionId: 1, regionCode: code, seed: environmentHash(`surface1:world:0:${code}`) }], scenery, roads, ...marks };
    const small = cells.filter(cell => Math.abs(cell.x) + Math.abs(cell.y) <= 4);
    return { key, label, origin: { x: 0, y: 0, z: 0, regionId: 1 }, sightRange: 7, cells, environment, surfaceScene: scene, stats: { visibleCells: cells.length, scenery: scenery.length, sceneryAtRange4: generateSurfaceScenery(small, 'world:0', blocked, focuses, fullRoads).length, obstacles: environment.filter(object => object.blocking).length } };
  });
  const cells = diamond(4, 'worldtree_meadow');
  // The true mark origin is deliberately absent from this payload; only its authorised halo is sent.
  const marks = surfaceMarksFromRows([mark('blood', 5, 0, 17)], cells, 'world:0', fixtureNowMs);
  const haloScene: MapSurfaceScene = { schemaVersion: 1, sceneryVersion: 1, scopeToken: 'world:0', snapshotId: 'fixture:halo', serverNowMs: fixtureNowMs, terrainFields: [{ regionId: 1, regionCode: 'worldtree_meadow', seed: environmentHash('surface1:world:0:worldtree_meadow') }], scenery: generateSurfaceScenery(cells, 'world:0', new Set()), roads: [], ...marks };
  // Same real seed as the meadow sample, placed near screen centre for an uncropped ink review.
  const meadow = cases[0], centeredCells = meadow.cells, centerFocus = [{ id: 'fixture-ink-space', x: 1, y: 1, z: 0, regionId: 1 }];
  const centeredPaint = surfaceMarkPaint(1, 1, 17, 'blood', .72);
  const withinVisibleGround = (point: { x: number; y: number }) => centeredCells.some(cell => cell.passable && point.x >= cell.x - .5 && point.x <= cell.x + .5 && point.y >= cell.y - .5 && point.y <= cell.y + .5);
  if (!centeredPaint.every(shape => shape.points.every(withinVisibleGround))) throw Error('Central combat fixture must retain the complete authorised splatter.');
  const centeredMarks = surfaceMarksFromRows([mark('blood', 1, 1, 17)], centeredCells, 'world:0', fixtureNowMs);
  const centeredScenery = generateSurfaceScenery(centeredCells, 'world:0', new Set(), centerFocus);
  const centeredScene: MapSurfaceScene = { ...meadow.surfaceScene, snapshotId: 'fixture:centered-combat', roads: [], scenery: centeredScenery, ...centeredMarks };
  const centeredCombat = { key: 'centered-combat', label: '中央完整战斗痕迹', origin: meadow.origin, sightRange: 7, cells: centeredCells, environment: meadow.environment, surfaceScene: centeredScene, stats: { visibleCells: centeredCells.length, scenery: centeredScenery.length, sceneryAtRange4: generateSurfaceScenery(centeredCells.filter(cell => Math.abs(cell.x) + Math.abs(cell.y) <= 4), 'world:0', new Set(), centerFocus).length, obstacles: 0, ...surfaceBloodShapeCounts(17), sourceShapes: centeredPaint.length, completeAuthorisedShape: true } };
  return { schemaVersion: 1, generatedBy: 'server/test/create-map-surface-fixture.ts', cases, v2Cases: buildSurfaceV2Fixtures(), halo: { key: 'halo', origin: { x: 0, y: 0, z: 0, regionId: 1 }, sightRange: 4, cells, environment: [], surfaceScene: haloScene }, centeredCombat };
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const output = new URL('./fixtures/map-surface-fixture.json', import.meta.url);
  mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
  const fixture = buildSurfaceFixtures();
  writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output: fileURLToPath(output), stats: fixture.cases.map(item => ({ key: item.key, ...item.stats })), v2Stats: fixture.v2Cases.map(item => ({ key: item.key, ...item.stats })), haloMarks: fixture.halo.surfaceScene.combatMarks.length, centeredCombat: fixture.centeredCombat.stats })}\n`);
}
