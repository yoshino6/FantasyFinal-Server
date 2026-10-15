import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { transformSync } from 'esbuild';
import * as generation from '../src/game/map-environment.config';
import { environmentV2HabitatAt, environmentV2Seed, environmentV2Templates } from '../src/game/map-environment-v2.config';
import { sampleSurfaceEcologyV2, surfaceEcologySeedV2 } from '../src/game/map-ecology-field';
import { environmentProfileBoundsOverlap, initializeMapEnvironment, registerMapEnvironmentProfile, registerMapEnvironmentProfileIn } from '../src/database/map-environment';
const { generateEnvironmentForCells: generate, environmentObjectCells: occupied, environmentDrops, parseEnvironmentObjectId } = generation;
const area: generation.EnvironmentArea = { regionId: 7, code: 'dark_forest', danger: 2, enabled: true, minX: -120, maxX: 119, minY: -120, maxY: 119, minZ: 0, maxZ: 0, generationVersion: 2, generationSeed: environmentV2Seed };
const cells = (x: number, y: number, width: number, height: number) => Array.from({ length: width * height }, (_, i) => ({ x: x + i % width, y: y + Math.floor(i / width), z: 0 }));
const whole = cells(-60, -60, 120, 120);

test('env1 golden: eleven before scenarios retain all 665 identities, occupancy, seeds and drops', () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/map-environment-v1-golden.json', import.meta.url), 'utf8'));
  const before = readFileSync(new URL('./fixtures/map-environment-v1-before.txt', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(before).digest('hex'), golden.sourceSha256);
  let compared = 0;
  for (const scenario of golden.scenarios) {
    const w = scenario.window;
    const generated = generate(scenario.areas, cells(w.minX, w.minY, w.maxX - w.minX + 1, w.maxY - w.minY + 1), scenario.protections);
    const project = (o: generation.GeneratedEnvironmentObject) => ({ id: o.id, templateId: o.templateId, regionId: o.regionId, x: o.x, y: o.y, z: o.z, width: o.width, height: o.height, footprint: o.footprint, seed: o.seed, variant: o.variant, drops: environmentDrops(o) });
    assert.deepEqual(generated.map(project), scenario.objects, scenario.name);
    assert.deepEqual(generate(scenario.areas.map((a: object) => ({ ...a, generationVersion: 1 })), [...cells(w.minX, w.minY, w.maxX - w.minX + 1, w.maxY - w.minY + 1)].reverse(), scenario.protections).map(project), scenario.objects);
    compared += generated.length;
  }
  assert.equal(compared, 665);
});

test('v2 trees have full integer occupancy, stable partial-view identities and reusable home materials', () => {
  const objects = generate([area], whole);
  assert.ok(objects.length > 100);
  assert.deepEqual(generate([area], [...whole].reverse()), objects);
  assert.deepEqual(new Set(objects.map(o => o.assetKey)), new Set(Object.keys(environmentV2Templates)));
  const keys = new Set<string>();
  for (const object of objects) {
    assert.ok(object.id.startsWith('env2:'));
    assert.equal(object.footprint.length, object.width * object.height);
    assert.ok(object.blocking && object.destructible);
    for (const cell of occupied(object)) {
      assert.ok([cell.x, cell.y, cell.z].every(Number.isSafeInteger));
      const key = `${cell.x}:${cell.y}:${cell.z}`;
      assert.ok(!keys.has(key), key); keys.add(key);
      assert.notEqual((cell.x % 6 + 6) % 6, 0); assert.notEqual((cell.y % 6 + 6) % 6, 0);
    }
    assert.deepEqual(generate([area], [occupied(object).at(-1)!]).find(o => o.id === object.id), object);
    assert.ok(environmentDrops(object).every(drop => ['home_wood', 'home_stone'].includes(drop.code)));
  }
});

