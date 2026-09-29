import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('bookshop Core gates shelf and trades by the current cell and previews without mutation', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/game/bookshop.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  let atShop = false;
  let active = true;
  let traveling = false;
  let teammateCombat = false;
  let leaderCombat = false;
  let copper = 100;
  let stock = 4;
  let owned = 3;
  let granted = 0;
  let stolenSales = 0;
  let operations = 0;
  const connection = {
    execute: async (sql: string, args: unknown[] = []) => {
      if (sql.includes('FROM characters c JOIN players p')) return [[{
        id: 7, copper_coins: copper, activity_status: active ? 'active' : 'resting', current_region_id: 1, pos_x: 14, pos_y: -176, pos_z: 0
      }]];
      if (sql.includes('SELECT 1 FROM map_npcs')) return [atShop ? [{ '1': 1 }] : []];
      if (sql.includes('FROM player_travels')) return [traveling ? [{ '1': 1 }] : []];
      if (sql.includes('FROM combat_sessions')) {
        assert.match(sql, /LEFT JOIN combat_members cm ON cm\.session_id=cs\.id/);
        assert.match(sql, /cs\.state='active'/);
        assert.deepEqual(args, [7, 7]);
        return [teammateCombat || leaderCombat ? [{ '1': 1 }] : []];
      }
      if (sql.includes('FROM player_pvp_battle_sessions')) return [[]];
      if (sql.startsWith('SELECT COUNT(*) AS total FROM bookshop_items')) return [[{ total: 1 }]];
      if (sql.includes('FROM bookshop_items bs JOIN item_definitions i') && sql.includes('LEFT JOIN player_inventory')) return [[{
        id: 3, codex_id: 'book3', name: '古书', item_category: '书籍', description: '描述', buy_price: 20,
        stock_quantity: stock, owned_quantity: owned
      }]];
      if (sql.includes('FROM bookshop_items bs JOIN item_definitions i') && sql.includes('FOR UPDATE')) return [[{
        name: '古书', code: 'book3', item_category: '书籍', is_tradeable: 1, skill_code: null,
        buy_price: 20, stock_quantity: stock
      }]];
      if (sql.includes('FROM player_inventory pi JOIN item_definitions i') && sql.includes('FOR UPDATE')) return [[{
        name: '古书', item_category: '书籍', is_tradeable: 1, trade_price: 10, quantity: owned, price: 12
      }]];
      if (sql.startsWith('UPDATE characters SET copper_coins=copper_coins-')) {
        copper -= Number(args[0]); return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE bookshop_items SET stock_quantity=')) {
        stock -= Number(args[0]); return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE player_inventory SET quantity=')) {
        owned -= Number(args[0]); return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE characters SET copper_coins=copper_coins+')) {
        copper += Number(args[0]); return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('DELETE FROM player_inventory') || sql.startsWith('INSERT IGNORE INTO player_item_codex')) return [{ affectedRows: 1 }];
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const modules: Record<string, unknown> = {
    './achievement-state': { achievementBookSource: async () => undefined },
    'node:crypto': { randomUUID: () => 'uuid' },
    './character-operation.service': { recordCharacterOperation: async () => { operations++; } },
    './achievement-events': { recordAchievement: () => undefined },
    './inventory-binding': {
      grantInventory: async () => { granted++; },
      consumeInventory: async (_connection: unknown, _owner: number, _item: number, amount: number) => { owned -= amount; }
    },
    '../database/pool': { getPool: async () => connection, withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work(connection) },
    './pvp.service': { recordPvpLootSale: async () => { stolenSales++; } }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const shop = loaded.exports;

  await assert.rejects(shop.bookshopCatalog('player'), /离开该目标坐标/);
  await assert.rejects(shop.bookshopSellCatalog('player'), /离开该目标坐标/);
  await assert.rejects(shop.buyBookshopItemInTransaction(connection, 'player', 3, 1, true), /离开该目标坐标/);
  await assert.rejects(shop.sellBookshopItemInTransaction(connection, 'player', 3, 1, true), /离开该目标坐标/);
  atShop = true;
  active = false;
  await assert.rejects(shop.bookshopCatalog('player'), /当前状态/);
  active = true;
  traveling = true;
  await assert.rejects(shop.buyBookshopItemInTransaction(connection, 'player', 3, 1, true), /旅行途中/);
  traveling = false;
  teammateCombat = true;
  await assert.rejects(shop.bookshopSellCatalog('player'), /战斗中/);
  await assert.rejects(shop.buyBookshopItemInTransaction(connection, 'player', 3, 1, true), /战斗中/);
  await assert.rejects(shop.sellBookshopItemInTransaction(connection, 'player', 3, 1), /战斗中/);
  teammateCombat = false;
  leaderCombat = true;
  await assert.rejects(shop.buyBookshopItemInTransaction(connection, 'player', 3, 1, true), /战斗中/);
  leaderCombat = false;
  assert.deepEqual([copper, stock, owned, granted, stolenSales, operations], [100, 4, 3, 0, 0, 0]);
  assert.equal((await shop.bookshopCatalog('player')).items[0].name, '古书');
  assert.equal((await shop.bookshopItemDetail('player', 3)).item.price, 20);
  const buy = await shop.buyBookshopItemInTransaction(connection, 'player', 3, 2, true);
  assert.deepEqual([buy.price, buy.copperAfter, buy.stockAfter], [40, 60, 2]);
  const sell = await shop.sellBookshopItemInTransaction(connection, 'player', 3, 2, true);
  assert.deepEqual([sell.price, sell.copperAfter, sell.ownedAfter], [24, 124, 1]);
  assert.deepEqual([copper, stock, owned, granted, stolenSales, operations], [100, 4, 3, 0, 0, 0]);
  await shop.buyBookshopItemInTransaction(connection, 'player', 3, 2);
  await shop.sellBookshopItemInTransaction(connection, 'player', 3, 2);
  assert.deepEqual([copper, stock, owned, granted, stolenSales, operations], [84, 2, 1, 1, 1, 2]);
});
