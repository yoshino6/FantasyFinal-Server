import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertTravelEnvironmentClear, environmentTravelPath, travelWalkingCells, type TravelEnvironmentObject } from '../src/game/environment-travel';
import { connectedTravelPath, mappedWalkRoute, type TravelBlockedCell, type TravelPoint } from '../src/game/travel-path';
import { generateEnvironmentForCells } from '../src/game/map-environment.config';

const point = (x: number, y = 0, z = 0, regionId = 1): TravelPoint => ({ x, y, z, regionId });
const area = (region_id = 1, min_x = 0, max_x = 12, min_y = -4, max_y = 4, z = 0, is_owner_only = 0, danger_level = 1) => ({ region_id, min_x, max_x, min_y, max_y, min_z: z, max_z: z, is_owner_only, danger_level, is_enabled: 1 });
const object = (x: number, y: number, width = 1, height = 1, z = 0, blocking = true): TravelEnvironmentObject => ({
  x, y, z, blocking, name: '测试岩簇', footprint: Array.from({ length: width * height }, (_, index) => ({ dx: index % width, dy: Math.floor(index / width) }))
});
const cellsOf = (value: TravelEnvironmentObject) => value.footprint.map(cell => ({ x: value.x + cell.dx, y: value.y + cell.dy, z: value.z }));
const intersects = (a: TravelBlockedCell, b: TravelBlockedCell) => a.x === b.x && a.y === b.y && a.z === b.z;
const lookupFor = (objects: TravelEnvironmentObject[], calls: TravelBlockedCell[][] = []) => async (cells: readonly TravelBlockedCell[]) => {
  calls.push([...cells]);
  assert.ok(cells.length <= 1000, 'one lookup cannot exceed the database batch size');
  return objects.filter(value => cellsOf(value).some(occupied => cells.some(cell => intersects(cell, occupied))));
};

test('compressed long edge cannot jump a middle whole-cell footprint, and detour keeps exact distance', () => {
  const blocker = object(3, 0, 3, 2);
  const route = mappedWalkRoute([area()], new Set([1]), point(0), point(10), cellsOf(blocker))!;
  assert.equal(route.distance, 12);
  const legs = [{ kind: 'walk' as const, from: point(0), to: point(10), ...route }];
  const walked = travelWalkingCells(legs);
  assert.ok(walked.some(cell => cell.y === -1));
  assert.ok(!walked.some(cell => cellsOf(blocker).some(occupied => intersects(cell, occupied))));
  assert.equal(mappedWalkRoute([area(1, 0, 10, 0, 0)], new Set([1]), point(0), point(10), cellsOf(blocker)), null);
  assert.equal(mappedWalkRoute([area()], new Set([1]), point(0), point(10), [{ x: 3, y: 0, z: 30 }])!.distance, 10);
});

test('mapped travel prefers avoiding known targets, but endpoints and necessary narrow passages remain reachable', async () => {
  const start = point(0), target = point(10), known = [point(3), point(4), point(5)];
  const legs = await environmentTravelPath([area()], new Set([1]), start, target, [], lookupFor([]), known);
  assert.equal(legs![0].distance, 12);
  assert.ok(!travelWalkingCells(legs!).some(cell => known.some(occupied => intersects(cell, occupied))), 'compressed edges cannot skip the known target coordinates');
  const corridor = await environmentTravelPath([area(1, 0, 10, 0, 0)], new Set([1]), start, target, [], lookupFor([]), known);
  assert.equal(corridor![0].distance, 10, 'preferences do not make a valid single corridor disappear');
  const destination = await environmentTravelPath([area()], new Set([1]), start, target, [], lookupFor([]), [start, target, point(3, 0, 30)]);
  assert.equal(destination![0].distance, 10, 'intentional destinations and other floors do not cause a detour');
  assert.equal(await environmentTravelPath([area()], new Set([1]), start, target, [], lookupFor([object(10, 0)]), [target]), null, 'a real blocker never becomes passable through an endpoint exemption');
});

test('avoiding a target still validates newly traversed cells against real obstacles and preserves transfer stations', async () => {
  const known = [point(3)], preferred = connectedTravelPath([area()], new Set([1]), point(0), point(10), [], [], known)!;
  const extra = travelWalkingCells(preferred).find(cell => cell.x === 3 && cell.y !== 0)!;
  const obstacle = object(extra.x, extra.y), calls: TravelBlockedCell[][] = [];
  const route = await environmentTravelPath([area()], new Set([1]), point(0), point(10), [], lookupFor([obstacle], calls), known);
  assert.ok(route); assert.ok(calls.length > 1, 'new detour obstacles trigger the existing incremental validation');
  assert.ok(!travelWalkingCells(route).some(cell => intersects(cell, known[0]) || intersects(cell, extra)));
  const gate = point(1), exit = point(0, 0, 30, 2), target = point(2, 0, 30, 2);
  const transfers = await environmentTravelPath([area(1, 0, 2, 0, 0), area(2, 0, 2, 0, 0, 30)], new Set([1, 2]), point(0), target,
    [{ kind: 'portal', from: gate, to: exit, distance: 1 }], lookupFor([]), [gate, exit, target]);
  assert.ok(transfers?.some(leg => leg.kind === 'portal'), 'explicit transport endpoints must remain approachable');
});

