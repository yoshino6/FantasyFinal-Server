import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { mappedWalkRoute, shortestMappedWalk, connectedTravelPath, type TravelPoint } from '../src/game/travel-path';
import { buildTravelVisual, travelObservationPoint } from '../src/game/travel-visual';
import type { TravelPlan } from '../src/game/connected-travel.service';

const point = (x: number, y = 0, z = 0, regionId = 1): TravelPoint => ({ x, y, z, regionId });
const area = (region_id: number, min_x: number, max_x: number, min_y: number, max_y: number, z = 0, danger_level = 1, is_owner_only = 0) => ({ region_id, min_x, max_x, min_y, max_y, min_z: z, max_z: z, danger_level, is_enabled: 1, is_owner_only });
const regions = [{ id: 1, code: 'baina_town', name: '百纳镇' }, { id: 2, code: 'world_tree', name: '世界树' }];
const timing = { id: 'synthetic-route-token', serverNow: 2500, startAt: 1000, arrivalAt: 5000 };
const planFor = (legs: TravelPlan['legs']): TravelPlan => ({ leaderId: 7, members: [{ id: 7, user: 'private-account-subject' }], start: legs[0].from, target: legs.at(-1)!.to, legs, seconds: legs.reduce((sum, leg) => sum + Number(leg.seconds), 0), destinationKind: 'normal' });

test('mapped route exposes the actual cardinal detour and region transitions without changing distance', () => {
  const areas = [area(1, 0, 6, -2, 2), area(9, 2, 4, 0, 0, 0, 10, 1), area(2, 5, 6, -2, 2, 0, 2)];
  const owned = new Set([1, 2]);
  const from = point(0), to = point(6, 0, 0, 2);
  const route = mappedWalkRoute(areas, owned, from, to)!;
  assert.equal(route.distance, 8, 'the private strip adds two steps to a six-step straight distance');
  assert.equal(shortestMappedWalk(areas, owned, from, to), route.distance);
  assert.deepEqual(route.waypoints[0], from); assert.deepEqual(route.waypoints.at(-1), to);
  assert.ok(route.waypoints.some(node => node.regionId === 2));
  let walked = 0;
  for (let index = 1; index < route.waypoints.length; index++) {
    const before = route.waypoints[index - 1], after = route.waypoints[index];
    assert.equal(before.z, after.z); assert.ok(before.x === after.x || before.y === after.y);
    const distance = Math.abs(after.x - before.x) + Math.abs(after.y - before.y); walked += distance;
    for (let step = 0; step <= distance; step++) {
      const x = before.x + Math.sign(after.x - before.x) * step, y = before.y + Math.sign(after.y - before.y) * step;
      const covering = [...areas].sort((a, b) => b.danger_level - a.danger_level).find(candidate => x >= candidate.min_x && x <= candidate.max_x && y >= candidate.min_y && y <= candidate.max_y)!;
      assert.equal(covering.is_owner_only, 0, `walk cannot cross private terrain at ${x}:${y}`);
      assert.ok(owned.has(covering.region_id));
    }
  }
  assert.equal(walked, route.distance);
  const legs = connectedTravelPath(areas, owned, from, to, [])!;
  assert.equal(legs.length, 1); assert.equal(legs[0].distance, 8); assert.deepEqual(legs[0].waypoints, route.waypoints);
  assert.equal(mappedWalkRoute(areas, new Set([1]), from, to), null);
});

const transferPlan = () => {
  const areas = [area(1, 0, 2, 0, 2), area(2, 0, 2, 0, 2, 30)];
  const legs = connectedTravelPath(areas, new Set([1, 2]), point(0), point(2, 0, 30, 2), [
    { kind: 'portal', from: point(1), to: point(0, 0, 30, 2), distance: 1, fromCode: 'world_gate', toCode: 'world_tree_gate' }
  ])!;
  return planFor(legs.map(leg => ({ ...leg, seconds: leg.kind === 'portal' ? 1 : leg.distance })));
};

test('saved leg times produce an absolute shared-clock timeline, cumulative distance, and instant transfers', () => {
  const plan = transferPlan();
  const visual = buildTravelVisual(plan, timing, regions)!;
  assert.equal(plan.seconds, 4); assert.equal(visual.totalDistance, 4);
  assert.deepEqual(visual.segments.map(segment => [segment.kind, segment.instant, segment.startAt, segment.arrivalAt]), [
    ['walk', false, 1000, 2000], ['portal', true, 2000, 3000], ['walk', false, 3000, 5000]
  ]);
  assert.equal(visual.start.regionCode, 'baina_town'); assert.equal(visual.target.regionName, '世界树');
  assert.deepEqual(visual.segments[1].waypoints.map(node => [node.z, node.distance, node.at]), [[0, 1, 2000], [30, 2, 3000]]);
  assert.equal(visual.segments.at(-1)!.waypoints.at(-1)!.distance, 4);
  assert.equal(visual.segments.at(-1)!.waypoints.at(-1)!.at, timing.arrivalAt);
  assert.equal(visual.serverNow, timing.serverNow); assert.equal(visual.id, timing.id);
  assert.ok(!JSON.stringify(visual).includes('private-account-subject')); assert.ok(!('members' in visual)); assert.ok(!('leaderId' in visual));
  const guild = buildTravelVisual(planFor([{ kind: 'guild', from: point(0), to: point(8, 1, 30, 2), distance: 39, seconds: 4 }]), timing, regions)!;
  assert.equal(guild.segments[0].instant, true, 'guild transport is not a straight walk through different floors');
  assert.deepEqual(guild.segments[0].waypoints.map(node => node.at), [1000, 5000]);
});

