import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { environmentTravelPath, travelWalkingCells } from '../src/game/environment-travel';
import { samePoint } from '../src/game/travel-path';

// Evaluate the real planner with a strict read-only adapter, never the pool
// module whose initialization touches the game's database.
const source = readFileSync(new URL('../src/game/connected-travel.service.ts', import.meta.url), 'utf8');
const first = source.indexOf('export const planConnectedTravel='), last = source.indexOf('/** 寻怪只在当前区域', first);
assert.ok(first >= 0 && last > first);
const compiled = transformSync(source.slice(first, last), { loader: 'ts', format: 'cjs' }).code.replace(/\bimport\(/g, '__fixtureImport(');
const point = (x: number, y = 0) => ({ x, y, z: 0, regionId: 1 });
const areas = [{ region_id: 1, min_x: 0, max_x: 10, min_y: -2, max_y: 2, min_z: 0, max_z: 0, danger_level: 1, is_enabled: 1, is_owner_only: 0 }];

test('actual connected planner passes only the leader perception/public-map preferences into saved walk geometry', async () => {
  const queries: string[] = [], known = [point(3), point(4)], target = point(10);
  let knownReads = 0, environmentReads = 0;
  const db = { execute: async (sql: string) => {
    queries.push(sql); assert.match(sql.trim(), /^SELECT /);
    if (sql.includes('SELECT c.id,p.qq_user_id')) return [[{ id: 7, user: 'fixture-leader' }]];
    if (sql.includes('SELECT DISTINCT pi.character_id')) return [[{ character_id: 7, region_id: 1 }]];
    if (sql.includes('player_leaf_route_progress')) return [[]];
    if (sql.includes('FROM map_region_areas')) return [areas];
    assert.fail(sql);
  } };
  const dependencies = {
    assertLeafDestination: async () => {}, assertEnvironmentIdle: async () => {},
    environmentTravelPath, samePoint,
    environmentForCells: async (connection: unknown) => { assert.equal(connection, db); environmentReads++; return []; },
    __fixtureImport: async (name: string) => {
      assert.equal(name, './adventure.service');
      return { knownRouteTargetsFor: async (user: string, connection: unknown, window: unknown, mapped: number[]) => {
        assert.equal(user, 'fixture-leader'); assert.equal(connection, db); assert.equal(window, undefined); assert.deepEqual(mapped, [1]);
        knownReads++; return known;
      } };
    }
  };
  const module = { exports: {} as any };
  new Function(...Object.keys(dependencies), 'module', 'exports', compiled)(...Object.values(dependencies), module, module.exports);
  const plan = await module.exports.planConnectedTravel(db, 7, point(0), target);
  assert.equal(plan.legs[0].distance, 12); assert.equal(knownReads, 1); assert.equal(environmentReads, 1);
  assert.ok(!travelWalkingCells(plan.legs).some(cell => known.some(occupied => occupied.x === cell.x && occupied.y === cell.y && occupied.z === cell.z)));
  assert.deepEqual(plan.target, target); assert.equal(plan.members.length, 1);
  assert.equal(queries.length, 4, 'no route-start persistence or unseen-spawn query is introduced by planning');
});
