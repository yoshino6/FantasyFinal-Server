import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { kingbeastMapTargets } from '../src/game/kingbeast.config';

// Execute the actual service functions without importing the initializing pool.
const servicePath = process.env.FF_NEARBY_SERVICE_STAGE ?? fileURLToPath(new URL('../src/game/adventure.service.ts', import.meta.url));
const staged = servicePath.endsWith('.js');
const source = readFileSync(servicePath, 'utf8');
const between = (start: string, end: string) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, start);
  return source.slice(first, last);
};
const nearbySource = [
  between('const visiblePursuitCondition =', 'const createCityPursuitEncounter ='),
  between('const assertOwnerOnlyRegionAccess =', `${staged ? '' : 'export '}const localExplorationPosition =`),
  between(`${staged ? '' : 'export '}const nearbyPoints =`, `${staged ? '' : 'export '}const trackMonster =`),
  ...(staged ? ['export { nearbyPoints };'] : []),
  'export { nearbyPointsForWindow };'
].join('\n');

const fixture = () => {
  const character = { id: 10, current_region_id: 1, pos_x: 0, pos_y: 0, pos_z: 0, region_name: '世界树草原', level: 30 };
  const area = (region_id: number, code: string, min_x: number, max_x: number, min_y = -12, max_y = 12, z = 0, is_owner_only = 0, is_enabled = 1) => ({ region_id, code, min_x, max_x, min_y, max_y, min_z: z, max_z: z, is_owner_only, is_enabled });
  const areas = [area(9, 'private_room', 2, 2, 0, 0, 0, 1), area(8, 'closed_forest', 3, 3, 0, 0, 0, 0, 0), area(7, 'floating_leaf_town', 1, 1, 2, 2), area(6, 'other_floor', -12, 12, -12, 12, 1), area(1, 'worldtree_meadow', -12, 0), area(2, 'dark_forest', 1, 12)];
  const entity = (id: number, region_id: number, x: number, y: number, z = 0) => ({ id, region_id, x, y, z, name: `目标${id}`, code: `code_${id}`, template_code: 'test_monster', monster_class: 'normal', level: 5, traits_json: [], interaction_kind: 'npc' });
  const monsters = [entity(101, 1, 0, 1), entity(102, 2, 1, 0), entity(103, 2, 4, 0), entity(109, 9, 2, 0), entity(108, 8, 3, 0), entity(107, 7, 1, 2), entity(106, 2, 1, 0, 1), entity(105, 1, 1, 0), entity(104, 2, 3, 2)];
  const npcs = [entity(201, 1, -1, 1), entity(202, 2, 1, 1), entity(203, 2, 4, 0), { ...entity(204, 2, 2, -1), code: 'evolution_lab' }];
  const resources = [entity(301, 1, -1, 0), entity(302, 2, 1, -1), { ...entity(303, 2, 1, -1), code: 'code_302' }, entity(304, 2, 4, 0), entity(309, 2, 2, 0)];
  const objects = [entity(401, 2, 2, 1), entity(409, 9, 2, 0)];
  const entrances = [entity(501, 2, 1, -2), entity(509, 2, 2, 0)];
  const queries: { sql: string; values: unknown[] }[] = [];
  const permittedLeaf: number[] = [], playerLookups: number[] = [];
  let home = false, party: string | undefined, owner = false, partyOwners = 0, leafPermit = false, permissionFailure: unknown, bountyRefreshes = 0;
  const db = { execute: async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    assert.match(sql.trim(), /^SELECT /, 'boundary perception does not write state');
    if (sql.includes('FROM map_region_areas')) {
      const range = character.region_name === '地下迷宫' ? 1 : 4;
      assert.deepEqual(values, [character.pos_z, character.pos_x + range, character.pos_x - range, character.pos_y + range, character.pos_y - range]);
      return [areas.filter(item => item.min_z <= Number(values[0]) && item.max_z >= Number(values[0]) && item.min_x <= Number(values[1]) && item.max_x >= Number(values[2]) && item.min_y <= Number(values[3]) && item.max_y >= Number(values[4]))];
    }
    if (sql.includes('SELECT party_id')) return [[...(party ? [{ party_id: party }] : [])]];
    if (sql.includes('game_permissions')) {
      if (permissionFailure) throw permissionFailure;
      return [sql.includes('COUNT(*)') ? [{ total: 2, owners: partyOwners }] : owner ? [{ 1: 1 }] : []];
    }
    // Return surplus rows deliberately: coordinate identity, diamond and layer
    // must still be checked after the SQL's coarse bounding rectangle.
    if (sql.includes('FROM monster_spawns')) return [monsters];
    if (sql.includes('FROM map_npcs')) return [npcs];
    if (sql.includes('FROM resource_spawns')) return [resources];
    if (sql.includes('FROM map_special_objects')) return [objects];
    if (sql.includes('FROM dungeon_entrances')) return [entrances];
    if (sql.includes('FROM map_move_texts')) return [[{ description: '风吹过草地。' }]];
    assert.fail(sql);
  } };
  const dependencies: Record<string, unknown> = {
    getPool: async () => db, characterFor: async () => ({ ...character }), finalAttribute: () => 20,
    perceptionRange: () => 3, equippedEnchantmentEffects: async () => ({ mapPerceptionBonus: 1, trackingMaxTargets: 2, trackingMaxTier: 'normal', revealMonsterMovementState: true }),
    evolutionLabUnlockedFor: async () => false, refreshBounties: async () => { bountyRefreshes++; },
    isInHome: async () => home, dungeonCellAt: async () => true,
    kingbeastMapTargets, traitList: (value: unknown) => value,
    withoutHomeStationResidents: (value: unknown) => value, canTrackMonsterClass: () => true,
    trackingTargetForbiddenReason: () => undefined, resourceKindByCode: () => '植被',
    dungeonPlayersInRange: async (_db: unknown, _id: number, regionId: number) => { playerLookups.push(regionId); return regionId === 2 ? [{ gameId: 99, name: '错误区层的玩家', x: 2, y: 0, wanted: false, inHome: false, isFriend: false }] : []; },
    hasRegionMap: async () => false, sortMapMarkers: (value: unknown) => value,
    appraisalProfileFor: async () => ({ learned: true, informationLevel: 3 })
  };
  const loaded = { exports: {} as { nearbyPoints: (user: string) => Promise<any>; nearbyPointsForWindow: (...args: any[]) => Promise<any> } };
  const compiled = transformSync(nearbySource, { loader: staged ? 'js' : 'ts', format: 'cjs' }).code.replace(/\bimport\(/g, '__fixtureImport(');
  new Function(...Object.keys(dependencies), '__fixtureImport', 'module', 'exports', compiled)(...Object.values(dependencies), async (name: string) => {
    assert.equal(name.replace(/\.js$/, ''), './leaf-route.service');
    return { assertLeafDestination: async (_db: unknown, _id: number, regionId: number) => {
      permittedLeaf.push(regionId);
      if (regionId === 7 && !leafPermit) throw Error('需要航路许可');
    } };
  }, loaded, loaded.exports);
  return { character, areas, queries, permittedLeaf, playerLookups, read: () => loaded.exports.nearbyPoints('boundary-user'),
    readTravelWindow: () => loaded.exports.nearbyPointsForWindow('boundary-user', { ...character }, db, undefined, true),
    bountyRefreshes: () => bountyRefreshes,
    configure: (value: { home?: boolean; party?: string; owner?: boolean; partyOwners?: number; leafPermit?: boolean; permissionFailure?: unknown }) => {
      home = value.home ?? home; party = value.party ?? party; owner = value.owner ?? owner; partyOwners = value.partyOwners ?? partyOwners; leafPermit = value.leafPermit ?? leafPermit; permissionFailure = value.permissionFailure ?? permissionFailure;
    } };
};