test('new obstacles discovered on a detour trigger another plan, including all cells of a large object', async () => {
  const first = object(3, 0, 2, 2), areas = [area()];
  const firstDetour = connectedTravelPath(areas, new Set([1]), point(0), point(10), [], cellsOf(first))!;
  const extraCell = travelWalkingCells(firstDetour).find(cell => cell.y !== 0)!;
  const second = object(extraCell.x, extraCell.y), calls: TravelBlockedCell[][] = [];
  const result = await environmentTravelPath(areas, new Set([1]), point(0), point(10), [], lookupFor([first, second], calls));
  assert.ok(result);
  assert.ok(calls.length >= 2, 'the first detour needs cells that were absent from the direct route');
  assert.ok(!calls[0].some(cell => intersects(cell, extraCell)));
  assert.ok(calls.slice(1).some(batch => batch.some(cell => intersects(cell, extraCell))), 'the second obstacle is discovered only during detour validation');
  for (const cell of travelWalkingCells(result)) assert.ok(![first, second].some(value => cellsOf(value).some(occupied => intersects(cell, occupied))));
  const queried = calls.flat().map(cell => `${cell.x}:${cell.y}:${cell.z}`);
  assert.equal(new Set(queried).size, queried.length, 'the planner does not query already checked cells twice');
});

test('cleared obstacles reopen a shorter path; scenery is passable; blocked destinations fail closed', async () => {
  const obstacle = object(3, 0, 2, 2), args = [area()], owned = new Set([1]);
  const detour = await environmentTravelPath(args, owned, point(0), point(10), [], lookupFor([obstacle]));
  assert.equal(detour![0].distance, 12);
  const cleared = await environmentTravelPath(args, owned, point(0), point(10), [], lookupFor([]));
  assert.equal(cleared![0].distance, 10);
  const scenery = await environmentTravelPath(args, owned, point(0), point(10), [], lookupFor([object(3, 0, 2, 2, 0, false)]));
  assert.equal(scenery![0].distance, 10);
  assert.equal(await environmentTravelPath(args, owned, point(0), point(10), [], lookupFor([object(10, 0)])), null);
});

test('detouring cannot enter an unowned or private higher-priority map', async () => {
  const areas = [area(1, 0, 10, -1, 1), area(9, 0, 10, -1, -1, 0, 1, 10)];
  const result = await environmentTravelPath(areas, new Set([1]), point(0), point(10), [], lookupFor([object(4, 0, 1, 2)]));
  assert.equal(result, null, 'private bottom row and blocked top passage leave no permitted route');
});

test('saved routes revalidate all intermediate cells and reject obsolete missing or diagonal geometry', async () => {
  const legs = connectedTravelPath([area()], new Set([1]), point(0), point(10), [])!;
  await assert.rejects(assertTravelEnvironmentClear(legs, lookupFor([object(5, 0)])), /原路线被测试岩簇阻挡/);
  await assert.doesNotReject(assertTravelEnvironmentClear(legs, lookupFor([object(5, 0, 1, 1, 30)])));
  await assert.rejects(assertTravelEnvironmentClear([{ ...legs[0], waypoints: undefined }], lookupFor([])), /缺少完整坐标/);
  assert.throws(() => travelWalkingCells([{ ...legs[0], to: point(10, 1), waypoints: [point(0), point(10, 1)] }]), /路线已改变/);
  assert.throws(() => travelWalkingCells([{ ...legs[0], distance: 11 }]), /路线距离已改变/);
});

test('portal legs never query a fake straight line between floors; long walks use bounded lookup batches', async () => {
  const areas = [area(1, 0, 2, 0, 2), area(2, 0, 2, 0, 2, 30)], calls: TravelBlockedCell[][] = [];
  const legs = await environmentTravelPath(areas, new Set([1, 2]), point(0), point(2, 0, 30, 2), [
    { kind: 'portal', from: point(1), to: point(0, 0, 30, 2), distance: 1 }
  ], lookupFor([object(1, 0, 1, 1, 15)], calls));
  assert.ok(legs?.some(leg => leg.kind === 'portal'));
  assert.ok(calls.flat().every(cell => cell.z === 0 || cell.z === 30));
  const batches: TravelBlockedCell[][] = [];
  const long = await environmentTravelPath([area(1, 0, 2500, 0, 0)], new Set([1]), point(0), point(2500), [], lookupFor([], batches));
  assert.equal(long![0].distance, 2500); assert.deepEqual(batches.map(batch => batch.length), [1000, 1000, 501]);
});

test('a long route through generated forest uses the connected natural lanes without scanning the whole world', async () => {
  const areas = [area(1, 0, 300, -30, 30)], ecology = [{ regionId: 1, code: 'dark_forest', danger: 1, enabled: true, minX: 0, maxX: 300, minY: -30, maxY: 30, minZ: 0, maxZ: 0 }];
  let queried = 0;
  const route = await environmentTravelPath(areas, new Set([1]), point(0, 3), point(300, 3), [], async cells => {
    queried += cells.length;
    return generateEnvironmentForCells(ecology, cells);
  });
  assert.ok(route); assert.ok(route[0].distance >= 300 && route[0].distance <= 312);
  assert.ok(queried < 1000, `only ${queried} route cells were needed for an 18361-cell region`);
  await assertTravelEnvironmentClear(route, async cells => generateEnvironmentForCells(ecology, cells));
});

test('v2 living-tree route planning and saved-route revalidation use the same complete physical generator', async () => {
  const areas = [area(1, 0, 300, -30, 30)], ecology = [{ regionId: 1, code: 'dark_forest', danger: 1, enabled: true, minX: 0, maxX: 300, minY: -30, maxY: 30, minZ: 0, maxZ: 0, generationVersion: 2 as const }];
  let queried = 0;
  const route = await environmentTravelPath(areas, new Set([1]), point(0, 3), point(300, 3), [], async cells => { queried += cells.length; return generateEnvironmentForCells(ecology, cells); });
  assert.ok(route); assert.ok(route[0].distance >= 300 && route[0].distance <= 312);
  assert.ok(queried < 1000);
  await assertTravelEnvironmentClear(route, async cells => generateEnvironmentForCells(ecology, cells));
});