test('visual data rejects old missing geometry, diagonal guesses, broken distance/chain, and incomplete regions', () => {
  const plan = transferPlan();
  for (const broken of [
    { ...plan, legs: plan.legs.map(leg => ({ ...leg, waypoints: undefined })) },
    { ...plan, legs: [{ kind: 'walk' as const, from: point(0), to: point(1, 1), distance: 2, seconds: 1, waypoints: [point(0), point(1, 1)] }], target: point(1, 1) },
    { ...plan, legs: plan.legs.map((leg, index) => index === 0 ? { ...leg, distance: leg.distance + 1 } : leg) },
    { ...plan, start: point(99) },
    { ...plan, target: point(99) }
  ]) assert.equal(buildTravelVisual(broken, timing, regions), undefined);
  assert.equal(buildTravelVisual(plan, { ...timing, arrivalAt: timing.startAt }, regions), undefined);
  assert.equal(buildTravelVisual(plan, { ...timing, serverNow: NaN }, regions), undefined);
  assert.equal(buildTravelVisual(plan, timing, regions.slice(0, 1)), undefined);
});

test('server-clock observation advances whole cells without revealing future turns or transfer destinations', () => {
  const visual = buildTravelVisual(transferPlan(), timing, regions)!;
  const at = (serverNow: number) => travelObservationPoint({ ...visual, serverNow });
  assert.deepEqual(at(0), visual.start);
  assert.equal(at(1999).x, 0, 'first cell is not revealed before its server-clock landing');
  assert.equal(at(2000).x, 1);
  assert.equal(at(2999).z, 0, 'portal destination stays hidden until the transfer completes');
  assert.equal(at(3000).z, 30);
  assert.equal(at(3999).x, 0);
  assert.equal(at(4000).x, 1);
  assert.deepEqual(at(5000), visual.target);
  assert.deepEqual(at(9000), visual.target);
  const route = planFor([{ kind: 'walk', from: point(4, 3), to: point(0, 0), distance: 7, seconds: 7,
    waypoints: [point(4, 3), point(0, 3), point(0, 0)] }]);
  const negative = buildTravelVisual(route, { ...timing, startAt: 0, arrivalAt: 7000 }, regions)!;
  assert.deepEqual(travelObservationPoint({ ...negative, serverNow: 2999 }), { ...point(2, 3), regionCode: regions[0].code, regionName: regions[0].name });
  assert.deepEqual(travelObservationPoint({ ...negative, serverNow: 4500 }), { ...point(0, 3), regionCode: regions[0].code, regionName: regions[0].name });
  assert.deepEqual(travelObservationPoint({ ...negative, serverNow: 5000 }), { ...point(0, 2), regionCode: regions[0].code, regionName: regions[0].name });
});

