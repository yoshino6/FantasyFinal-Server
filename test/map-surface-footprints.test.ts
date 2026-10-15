import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { recordSurfaceWalkIn, surfaceMarksFromRows, surfaceWalkTtlMs, type SurfaceMarkRow } from '../src/game/map-surface-marks.service';

const cell = (x: number) => ({ x, y: 0, z: 0, regionId: 1, regionCode: 'worldtree_meadow', passable: true });
const row = (overrides: Partial<SurfaceMarkRow> = {}): SurfaceMarkRow => ({ event_key: 'opaque', scope_key: 'world:0', region_id: 1,
  pos_x: 0, pos_y: 0, pos_z: 0, end_x: 1, end_y: 0, kind: 'walk', effect_seed: 1, intensity: .08,
  occurred_at_ms: 1000, expires_at_ms: 901000, ...overrides } as SurfaceMarkRow);

test('legacy remaining time is clamped to ten minutes and fresh public footprints are fully opaque', () => {
  const fresh = surfaceMarksFromRows([row()], [cell(0), cell(1)], 'world:0', 1000).recentWalks[0];
  assert.equal(fresh.initialOpacity, 1); assert.equal(fresh.remainingMs, 600000);
  const middle = surfaceMarksFromRows([row()], [cell(0), cell(1)], 'world:0', 301000).recentWalks[0];
  assert.equal(middle.ageMs, 300000); assert.equal(middle.remainingMs, 300000);
  assert.equal(surfaceMarksFromRows([row()], [cell(0), cell(1)], 'world:0', 601000).recentWalks.length, 0);
  assert.equal(surfaceMarksFromRows([row()], [cell(0), cell(1)], 'world:0', 901000).recentWalks.length, 0);
});

test('shared anonymous paths are filtered per viewer cells, world, floor and private scope', () => {
  const rows = [row({ event_key: 'opaque-a' }), row({ event_key: 'opaque-b', pos_x: 3, end_x: 4 })];
  const read = (visible: ReturnType<typeof cell>[], scope = 'world:0') => surfaceMarksFromRows(rows, visible, scope, 2000).recentWalks;
  assert.deepEqual(read([cell(0), cell(1)]).map(walk => walk.id), ['opaque-a']);
  assert.deepEqual(read([cell(3), cell(4)]).map(walk => walk.id), ['opaque-b']);
  assert.equal(read([cell(0), cell(1), cell(3), cell(4)]).length, 2, 'shared world keeps both authorised players paths');
  assert.equal(read([cell(0)]).length, 0, 'hidden endpoint cannot be reconstructed');
  assert.equal(read([cell(0), cell(1)], 'private:1').length, 0);
  assert.equal(read([cell(0), cell(1)].map(value => ({ ...value, z: 1 }))).length, 0);
  assert.equal(read([cell(0), cell(1)].map(value => ({ ...value, regionCode: 'private_home' }))).length, 0);
  assert.ok(!/character|player|qq|user|owner/.test(JSON.stringify(read([cell(0), cell(1)]))));
});

test('normal movement writes retain the same batch and cleanup cadence with distinct opaque event identities', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const db = { execute: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    return [sql.startsWith('SELECT') ? [{ code: 'worldtree_meadow', is_owner_only: 0, is_enabled: 1 }] : {}];
  } } as unknown as PoolConnection;
  const occurredAtMs = Date.now();
  for (const eventKey of ['actor-a:move', 'actor-b:move']) await recordSurfaceWalkIn(db, [cell(0), cell(1)], { eventKey, occurredAtMs });
  const inserts = calls.filter(call => call.sql.includes('INSERT INTO map_surface_marks'));
  assert.equal(inserts.length, 2); assert.notEqual(inserts[0].values[0], inserts[1].values[0]);
  for (const insert of inserts) {
    assert.match(String(insert.values[0]), /^[a-f0-9]{64}$/);
    assert.equal(insert.values[10], 1);
    assert.equal(Number(insert.values[12]) - Number(insert.values[11]), surfaceWalkTtlMs);
  }
  assert.equal(calls.filter(call => call.sql.startsWith('DELETE')).length, 2, 'one existing cleanup per write batch');
});