test('frozen v2 full-region checksums and shared world-field samples prevent silent physical drift', () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/map-environment-v2-golden.json', import.meta.url), 'utf8'));
  assert.equal(golden.frozenVersion, 2); assert.equal(golden.seed, environmentV2Seed);
  for (const point of golden.points) {
    assert.deepEqual(environmentV2HabitatAt(point.x, point.y, point.z), point.field);
    assert.deepEqual(point.field, sampleSurfaceEcologyV2(point.x, point.y, surfaceEcologySeedV2(`world:${point.z}`)));
  }
  for (const scenario of golden.scenarios) {
    const r = scenario.rectangle;
    const objects = generate([scenario.area], cells(r.x, r.y, r.width, r.height), scenario.protections).map(object => ({ ...object, drops: environmentDrops(object) }));
    assert.equal(objects.length, scenario.count, scenario.name);
    assert.equal(createHash('sha256').update(JSON.stringify(objects)).digest('hex'), scenario.sha256, scenario.name);
  }
});

test('v2 empty cells remain connected to permanent lanes, with dense groves and real openings', () => {
  const objects = generate([area], whole), blocked = new Set(objects.flatMap(occupied).map(c => `${c.x}:${c.y}`));
  const queue = [{ x: -60, y: -60 }], seen = new Set(['-60:-60']);
  for (let index = 0; index < queue.length; index++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const point = { x: queue[index]!.x + dx!, y: queue[index]!.y + dy! }, key = `${point.x}:${point.y}`;
    if (point.x < -60 || point.x > 59 || point.y < -60 || point.y > 59 || blocked.has(key) || seen.has(key)) continue;
    queue.push(point); seen.add(key);
  }
  assert.equal(seen.size + blocked.size, whole.length);
  const counts = new Map<string, number>();
  for (const o of objects) { const key = `${Math.floor(o.x / 6)}:${Math.floor(o.y / 6)}`; counts.set(key, (counts.get(key) ?? 0) + 1); }
  assert.ok([...counts.values()].some(n => n === 2), 'groves can hold two disjoint trees');
  assert.ok(counts.size < 350, 'other sectors remain true openings');
});

test('v2 protects landmarks/branches and does not overwrite legacy overlays, towns or dungeon floors', () => {
  const first = generate([area], whole)[0]!;
  assert.ok(!generate([area], whole, [{ x: first.x, y: first.y, z: 0, radius: 2 }]).some(o => o.id === first.id));
  const town = { ...area, regionId: 99, code: 'baina_town', danger: 99, minX: -20, maxX: 20, minY: -20, maxY: 20, generationVersion: 1 as const };
  const mixed = generate([area, town], whole);
  for (const o of mixed.filter(o => o.id.startsWith('env2:'))) assert.ok(occupied(o).every(c => c.x < -20 || c.x > 20 || c.y < -20 || c.y > 20));
  assert.ok(mixed.some(o => o.id.startsWith('env1:')));
  assert.deepEqual(generate([{ ...area, code: 'baina_town' }], whole), []);
  assert.deepEqual(generate([{ ...area, minZ: -10, maxZ: -10 }], whole.map(c => ({ ...c, z: -10 }))), []);
  assert.throws(() => generate([area], [{ x: .5, y: 0, z: 0 }]), /整数整格/);
});

test('object ID parser accepts only canonical whole-cell v1/v2 IDs', () => {
  assert.deepEqual(parseEnvironmentObjectId('env2:dark_forest:-7:8:0:1'), { version: 2, regionCode: 'dark_forest', x: -7, y: 8, z: 0, slot: 1 });
  for (const id of ['env3:dark_forest:1:1:0:0', 'env2:dark_forest:01:1:0:0', 'env2:dark_forest:-0:1:0:0', 'env2:dark_forest:1.5:1:0:0', 'env2:dark_forest:1:1:-10:0', 'env2:dark_forest:9007199254740992:1:0:0']) assert.equal(parseEnvironmentObjectId(id), null);
});

test('new forest region codes receive v2 ecology, while new towns, inns, arenas and dungeons fail closed', () => {
  const frontier = generate([{ ...area, code: 'dark_forest_frontier' }], whole);
  assert.ok(frontier.some(object => object.assetKey === 'living_oak'));
  assert.ok(frontier.every(object => object.id.startsWith('env2:dark_forest_frontier:')));
  for (const code of ['frontier_town', 'pine_inn', 'festival_arena', 'lost_dungeon', 'dark_forest_dungeon_frontier']) assert.deepEqual(generate([{ ...area, code }], whole), [], code);
});