const load = (source: string, dependencies: Record<string, unknown>) => {
  const module = { exports: {} as any };
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code.replace(/\bimport\(/g, '__fixtureImport(');
  new Function(...Object.keys(dependencies), '__fixtureImport', 'module', 'exports', code)(...Object.values(dependencies), async (name: string) => (dependencies.require as (name: string) => unknown)(name), module, module.exports);
  return module.exports;
};

test('actual travelStatus adds a read-only visual and authoritative origin, preserving legacy fields and safe fallbacks', async () => {
  const source = readFileSync(new URL('../src/game/adventure.service.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export const travelStatus ='), end = source.indexOf('export const completeTravel =', start);
  const character = { current_region_id: 1, pos_x: 0, pos_y: 0, pos_z: 0, id: 7 };
  let saved: any = { region_id: 2, target_x: 2, target_y: 0, target_z: 30, activity_type: 'move', destination_kind: 'normal', seconds: 4, remaining: 3, region_name: '世界树', destination_name: null, route_token: timing.id, plan_json: JSON.stringify(transferPlan()), start_at_ms: timing.startAt, arrival_at_ms: timing.arrivalAt, server_now_ms: timing.serverNow };
  const queries: string[] = [];
  const db = { execute: async (sql: string) => {
    queries.push(sql); assert.match(sql.trim(), /^SELECT/i, 'visual reads never move or settle the player');
    if (sql.includes('FROM player_travels')) return [[saved]];
    if (sql.startsWith('SELECT id,code,name FROM map_regions')) return [regions];
    assert.fail(sql);
  } };
  const service = load(source.slice(start, end), {
    characterFor: async () => character, getPool: async () => db, buildTravelVisual,
    parseTravelPlan: (value: any) => typeof value === 'string' ? JSON.parse(value) : value,
    localPositionFor: (row: any) => point(row.pos_x, row.pos_y, row.pos_z, row.current_region_id)
  });
  const result = await service.travelStatus('synthetic');
  assert.deepEqual({ ...result, visual: undefined }, { x: 2, y: 0, z: 30, activityType: 'move', destinationKind: 'normal', regionName: '世界树', destinationName: undefined, seconds: 4, remaining: 3, position: point(0), visual: undefined });
  assert.equal(result.visual.id, timing.id); assert.equal(result.visual.target.z, 30);
  assert.deepEqual(character, { current_region_id: 1, pos_x: 0, pos_y: 0, pos_z: 0, id: 7 });
  assert.equal(queries.length, 2, 'read saved geometry and only its region names');
  assert.match(queries[0], /UNIX_TIMESTAMP\(NOW\(6\)\)/);
  character.pos_x = 1;
  assert.equal((await service.travelStatus('synthetic')).visual, undefined, 'a changed authoritative origin disables the old path');
  character.pos_x = 0;
  saved = { ...saved, plan_json: '{invalid json' };
  assert.equal((await service.travelStatus('synthetic')).visual, undefined);
  saved = { ...saved, plan_json: JSON.stringify(transferPlan()), activity_type: 'hunt' };
  queries.length = 0;
  assert.equal((await service.travelStatus('synthetic')).visual, undefined, 'do not disclose an unperceived hunt route');
  assert.equal(queries.length, 1);
});

test('actual travel start/cancel/settle handlers retain committed authoritative positions even when panel refresh fails', async () => {
  const source = readFileSync(new URL('../src/app-api/router.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  /** 队伍地图侧栏已经完成一次明确确认后'), end = source.indexOf("  router.get(apiPath('/realtime-ticket')", start);
  const handlers = new Map<string, (ctx: any) => Promise<void>>();
  let metadataFails = false, completed = false, active = true, moves = 0;
  const character = () => ({ pos_x: completed ? 2 : 0, pos_y: 0, pos_z: completed ? 30 : 0, current_region_id: completed ? 2 : 1 });
  const visual = buildTravelVisual(transferPlan(), timing, regions)!;
  const adventure = {
    moveTo: async () => { moves++; return { kind: 'travel', seconds: 4, remaining: 4, regionName: '世界树', position: point(0) }; },
    travelStatus: async () => { if (metadataFails) throw Error('optional visual read failed'); return active ? { remaining: 3, position: point(0), visual } : null; },
    cancelTravel: async () => { active = false; return { character: character(), activityType: 'move' }; },
    completeTravel: async () => completed ? { character: character(), kind: 'event', text: '抵达' } : null,
    localExplorationPosition: async () => point(completed ? 2 : 0, 0, completed ? 30 : 0, completed ? 2 : 1)
  };
  load(source.slice(start, end), {
    router: { post: (path: string, handler: (ctx: any) => Promise<void>) => handlers.set(path, handler) }, apiPath: (path: string) => path,
    requireSession: async () => ({}), appSessionQqUser: async () => 'synthetic', parseBody: async (ctx: any) => ctx.input,
    appQuickPanel: async () => { throw Error('optional panel read failed'); }, require: () => adventure,
    apiError: (ctx: any, status: number, message: string) => { ctx.status = status; ctx.body = { ok: false, message }; }
  });
  const starting: any = { input: { x: 2, y: 0, z: 30 } };
  await handlers.get('/explore/travel')!(starting);
  assert.equal(starting.body.ok, true); assert.equal(starting.body.panel, null);
  assert.deepEqual(starting.body.position, point(0), 'a started timer is not a completed arrival');
  assert.equal(starting.body.travel.visual.id, timing.id);
  metadataFails = true;
  const fallback: any = { input: starting.input };
  await handlers.get('/explore/travel')!(fallback);
  assert.equal(fallback.body.ok, true); assert.equal(fallback.body.travel, undefined); assert.deepEqual(fallback.body.position, point(0));
  assert.equal(moves, 2, 'optional metadata failure does not retry the movement');
  metadataFails = false;
  const pending: any = {}; await handlers.get('/explore/travel/settle')!(pending);
  assert.equal(pending.body.kind, 'pending'); assert.deepEqual(pending.body.position, point(0)); assert.equal(pending.body.travel.visual.id, timing.id);
  const cancelled: any = {}; await handlers.get('/explore/travel/cancel')!(cancelled);
  assert.equal(cancelled.body.ok, true); assert.deepEqual(cancelled.body.position, point(0)); assert.equal(cancelled.body.panel, null);
  completed = true;
  const settled: any = {}; await handlers.get('/explore/travel/settle')!(settled);
  assert.equal(settled.body.kind, 'event'); assert.deepEqual(settled.body.position, point(2, 0, 30, 2)); assert.equal(settled.body.panel, null);
});