test('nearby entities span authorised map boundaries without enlarging the perception diamond', async () => {
  const f = fixture(), result = await f.read();
  assert.equal(result.range, 4); assert.equal(result.actionRange, 3);
  assert.deepEqual(result.points.map((point: any) => point.name).sort(), ['目标101', '目标102', '目标103', '目标201', '目标202', '目标301', '目标302', '目标304', '目标401', '地下迷宫入口'].sort());
  assert.ok(result.points.every((point: any) => point.z === 0 && [1, 2].includes(point.regionId) && point.distance <= 4));
  const neighbour = result.points.filter((point: any) => point.regionId === 2);
  assert.ok(neighbour.length >= 5);
  assert.ok(neighbour.every((point: any) => point.regionCode === 'dark_forest' && point.observedOnly === true));
  assert.equal(neighbour.find((point: any) => point.name === '目标102').trackable, false);
  assert.equal(result.points.find((point: any) => point.name === '目标101').trackable, true);
  assert.equal(result.points.some((point: any) => point.name === '目标203'), false, 'NPC observation remains inside base perception');
  assert.deepEqual(f.playerLookups, [1], 'player visibility remains scoped to its existing town/dungeon rules');
  const entityQueries = f.queries.filter(query => /FROM (monster_spawns|map_npcs|resource_spawns|map_special_objects)/.test(query.sql));
  assert.equal(entityQueries.length, 4);
  for (const query of entityQueries) {
    assert.match(query.sql, /region_id IN \(\?,\?\)/);
    assert.deepEqual(query.values.slice(0, 2), [1, 2], 'closed/private/locked/other-floor region IDs never enter entity SQL');
  }
  assert.match(entityQueries[0].sql, /pursuit_target_id/); assert.match(entityQueries[0].sql, /advanced_profession_trial/);
  assert.equal(f.queries.filter(query => query.sql.includes('FROM map_region_areas')).length, 1);
  assert.equal(f.queries.some(query => /map_environment|map_surface_marks/.test(query.sql)), false, 'entity observation does not regenerate terrain or read obstacle/mark tables');
});