const profileFixture = (profile?: { generation_version: number; generation_seed: string }, enabled = false, occupiedRegion = false, overlap = false, closedReservation?: 1 | 2, code = 'dark_forest_frontier') => {
  const writes: string[] = [], events: string[] = [];
  const db = { execute: async (sql: string, args: any[]) => {
    if (sql.startsWith('SELECT id FROM map_regions ORDER BY id')) { assert.match(sql, /LIMIT 1 FOR UPDATE/); events.push('registration-gate'); return [[{ id: 1 }]]; }
    if (sql.startsWith('SELECT id,code,is_enabled')) { assert.match(sql, /FOR UPDATE/); events.push('region-lock'); return [[{ id: 7, code, is_enabled: +enabled }]]; }
    if (sql.startsWith('SELECT generation_version')) { assert.equal(events.at(-1), 'region-lock'); assert.match(sql, /FOR UPDATE/); return [profile ? [profile] : []]; }
    if (sql.startsWith('SELECT r.id AS region_id')) { assert.match(sql, /LEFT JOIN map_region_areas/); assert.match(sql, /LEFT JOIN map_environment_region_profiles p/); assert.match(sql, /OR p.region_id IS NOT NULL/); assert.match(sql, /COALESCE\(a.min_z,r.min_z\)/); assert.match(sql, /FOR UPDATE/); return [[{ region_id: 7, min_x: 0, max_x: 10, min_y: 0, max_y: 10, min_z: 0, max_z: 0 }, ...(overlap || closedReservation ? [{ region_id: 1, min_x: 10, max_x: 20, min_y: 0, max_y: 10, min_z: 0, max_z: 0, is_enabled: closedReservation ? 0 : 1, generation_version: closedReservation }] : [])]]; }
    if (sql.startsWith("SELECT '角色'")) return [occupiedRegion ? [{ kind: '角色' }] : []];
    if (sql.startsWith('INSERT INTO map_environment_region_profiles')) { assert.ok(!profile); writes.push(sql); profile = { generation_version: args[1], generation_seed: args[2] }; return [{ affectedRows: 1 }]; }
    throw new Error(`Unexpected profile SQL ${sql}`);
  } };
  return { db, writes, events };
};
test('region profiles are insert-only, idempotent and refuse existing v1 or seed changes', async () => {
  const fixture = profileFixture();
  assert.equal((await registerMapEnvironmentProfileIn(fixture.db as any, 7, 2)).inserted, true);
  assert.equal((await registerMapEnvironmentProfileIn(fixture.db as any, 7, 2)).inserted, false);
  assert.equal(fixture.writes.length, 1);
  await assert.rejects(registerMapEnvironmentProfileIn(fixture.db as any, 7, 1), /不能切换/);
  await assert.rejects(registerMapEnvironmentProfileIn(fixture.db as any, 7, 2, 'other-seed'), /不能切换/);
  await assert.rejects(registerMapEnvironmentProfileIn(profileFixture({ generation_version: 1, generation_seed: environmentV2Seed }).db as any, 7, 2), /不能切换/);
  await assert.rejects(registerMapEnvironmentProfileIn(profileFixture(undefined, true).db as any, 7, 2), /开放之前/);
  await assert.rejects(registerMapEnvironmentProfileIn(profileFixture(undefined, false, true).db as any, 7, 2), /已有角色/);
  await assert.rejects(registerMapEnvironmentProfileIn(profileFixture(undefined, false, false, true).db as any, 7, 2), /范围重叠/);
});

test('closed registered v1 and v2 regions reserve their whole-cell bounds before release', async () => {
  for (const version of [1, 2] as const) {
    const fixture = profileFixture(undefined, false, false, false, version);
    await assert.rejects(registerMapEnvironmentProfileIn(fixture.db as any, 7, 2), /已登记保留区域.*范围重叠/);
    assert.equal(fixture.writes.length, 0, `closed env${version} reservation rejects before profile INSERT`);
    assert.deepEqual(fixture.events, ['registration-gate', 'region-lock']);
  }
});

test('new v2 region codes must round-trip canonical object IDs, while old v1 registration stays idempotent', async () => {
  for (const code of ['', 'NewForest', 'new-forest', '新森林', 'a'.repeat(65)]) {
    const fixture = profileFixture(undefined, false, false, false, undefined, code);
    await assert.rejects(registerMapEnvironmentProfileIn(fixture.db as any, 7, 2), /区域编号必须/);
    assert.equal(fixture.writes.length, 0, code);
  }
  const legacy = profileFixture({ generation_version: 1, generation_seed: environmentV2Seed }, false, false, false, undefined, 'Legacy-Code');
  assert.equal((await registerMapEnvironmentProfileIn(legacy.db as any, 7, 1)).inserted, false);
  const canonical = profileFixture(undefined, false, false, false, undefined, 'a'.repeat(64));
  assert.equal((await registerMapEnvironmentProfileIn(canonical.db as any, 7, 2)).inserted, true);
});

