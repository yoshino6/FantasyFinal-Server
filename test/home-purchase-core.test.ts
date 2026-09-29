import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('Core home preview is read only while purchase keeps location, activity and payment in one transaction', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/game/home.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  let atShop = true;
  let owned = false;
  let copper = 600;
  let traveling = false;
  let stalePvpCleanup = 0;
  let operations = 0;
  let achievements = 0;
  const connection = {
    execute: async (sql: string, args: unknown[] = []) => {
      if (sql.includes('FROM characters c JOIN players p')) return [[{ id: 7, player_id: 2, name: '冒险者', copper_coins: copper,
        current_region_id: 1, region_code: 'baina_town', pos_x: 7, pos_y: -166, pos_z: 0, activity_status: 'idle' }]];
      if (sql.includes('SELECT 1 FROM map_npcs WHERE code=')) return [atShop ? [{ '1': 1 }] : []];
      if (sql.includes('FROM player_homes WHERE character_id=')) return [owned ? [{ id: 11 }] : []];
      if (sql.startsWith('UPDATE player_pvp_battle_')) { stalePvpCleanup++; return [{ affectedRows: 0 }]; }
      if (sql.startsWith('SELECT 1 FROM player_travels')) return [traveling ? [{ '1': 1 }] : []];
      if (sql.startsWith('SELECT 1 FROM player_resource_mining')
        || sql.startsWith('SELECT 1 FROM combat_sessions') || sql.startsWith('SELECT 1 FROM player_pvp_battle_sessions')
        || sql.startsWith('SELECT 1 FROM party_members')) return [[]];
      if (sql.startsWith('SELECT 1 AS blocked FROM DUAL')) return [[]];
      if (sql.startsWith('UPDATE characters SET copper_coins=')) { copper -= Number(args[0]); return [{ affectedRows: 1 }]; }
      if (sql.startsWith('INSERT INTO player_homes')) { owned = true; return [{ insertId: 11, affectedRows: 1 }]; }
      if (sql.startsWith('INSERT INTO player_events')) return [{ insertId: 12, affectedRows: 1 }];
      if (sql.includes('FROM map_npcs n JOIN map_regions r')) return [[{ region_id: 1, region_code: 'baina_town', region_name: '百纳镇',
        code: 'baina_residence', name: '百纳居', pos_x: 7, pos_y: -166, pos_z: 0 }]];
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: () => 'uuid' },
    './achievement-events': { recordAchievement: () => { achievements++; } },
    './talent-production': { talentMaterialPayment: async () => 0, consumeTalentMaterial: async () => undefined },
    './inventory-binding': { consumeInventory: async () => undefined },
    './character-operation.service': { recordCharacterOperation: async () => { operations++; } },
    '../database/pool': { getPool: async () => connection, withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work(connection) },
    './home.constants': { BAINA_GUILD_POSITION: { x: -2, y: -161, z: 0 }, BAINA_RESIDENCE_CODE: 'baina_residence',
      homeCosts: { purchase: { copper: 500 } }, homePlotDistance: { min: 12, max: 22 }, slotsPerFloor: () => 6 },
    './home-layout.service': { backfillHomeFloorLayout: async () => undefined, findFurniturePlacement: async () => ({}),
      furnitureDimensions: () => ({}), occupyFurnitureCells: async () => undefined, roomForHouseLevel: () => ({}) }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const home = loaded.exports;

  const site = await home.homePurchaseSite('player');
  assert.deepEqual([site.target.id, site.target.x, site.target.y, site.atSite], ['baina_residence', 7, -166, true]);
  const quote = await home.previewHomePurchaseInTransaction(connection, 'player');
  assert.deepEqual([quote.price, quote.copperAfter, quote.plotAssignedOnConfirm], [500, 100, true]);
  assert.deepEqual([copper, owned, stalePvpCleanup, operations, achievements], [600, false, 0, 0, 0]);
  traveling = true;
  await assert.rejects(home.previewHomePurchaseInTransaction(connection, 'player'), /移动或寻怪/);
  traveling = false;
  atShop = false;
  await assert.rejects(home.previewHomePurchaseInTransaction(connection, 'player'), /百纳居/);
  atShop = true;
  const result = await home.purchaseHomeInTransaction(connection, 'player');
  assert.deepEqual([result.copper, result.homeId, result.name], [500, 11, '冒险者的小屋']);
  assert.deepEqual([copper, owned, stalePvpCleanup, operations, achievements], [100, true, 2, 1, 1]);
  await assert.rejects(home.purchaseHomeInTransaction(connection, 'player'), /已经拥有/);
});