test('travel observation uses the same bounded targets and strips all interaction eligibility', async () => {
  const f = fixture();
  const before = JSON.stringify(f.character);
  const result = await f.readTravelWindow();
  assert.ok(result.points.length > 0);
  assert.ok(result.points.every((item: any) => item.observedOnly === true && item.trackable === false && item.pvpAvailable === false && item.interaction === undefined));
  assert.ok(result.points.every((item: any) => item.z === 0 && [1, 2].includes(item.regionId) && item.distance <= 4));
  assert.equal(result.mapUnlocked, false);
  assert.deepEqual(result.landmarks, []);
  assert.equal(f.queries.some(query => /FROM map_move_texts|FROM player_homes|FROM world_site_states/.test(query.sql)), false);
  assert.equal(JSON.stringify(f.character), before);
  assert.equal(f.bountyRefreshes(), 0, 'a read-only window cannot refresh bounty state');
  Object.assign(f.character, { current_region_id: 2, pos_x: 1, region_name: '幽暗密林' });
  assert.equal((await f.readTravelWindow()).points.some((item: any) => item.name === '错误区层的玩家'), false, 'player rows are also clipped to authorised cell identity');
});

test('crossing a map boundary preserves visible targets and changes only their interaction eligibility', async () => {
  const f = fixture(), before = await f.read();
  Object.assign(f.character, { current_region_id: 2, pos_x: 1, region_name: '幽暗密林' });
  const after = await f.read();
  for (const name of ['目标101', '目标102', '目标202', '目标302', '目标401']) {
    const oldPoint = before.points.find((point: any) => point.name === name), newPoint = after.points.find((point: any) => point.name === name);
    assert.ok(oldPoint && newPoint, name);
    assert.deepEqual([newPoint.x, newPoint.y, newPoint.z, newPoint.regionId, newPoint.regionCode], [oldPoint.x, oldPoint.y, oldPoint.z, oldPoint.regionId, oldPoint.regionCode]);
  }
  assert.equal(after.points.find((point: any) => point.name === '目标102').observedOnly, false);
  assert.equal(after.points.find((point: any) => point.name === '目标102').trackable, true);
  assert.equal(after.points.find((point: any) => point.name === '目标101').observedOnly, true);
  assert.equal(after.points.find((point: any) => point.name === '目标101').trackable, false);
  assert.ok(!after.points.some((point: any) => /目标10[6789]|目标309|目标409/.test(point.name)), 'denied coordinates remain hidden on either side of the seam');
});

test('home and underground observation never leaks neighbouring public coordinates', async () => {
  for (const underground of [false, true]) {
    const f = fixture();
    if (underground) f.character.region_name = '地下迷宫';
    else f.configure({ home: true });
    if (underground) {
      f.areas.find(area => area.region_id === 1)!.code = 'dark_forest_dungeon';
    }
    const result = await f.read();
    assert.ok(result.points.length > 0);
    assert.equal(result.range, underground ? 1 : 4);
    assert.ok(result.points.every((point: any) => point.regionId === 1));
    for (const query of f.queries.filter(query => /FROM (monster_spawns|map_npcs|resource_spawns|map_special_objects)/.test(query.sql))) {
      assert.match(query.sql, /region_id IN \(\?\)/); assert.equal(query.values[0], 1);
    }
  }
});

test('mixed-owner party, missing route permit and permission database failure fail closed', async () => {
  const f = fixture(); f.configure({ party: 'party-1', owner: true, partyOwners: 1 });
  const result = await f.read();
  assert.ok(result.points.every((point: any) => ![7, 8, 9].includes(point.regionId)));
  assert.ok(f.queries.some(query => query.sql.includes('COUNT(*)') && query.values[0] === 'party-1'));
  assert.ok(f.permittedLeaf.includes(7));
  const failure = { code: 'ER_DBACCESS_DENIED_ERROR', message: 'test failure' };
  const g = fixture(); g.configure({ permissionFailure: failure });
  await assert.rejects(g.read(), error => error === failure);
  assert.equal(g.queries.some(query => query.sql.includes('FROM monster_spawns')), false, 'an infrastructure failure cannot fall back to permissive entity queries');
});

test('database string flags retain the same closed and owner-only boundary permissions', async () => {
  const f = fixture();
  for (const area of f.areas) {
    area.is_owner_only = String(area.is_owner_only) as any;
    area.is_enabled = String(area.is_enabled) as any;
  }
  const result = await f.read();
  assert.ok(result.points.some((point: any) => point.regionId === 2));
  assert.ok(result.points.every((point: any) => ![7, 8, 9].includes(point.regionId)));
});
