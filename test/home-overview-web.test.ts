import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('world home overview reads only the owner home, floor layout and storage summary without settling or backfilling', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/game/home.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  let owned = false;
  const queries: string[] = [];
  const connection = {
    execute: async (sql: string, args: unknown[] = []) => {
      queries.push(sql);
      if (!sql.trimStart().startsWith('SELECT')) throw new Error(`Read-only overview attempted a write: ${sql}`);
      if (sql.includes('FROM characters c JOIN players p')) {
        assert.deepEqual(args, ['player']);
        return [[{ id: 7, name: '旅人', current_region_id: 2, region_code: 'baina_town', pos_x: 4, pos_y: 5, pos_z: 0 }]];
      }
      if (sql.includes('FROM player_homes WHERE character_id=')) return [owned ? [{
        id: 9, character_id: 7, home_name: '旅人的小屋', town_region_id: 2, plot_x: 4, plot_y: 5, plot_z: 0,
        house_level: 2, floor_count: 2, status: 'active'
      }] : []];
      if (sql.includes('FROM player_home_visits WHERE')) return [[{ 1: 1 }]];
      if (sql.includes('FROM player_home_furniture f JOIN home_furniture_definitions d') && sql.includes('ORDER BY f.floor_no')) return [[
        { id: 11, furniture_code: 'storage_chest', name: '储物箱', description: '存东西', effect_json: { storageCapacity: 30 }, floor_no: 1,
          grid_x: 2, grid_y: 3, rotation: 0, layout_version: 2, grid_width: 2, grid_height: 1, floor_slot_cost: 2, layer_order: 20 },
        { id: 12, furniture_code: 'wooden_bed', name: '木床', description: '休息', effect_json: { restRecoveryPct: 5 }, floor_no: 2,
          grid_x: null, grid_y: null, rotation: 90, layout_version: 1, grid_width: 2, grid_height: 1, floor_slot_cost: 2, layer_order: 20 }
      ]];
      if (sql.includes("i.code IN ('home_wood'")) return [[{ code: 'home_wood', name: '木材', quantity: 4 }]];
      if (sql.includes('FROM player_home_storage_items WHERE home_id=')) return [[{ kinds: 2, quantity: 6 }]];
      if (sql.includes('COUNT(*) AS count FROM player_home_storage_instances')) return [[{ count: 1 }]];
      if (sql.includes("'$.storageCapacity'")) return [[{ capacity: 30 }]];
      if (sql.includes('FROM (') && sql.includes('stored_weights')) return [[{ weight: 9.5 }]];
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: () => 'uuid' },
    './achievement-events': { recordAchievement: () => undefined },
    './talent-production': { talentMaterialPayment: () => undefined, consumeTalentMaterial: () => undefined },
    './inventory-binding': { consumeInventory: () => undefined },
    './character-operation.service': { recordCharacterOperation: () => undefined },
    '../database/pool': { getPool: async () => connection, withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work(connection) },
    './home.constants': { BAINA_GUILD_POSITION: { x: 0, y: 0, z: 0 }, BAINA_RESIDENCE_CODE: 'baina_residence', homeCosts: { purchase: { copper: 500 } }, homePlotDistance: { min: 1, max: 2 }, slotsPerFloor: () => 8 },
    './home-layout.service': { backfillHomeFloorLayout: () => { throw new Error('Should not backfill'); }, findFurniturePlacement: () => undefined,
      furnitureDimensions: (width: number, height: number, rotation: number) => rotation % 180 === 0 ? { width, height } : { width: height, height: width },
      occupyFurnitureCells: () => undefined, roomForHouseLevel: () => ({ columns: 16, rows: 13 }) }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const home = loaded.exports;

  const missing = await home.homeOverview('player');
  assert.equal(missing.owned, false);
  assert.equal(missing.purchase.siteCode, 'baina_residence');
  owned = true;
  const result = await home.homeOverview('player');
  assert.equal(result.home.name, '旅人的小屋');
  assert.equal(result.home.inHome, true);
  assert.equal(result.home.atPlot, true);
  assert.equal(result.home.floorCount, 2);
  assert.deepEqual([result.home.floors[0].slotsUsed, result.home.floors[0].furniture[0].gridX], [2, 2]);
  assert.equal(result.home.floors[1].layoutPending, true);
  assert.equal(result.home.floors[1].furniture[0].gridX, null);
  assert.deepEqual([result.home.floors[1].furniture[0].width, result.home.floors[1].furniture[0].height], [1, 2]);
  assert.deepEqual(result.home.storage, { available: true, capacityKg: 30, usedKg: 9.5, stackedKinds: 2, stackedQuantity: 6, instanceCount: 1 });
  assert.equal(queries.some(query => /UPDATE|INSERT|DELETE|FOR UPDATE/i.test(query)), false);
});
