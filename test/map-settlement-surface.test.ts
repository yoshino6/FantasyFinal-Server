import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as sourceSurface from '../src/game/map-surface-scene';
import type { LocalMapCell } from '../src/game/local-exploration-route';
const surface = process.env.FF_SETTLEMENT_STAGE
  ? await import(pathToFileURL(process.env.FF_SETTLEMENT_STAGE).href) as typeof sourceSurface : sourceSurface;
const grid = (code: string, size = 25): LocalMapCell[] => Array.from({ length: size * size }, (_, index) => ({ x: index % size - 12, y: Math.floor(index / size) - 12, z: 0, regionId: 1, regionCode: code, passable: true }));
const area = (code: string) => ({ region_id: 1, code, is_owner_only: 0, is_enabled: 1, danger_level: 99, min_x: -12, max_x: 12, min_y: -12, max_y: 12, min_z: 0, max_z: 0, generation_version: 1 });
const focuses = [[-10,-8],[-10,8],[10,-8],[10,8],[0,0],[0,8]].map(([x,y],i)=>({ id: `private-focus-${i}`, region_id: 1, x, y, z: 0 }));
function fakeDb(code: string, overrides: { areas?: ReturnType<typeof area>[]; focuses?: typeof focuses } = {}) {
  const sqls: string[] = [];
  return { sqls, execute: async (sql: string) => {
    sqls.push(sql); assert.match(sql.trim(), /^SELECT /);
    if (sql.startsWith('SELECT code')) return [[{ code, is_owner_only: 0, is_enabled: 1 }]];
    if (sql.startsWith('SELECT a.*')) return [overrides.areas ?? [area(code)]];
    if (sql.startsWith('SELECT CONCAT')) return [overrides.focuses ?? focuses];
    if (sql.startsWith('SELECT event_key')) return [[]];
    throw Error(`unexpected fake read ${sql}`);
  } };
}
test('settlement scene returns a complete multi-edge plan without focus identifiers or natural scatter', async () => {
  const cells = grid('baina_town'), db = fakeDb('baina_town');
  const result = (await surface.surfaceSceneFor(db as any, { ...cells[0], regionId: 1 }, cells, []))!;
  assert.ok(result.roads.length > 3);
  assert.ok(result.scenery.length > 0);
  assert.ok(result.scenery.every(item => /^settlement_[012]$/.test(item.assetKey) && item.rotation === 0 && !item.flip));
  assert.ok(!JSON.stringify({ roads: result.roads, scenery: result.scenery }).includes('private-focus-'));
  assert.ok(db.sqls.every(sql => sql.trim().startsWith('SELECT ')));
});
test('settlement full planning is invariant to focus order and clipped scenery matches an overlapping window', async () => {
  const cells = grid('world_tree'), db = fakeDb('world_tree');
  const broad = (await surface.surfaceSceneFor(db as any, { x: 0, y: 0, z: 0, regionId: 1 }, cells, []))!;
  const shuffled = (await surface.surfaceSceneFor(fakeDb('world_tree', { focuses: [...focuses].reverse().map(point => ({ ...point, id: `different-${point.x}-${point.y}` })) }) as any, { x: 0, y: 0, z: 0, regionId: 1 }, [...cells].reverse(), []))!;
  assert.deepEqual(shuffled.roads, broad.roads); assert.deepEqual(shuffled.scenery, broad.scenery);
  const smallCells = cells.filter(cell => cell.x >= -6 && cell.x <= 6 && cell.y >= -6 && cell.y <= 6);
  const small = (await surface.surfaceSceneFor(db as any, { x: 0, y: 0, z: 0, regionId: 1 }, smallCells, []))!;
  for (const item of small.scenery) assert.deepEqual(item, broad.scenery.find(other => other.id === item.id));
  assert.ok(small.scenery.every(item => ['settlement_2','settlement_3','settlement_4'].includes(item.assetKey)));
  assert.ok(small.roads.every(road=>road.points.every(point=>smallCells.some(cell=>cell.x===point.x&&cell.y===point.y))));
});
test('live blockers and revoked private overlays remain blank while cached decisions stay read-only', async () => {
  const cells = grid('baina_town'), db = fakeDb('baina_town');
  const broad = (await surface.surfaceSceneFor(db as any, { x: 0, y: 0, z: 0, regionId: 1 }, cells, []))!;
  const blockedCells = cells.map(cell=>({...cell,passable:cell.passable&&cell.x!==0}));
  const clipped = (await surface.surfaceSceneFor(db as any, { x: -1, y: 0, z: 0, regionId: 1 }, blockedCells, []))!;
  assert.ok(clipped.roads.every(road=>road.points.every(point=>point.x!==0)));
  assert.ok(clipped.scenery.every(item=>Math.abs(item.x)>.5));
  const privateArea = { ...area('private_story'), region_id: 9, danger_level: 100, min_x: 2 };
  const revoked = (await surface.surfaceSceneFor(fakeDb('baina_town',{areas:[area('baina_town'),privateArea]}) as any, { x: 0, y: 0, z: 0, regionId: 1 }, cells.filter(cell=>cell.x<2), []))!;
  assert.ok(revoked.roads.every(road=>road.points.every(point=>point.x<2)));
  assert.ok(revoked.scenery.every(item=>item.x<2));
  if(broad.scenery[0]) broad.scenery[0].assetKey='mutated-response';
  const again=(await surface.surfaceSceneFor(db as any,{x:0,y:0,z:0,regionId:1},cells,[]))!;
  assert.ok(again.scenery.every(item=>item.assetKey!=='mutated-response'));
});
test('other regions keep the existing fixed roads and natural scenery output exactly', async () => {
  const code='worldtree_meadow',cells=grid(code),db=fakeDb(code),objects=[];
  const actual=(await surface.surfaceSceneFor(db as any,{x:0,y:0,z:0,regionId:1},cells,objects))!;
  const sourceFocus=focuses.map(point=>({...point,regionId:1}));
  const fixed=surface.fixedSurfaceRoads(cells,[area(code)],sourceFocus);
  assert.deepEqual(actual.roads,surface.clipSurfaceRoads(fixed,cells));
  assert.deepEqual(actual.scenery,surface.generateSurfaceScenery(cells,'world:0',new Set(),sourceFocus,fixed));
  assert.ok(actual.scenery.every(item=>!item.assetKey.startsWith('settlement_')));
});