test('registration overlap uses inclusive 3D areas: touching cells conflict, adjacent cells or floors do not', () => {
  const bounds = { regionId: 7, minX: -10, maxX: 10, minY: -5, maxY: 5, minZ: 0, maxZ: 0 };
  assert.equal(environmentProfileBoundsOverlap(bounds, { ...bounds, regionId: 1, minX: 10, maxX: 30 }), true);
  assert.equal(environmentProfileBoundsOverlap(bounds, { ...bounds, regionId: 1, minX: 11, maxX: 30 }), false);
  assert.equal(environmentProfileBoundsOverlap(bounds, { ...bounds, regionId: 1, minZ: 1, maxZ: 1 }), false);
  assert.equal(environmentProfileBoundsOverlap(bounds, { ...bounds, regionId: 1, minY: 6, maxY: 30 }), false);
  assert.equal(environmentProfileBoundsOverlap(bounds, bounds), false, 'same-region fragments do not reject themselves');
  const fragments = [{ ...bounds, regionId: 1, minX: 30, maxX: 40 }, { ...bounds, regionId: 1, minX: -30, maxX: -10 }];
  assert.ok(fragments.some(fragment => environmentProfileBoundsOverlap(bounds, fragment)), 'any occupied area fragment must reject registration');
});
test('profile wrapper owns commit/rollback/release and never opens an external pool', async () => {
  for (const fail of [false, true]) {
    const fixture = profileFixture(fail ? { generation_version: 1, generation_seed: environmentV2Seed } : undefined);
    const events: string[] = [];
    const connection = { ...fixture.db, beginTransaction: async () => { events.push('begin'); }, commit: async () => { events.push('commit'); }, rollback: async () => { events.push('rollback'); }, release: () => { events.push('release'); } };
    const promise = registerMapEnvironmentProfile({ getConnection: async () => connection } as any, 7, 2);
    if (fail) await assert.rejects(promise, /不能切换/); else await promise;
    assert.deepEqual(events, ['begin', fail ? 'rollback' : 'commit', 'release']);
  }
});

test('concurrent profile registration is serialized by the region lock, with one immutable insert', async () => {
  let tail = Promise.resolve(), profile: any, inserts = 0;
  const pool = { getConnection: async () => {
    let unlock: (() => void) | undefined;
    return {
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => { unlock?.(); },
      execute: async (sql: string, args: any[]) => {
        if (sql.startsWith('SELECT id FROM map_regions ORDER BY id')) { const previous = tail; tail = new Promise<void>(resolve => { unlock = resolve; }); await previous; return [[{ id: 1 }]]; }
        if (sql.startsWith('SELECT id,code,is_enabled')) {
          if (!unlock) { const previous = tail; tail = new Promise<void>(resolve => { unlock = resolve; }); await previous; }
          return [[{ id: 7, code: 'dark_forest_frontier', is_enabled: 0 }]];
        }
        assert.ok(unlock, 'registration must hold the region lock');
        if (sql.startsWith('SELECT generation_version')) return [profile ? [profile] : []];
        if (sql.startsWith('SELECT r.id AS region_id')) return [[{ region_id: 7, min_x: 0, max_x: 10, min_y: 0, max_y: 10, min_z: 0, max_z: 0 }]];
        if (sql.startsWith("SELECT '角色'")) return [[]];
        if (sql.startsWith('INSERT INTO map_environment_region_profiles')) { assert.ok(!profile); inserts++; profile = { generation_version: args[1], generation_seed: args[2] }; return [{ affectedRows: 1 }]; }
        throw new Error(`Unexpected registration SQL ${sql}`);
      }
    };
  } };
  const result = await Promise.all([registerMapEnvironmentProfile(pool as any, 7, 2), registerMapEnvironmentProfile(pool as any, 7, 2)]);
  assert.equal(inserts, 1); assert.equal(result.filter(r => r.inserted).length, 1);
  await assert.rejects(registerMapEnvironmentProfile(pool as any, 7, 1), /不能切换/);
});