test('two residents may buy distinct home instances on one public plot', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/game/home.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const residents = new Map([['resident-a', { id: 7, copper: 500, homeId: 0 }], ['resident-b', { id: 8, copper: 500, homeId: 0 }]]);
  let nextHomeId = 10;
  const connection = {
    execute: async (sql: string, args: unknown[] = []) => {
      if (sql.includes('FROM characters c JOIN players p')) {
        const resident = residents.get(String(args[0]))!;
        return [[{ id: resident.id, player_id: resident.id, name: String(args[0]), copper_coins: resident.copper,
          current_region_id: 1, region_code: 'baina_town', pos_x: 7, pos_y: -166, pos_z: 0, activity_status: 'active' }]];
      }
      if (sql.includes('SELECT 1 FROM map_npcs WHERE code=')) return [[{ '1': 1 }]];
      if (sql.includes('FROM player_homes WHERE character_id=')) {
        const resident = [...residents.values()].find(item => item.id === Number(args[0]))!;
        return [resident.homeId ? [{ id: resident.homeId }] : []];
      }
      if (sql.startsWith('UPDATE player_pvp_battle_')) return [{ affectedRows: 0 }];
      if (sql.startsWith('SELECT 1 FROM player_travels') || sql.startsWith('SELECT 1 FROM player_resource_mining')
        || sql.startsWith('SELECT 1 FROM combat_sessions') || sql.startsWith('SELECT 1 FROM player_pvp_battle_sessions')
        || sql.startsWith('SELECT 1 FROM party_members') || sql.startsWith('SELECT 1 AS blocked FROM DUAL')) return [[]];
      if (sql.startsWith('UPDATE characters SET copper_coins=')) {
        const resident = [...residents.values()].find(item => item.id === Number(args[1]))!;
        resident.copper -= Number(args[0]); return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('INSERT INTO player_homes')) {
        const resident = [...residents.values()].find(item => item.id === Number(args[0]))!;
        resident.homeId = ++nextHomeId; return [{ insertId: resident.homeId, affectedRows: 1 }];
      }
      if (sql.startsWith('INSERT INTO player_events')) return [{ insertId: 1, affectedRows: 1 }];
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: () => 'uuid' }, './achievement-events': { recordAchievement: () => undefined },
    './talent-production': { talentMaterialPayment: async () => 0, consumeTalentMaterial: async () => undefined },
    './inventory-binding': { consumeInventory: async () => undefined },
    './character-operation.service': { recordCharacterOperation: async () => undefined },
    '../database/pool': { getPool: async () => connection, withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work(connection) },
    './home.constants': { BAINA_GUILD_POSITION: { x: -2, y: -161, z: 0 }, BAINA_RESIDENCE_CODE: 'baina_residence',
      homeCosts: { purchase: { copper: 500 } }, homePlotDistance: { min: 12, max: 22 }, slotsPerFloor: () => 6 },
    './home-layout.service': { backfillHomeFloorLayout: async () => undefined, findFurniturePlacement: async () => ({}),
      furnitureDimensions: () => ({}), occupyFurnitureCells: async () => undefined, roomForHouseLevel: () => ({}) }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const originalRandom = Math.random;
  Math.random = () => .5;
  try {
    const [first, second] = await Promise.all([
      loaded.exports.purchaseHomeInTransaction(connection, 'resident-a'),
      loaded.exports.purchaseHomeInTransaction(connection, 'resident-b')
    ]);
    assert.deepEqual(first.plot, second.plot);
    assert.notEqual(first.homeId, second.homeId);
    assert.deepEqual([...residents.values()].map(item => item.copper), [0, 0]);
  } finally { Math.random = originalRandom; }
});
