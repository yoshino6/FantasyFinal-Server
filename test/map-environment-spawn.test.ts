import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { environmentObjectCells } from '../src/game/map-environment.config';

const pickerFixture = (objects: any[]) => {
  let queries = 0;
  const module = { exports: {} as Record<string, any> };
  const source = readFileSync(new URL('../src/game/map-environment-spawn.ts', import.meta.url), 'utf8');
  const require = (id: string) => {
    if (id.includes('map-environment.service')) return { environmentForCells: async (_db: unknown, cells: any[]) => {
      queries++;
      assert.ok(cells.every(cell => cell.regionId === 7));
      assert.equal(cells.length, 16);
      return objects;
    } };
    if (id.includes('map-environment.config')) return { environmentObjectCells };
    throw new Error(`Unexpected import: ${id}`);
  };
  new Function('require', 'module', 'exports', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(require, module, module.exports);
  return { create: module.exports.createEnvironmentSpawnPicker, queries: () => queries };
};

test('spawn candidates skip every occupied whole cell but allow scenery and reuse a batch', async () => {
  const fixture = pickerFixture([
    { x: 0, y: 0, z: 0, regionId: 7, blocking: true, footprint: [{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: 2, dy: 0 }] },
    { x: 3, y: 0, z: 0, regionId: 7, blocking: false, footprint: [{ dx: 0, dy: 0 }] }
  ]);
  let x = 0;
  const pick = fixture.create({}, 7, () => ({ x: x++, y: 0, z: 0 }));
  assert.deepEqual(await pick((point: any) => point.x === 4), { x: 3, y: 0, z: 0 });
  assert.deepEqual(await pick((point: any) => point.x === 4), { x: 5, y: 0, z: 0 });
  assert.equal(fixture.queries(), 1, 'two spawns share the same environment lookup');
});

test('exhausted or forbidden regions stop after bounded retries without writing or suppressing objects', async () => {
  const fixture = pickerFixture([]);
  let generated = 0;
  const pick = fixture.create({}, 7, () => ({ x: generated++, y: 0, z: 0 }));
  assert.equal(await pick(() => true), null);
  assert.equal(generated, 64);
  assert.equal(fixture.queries(), 4);
  assert.deepEqual(await pick(() => false), { x: 64, y: 0, z: 0 });
});

test('surface obstacles never block candidate points on a different layer', async () => {
  const fixture = pickerFixture([{ x: 0, y: 0, z: 0, regionId: 7, blocking: true, footprint: [{ dx: 0, dy: 0 }] }]);
  const pick = fixture.create({}, 7, () => ({ x: 0, y: 0, z: -10 }));
  assert.deepEqual(await pick(() => false), { x: 0, y: 0, z: -10 });
});