test('different closed v2 regions cannot concurrently commit overlapping reservations', async () => {
  let tail = Promise.resolve(), inserts = 0, commits = 0, rollbacks = 0;
  const profiles = new Map<number, { generation_version: number; generation_seed: string }>();
  const bounds = (regionId: number) => ({ region_id: regionId, min_x: 0, max_x: 10, min_y: 0, max_y: 10, min_z: 0, max_z: 0 });
  const pool = { getConnection: async () => {
    let unlock: (() => void) | undefined, pending: { regionId: number; version: number; seed: string } | undefined;
    return {
      beginTransaction: async () => {},
      commit: async () => { if (pending) profiles.set(pending.regionId, { generation_version: pending.version, generation_seed: pending.seed }); commits++; },
      rollback: async () => { pending = undefined; rollbacks++; }, release: () => { unlock?.(); },
      execute: async (sql: string, args: any[] = []) => {
        if (sql.startsWith('SELECT id FROM map_regions ORDER BY id')) {
          const previous = tail; tail = new Promise<void>(resolve => { unlock = resolve; }); await previous;
          return [[{ id: 1 }]];
        }
        assert.ok(unlock, 'shared current-read registration gate must precede target locks');
        if (sql.startsWith('SELECT id,code,is_enabled')) return [[{ id: args[0], code: `dark_forest_frontier_${args[0]}`, is_enabled: 0 }]];
        if (sql.startsWith('SELECT generation_version')) return [profiles.has(args[0]) ? [profiles.get(args[0])] : []];
        if (sql.startsWith('SELECT r.id AS region_id')) {
          assert.match(sql, /OR p.region_id IS NOT NULL/);
          return [[bounds(args[0]), ...[...profiles.keys()].filter(id => id !== args[0]).map(bounds)]];
        }
        if (sql.startsWith("SELECT '角色'")) return [[]];
        if (sql.startsWith('INSERT INTO map_environment_region_profiles')) { inserts++; pending = { regionId: args[0], version: args[1], seed: args[2] }; return [{ affectedRows: 1 }]; }
        throw new Error(`Unexpected concurrent reservation SQL ${sql}`);
      }
    };
  } };
  const results = await Promise.allSettled([registerMapEnvironmentProfile(pool as any, 7, 2), registerMapEnvironmentProfile(pool as any, 8, 2)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(inserts, 1); assert.equal(commits, 1); assert.equal(rollbacks, 1); assert.equal(profiles.size, 1);
  const rejection = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.match(String(rejection.reason), /范围重叠/);
});

test('registration deadlocks roll back and release the outer wrapper without swallowing the error', async () => {
  const events: string[] = [], deadlock = Object.assign(new Error('fixture registration deadlock'), { code: 'ER_LOCK_DEADLOCK' });
  const connection = { beginTransaction: async () => { events.push('begin'); }, commit: async () => { events.push('commit'); },
    rollback: async () => { events.push('rollback'); }, release: () => { events.push('release'); },
    execute: async (sql: string) => { assert.match(sql, /SELECT id FROM map_regions ORDER BY id LIMIT 1 FOR UPDATE/); throw deadlock; } };
  await assert.rejects(registerMapEnvironmentProfile({ getConnection: async () => connection } as any, 7, 2), error => error === deadlock);
  assert.deepEqual(events, ['begin', 'rollback', 'release']);
});

test('normal initialization explicitly freezes existing regions to v1 without updating registered v2', async () => {
  const queries: string[] = [], events: string[] = [];
  const pool = { query: async (sql: string, args?: any[]) => { queries.push(sql); if (sql.startsWith('INSERT IGNORE INTO map_environment_region_profiles')) assert.deepEqual(args, [environmentV2Seed]); return [{}]; },
    getConnection: async () => ({ beginTransaction: async () => { events.push('begin'); }, commit: async () => { events.push('commit'); }, rollback: async () => { throw new Error('unexpected rollback'); }, release: () => { events.push('release'); }, execute: async (sql: string) => { assert.match(sql, /SELECT code FROM game_data_migrations.*FOR UPDATE/); return [[{ code: 'map_environment_legacy_protection_v1' }]]; } }) };
  await initializeMapEnvironment(pool as any);
  assert.match(queries[0]!, /CREATE TABLE IF NOT EXISTS map_environment_region_profiles/);
  assert.match(queries[1]!, /INSERT IGNORE.*map_environment_region_profiles/);
  assert.match(queries[1]!, /SELECT id,1,\? FROM map_regions/);
  assert.ok(queries.every(sql => !/UPDATE map_environment_region_profiles/.test(sql)));
  assert.deepEqual(events, ['begin', 'commit', 'release']);
});

test('new closed region and v2 profile are created in one transaction, failures leave neither record', async () => {
  for (const fail of [false, true]) {
    let region = false, profile: any;
    const connection = { execute: async (sql: string, args: any[] = []) => {
      if (sql.startsWith('INSERT INTO map_regions')) { assert.equal(region, false); region = true; return [{ insertId: 7 }]; }
      if (sql.startsWith('INSERT INTO map_region_areas')) { assert.equal(region, true); return [{ affectedRows: 1 }]; }
      if (sql.startsWith('SELECT id FROM map_regions ORDER BY id')) return [[{ id: 1 }]];
      if (sql.startsWith('SELECT id,code,is_enabled')) return [region ? [{ id: 7, code: 'dark_forest_frontier', is_enabled: 0 }] : []];
      if (sql.startsWith('SELECT generation_version')) return [profile ? [profile] : []];
      if (sql.startsWith('SELECT r.id AS region_id')) return [[{ region_id: 7, min_x: 0, max_x: 10, min_y: 0, max_y: 10, min_z: 0, max_z: 0 }]];
      if (sql.startsWith("SELECT '角色'")) return [[]];
      if (sql.startsWith('INSERT INTO map_environment_region_profiles')) { profile = { generation_version: args[1], generation_seed: args[2] }; return [{ affectedRows: 1 }]; }
      throw new Error(`Unexpected new region SQL ${sql}`);
    } };
    const create = async () => {
      const snapshot = { region, profile: structuredClone(profile) };
      try {
        await connection.execute('INSERT INTO map_regions (...,is_enabled) VALUES (...,0)');
        await connection.execute('INSERT INTO map_region_areas (...) VALUES (...)');
        const result = await registerMapEnvironmentProfileIn(connection as any, 7, 2);
        if (fail) throw new Error('fixture create transaction failure');
        return result;
      } catch (error) { region = snapshot.region; profile = snapshot.profile; throw error; }
    };
    if (fail) { await assert.rejects(create(), /transaction failure/); assert.equal(region, false); assert.equal(profile, undefined); }
    else { await create(); assert.equal(region, true); assert.equal(profile.generation_version, 2); }
  }
});

const service = (transaction: (work: (db: any) => Promise<any>) => Promise<any>, importFixture?: (id: string) => any) => {
  const module = { exports: {} as Record<string, any> };
  const require = (id: string) => {
    if (id === 'node:crypto') return { randomUUID: () => 'v2-fixture-job' };
    if (id.includes('database/pool')) return { getPool: () => { throw new Error('offline fixture forbids real database'); }, withTransaction: transaction };
    if (id.includes('inventory-binding')) return { grantInventory: async (db: any, _character: number, _item: number, binding: any) => db.grant(binding.unbound) };
    if (id.includes('map-hidden-mentor.locations')) return { mapHiddenMentorLocations: [] };
    if (id.includes('map-environment.config')) return generation;
    throw new Error(`Unexpected service import ${id}`);
  };
  const code = transformSync(readFileSync(new URL('../src/game/map-environment.service.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code.replace(/\bimport\(/g, '__fixtureImport(');
  new Function('require', '__fixtureImport', 'module', 'exports', code)(require, async (id: string) => { if (!importFixture) throw new Error(`Unexpected fixture import ${id}`); return importFixture(id); }, module, module.exports);
  return module.exports;
};
const settlement = () => {
  const object = generate([area], whole).find(o => o.assetKey === 'living_oak')!;
  const character = { id: 10, current_region_id: 7, pos_x: object.x - 1, pos_y: object.y, pos_z: 0, activity_status: 'active', current_hp: 100, adventurer_registered: 1 };
  let state: any = { job: { character_id: 10, object_id: object.id, job_id: 'v2-fixture-job', region_id: 7, origin_x: character.pos_x, origin_y: character.pos_y, origin_z: 0, object_json: structuredClone(object), remaining_seconds: 0, finishes_at: new Date() }, cleared: false, rewards: null, grants: 0 };
  let tail: Promise<void> = Promise.resolve(), profileVersion = 2, failReceipt = false;
  const transaction = async (work: (db: any) => Promise<any>) => {
    let unlock: (() => void) | undefined, snapshot: any;
    const db = {
      grant: async (amount: number) => { state.grants += amount; },
      execute: async (sql: string, args: any[] = []) => {
        if (sql.includes('FROM characters c JOIN players')) {
          assert.match(sql, /FOR UPDATE/);
          const previous = tail; tail = new Promise<void>(resolve => { unlock = resolve; }); await previous; snapshot = structuredClone(state);
          return [[character]];
        }
        assert.ok(snapshot, 'character lock must precede all settlement reads/writes');
        if (sql.includes('FROM player_environment_jobs j WHERE j.character_id')) { assert.match(sql, /FOR UPDATE/); return [state.job ? [state.job] : []]; }
        if (sql.includes('FROM map_regions r LEFT JOIN map_region_areas')) return [[{ region_id: 7, code: area.code, danger_level: area.danger, is_enabled: 1, min_x: area.minX, max_x: area.maxX, min_y: area.minY, max_y: area.maxY, min_z: 0, max_z: 0, generation_version: profileVersion, generation_seed: environmentV2Seed }]];
        if (sql.includes('FROM map_environment_region_profiles')) { assert.match(sql, /FOR UPDATE/); return [[{ generation_version: profileVersion, generation_seed: environmentV2Seed }]]; }
        if (sql.includes('FROM map_npcs WHERE pos_x') || sql.startsWith("SELECT '移动'")) return [[]];
        if (sql.startsWith('INSERT IGNORE INTO map_environment_states')) { const existed = state.cleared; state.cleared = true; return [{ affectedRows: existed ? 0 : 1 }]; }
        if (sql.startsWith('SELECT id,code,name FROM item_definitions')) { assert.equal(args[0], 'home_wood'); return [[{ id: 3, code: 'home_wood', name: '木材' }]]; }
        if (sql.startsWith('INSERT IGNORE INTO player_item_codex')) return [{ affectedRows: 1 }];
        if (sql.startsWith('INSERT INTO map_environment_rewards')) { if (failReceipt) throw new Error('fixture receipt failure'); assert.equal(state.rewards, null); state.rewards = JSON.parse(args[3]); return [{ affectedRows: 1 }]; }
        if (sql.startsWith('DELETE FROM player_environment_jobs')) { state.job = null; return [{ affectedRows: 1 }]; }
        if (sql.startsWith('SELECT rewards_json')) return [state.rewards ? [{ rewards_json: state.rewards }] : []];
        throw new Error(`Unexpected settlement SQL ${sql}`);
      }
    };
    try { return await work(db); } catch (error) { if (snapshot) state = snapshot; throw error; } finally { unlock?.(); }
  };
  return { object, transaction, state: () => state, profile: (version: number) => { profileVersion = version; }, fail: (value: boolean) => { failReceipt = value; } };
};
test('two concurrent public v2 settlement callers serialize and grant exactly once, restart replays receipt', async () => {
  const fixture = settlement(), api = service(fixture.transaction);
  const results = await Promise.all([api.environmentFinishClear('fixture-user', fixture.object.id), api.environmentFinishClear('fixture-user', fixture.object.id)]);
  assert.equal(results.filter(r => !r.alreadySettled).length, 1);
  assert.equal(fixture.state().grants, environmentDrops(fixture.object)[0]!.quantity);
  assert.equal(fixture.state().job, null);
  assert.equal((await service(fixture.transaction).environmentFinishClear('fixture-user', fixture.object.id)).alreadySettled, true);
});
test('v2 failed receipt rolls back state, inventory and job together, retry grants once', async () => {
  const fixture = settlement(), api = service(fixture.transaction); fixture.fail(true);
  await assert.rejects(api.environmentFinishClear('fixture-user', fixture.object.id), /receipt failure/);
  assert.equal(fixture.state().grants, 0); assert.equal(fixture.state().cleared, false); assert.ok(fixture.state().job);
  fixture.fail(false); await api.environmentFinishClear('fixture-user', fixture.object.id);
  assert.equal(fixture.state().grants, environmentDrops(fixture.object)[0]!.quantity);
});
test('v2 settlement regenerates from persisted profile and ID, rejecting mismatches and ignoring forged drop snapshots', async () => {
  const changedProfile = settlement(); changedProfile.profile(1);
  await assert.rejects(service(changedProfile.transaction).environmentFinishClear('fixture-user', changedProfile.object.id), /生成版本不符/);
  assert.equal(changedProfile.state().grants, 0); assert.equal(changedProfile.state().cleared, false);
  const forgedGeometry = settlement(); forgedGeometry.state().job.object_json.width = 1;
  await assert.rejects(service(forgedGeometry.transaction).environmentFinishClear('fixture-user', forgedGeometry.object.id), /目标已失效/);
  assert.equal(forgedGeometry.state().grants, 0);
  const forgedDrop = settlement(); forgedDrop.state().job.object_json.dropCode = 'unlimited_gold';
  await service(forgedDrop.transaction).environmentFinishClear('fixture-user', forgedDrop.object.id);
  assert.deepEqual(forgedDrop.state().rewards.map((r: any) => r.code), ['home_wood']);
});

test('v2 start, read-only collision and cancellation share the authoritative whole-cell object', async () => {
  const object = generate([area], whole).find(o => o.assetKey === 'living_birch')!;
  let job: any, grants = 0, writes = 0;
  const character = { id: 10, current_region_id: 7, pos_x: object.x - 1, pos_y: object.y, pos_z: 0, activity_status: 'active', current_hp: 100, adventurer_registered: 1 };
  const db = { execute: async (sql: string, args: any[] = []) => {
    if (sql.includes('FROM characters c JOIN players')) return [[character]];
    if (sql.includes('FROM player_environment_jobs j WHERE j.character_id')) return [job ? [job] : []];
    if (sql.includes('FROM party_members own')) return [[]];
    if (sql.includes('FROM map_regions r LEFT JOIN map_region_areas')) return [[{ region_id: 7, code: area.code, danger_level: 2, is_enabled: 1, min_x: -120, max_x: 119, min_y: -120, max_y: 119, min_z: 0, max_z: 0, generation_version: 2, generation_seed: environmentV2Seed }]];
    if (sql.includes('FROM map_npcs WHERE pos_x') || sql.startsWith('SELECT object_id,state,revision FROM map_environment_states')) return [[]];
    if (sql.includes('FROM player_environment_jobs j WHERE j.object_id')) return [job ? [job] : []];
    if (sql.startsWith('INSERT INTO player_environment_jobs')) { writes++; job = { character_id: 10, object_id: args[1], job_id: args[2], region_id: 7, object_json: args[7], finishes_at: new Date(), remaining_seconds: args[8] }; return [{ affectedRows: 1 }]; }
    if (sql.startsWith('DELETE FROM player_environment_jobs')) { writes++; job = undefined; return [{ affectedRows: 1 }]; }
    throw new Error(`Unexpected v2 start SQL ${sql}`);
  }, grant: async () => { grants++; } };
  const api = service(async work => work(db), id => {
    if (id.includes('lamplight.service')) return { assertLamplightIdle: async () => {} };
    if (id.includes('talent-data')) return { readTalentData: async () => ({ jobs: [] }) };
    if (id.includes('adventure.service')) return { ensureForestGuideFreeAction: async () => {}, localExplorationMap: async () => ({ environment: [{ ...object, canClear: true }] }) };
    throw new Error(`Unexpected fixture dependency ${id}`);
  });
  for (const cell of occupied(object)) assert.equal((await api.environmentBlockerAt(db, { ...cell, regionId: 7 }))?.id, object.id);
  assert.equal(writes, 0, 'GET collision lookup must not register or suppress anything');
  assert.equal((await api.environmentStartClear('fixture-user', object.id)).kind, 'clearing');
  assert.equal((await api.environmentStartClear('fixture-user', object.id)).kind, 'clearing');
  assert.equal(writes, 1, 'retry retains the existing job');
  assert.equal((await api.environmentCancelClear('fixture-user')).kind, 'cancelled');
  assert.equal(grants, 0);
  assert.equal((await api.environmentBlockerAt(db, { ...occupied(object)[0], regionId: 7 }))?.id, object.id);
});
