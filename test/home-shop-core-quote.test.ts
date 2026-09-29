import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { consumeBinding, productionBinding, type Binding } from '../src/game/inventory-binding';

test('百纳居 Core reuses the site gate and previews coin purchases and material exchanges without mutation', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/game/home.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  let atShop = false;
  let active = true;
  let traveling = false;
  let mining = false;
  let teammateCombat = false;
  let leaderCombat = false;
  let copper = 100;
  let material: Binding = { unbound: 1, trade: 1, personal: 1 };
  let gained = 0;
  const gainedBinding: Binding = { unbound: 0, trade: 0, personal: 0 };
  let operations = 0;
  const connection = {
    execute: async (sql: string, args: unknown[] = []) => {
      if (sql.includes('FROM characters c JOIN players p')) return [[{ id: 7, player_id: 2, name: '冒险者', copper_coins: copper,
        current_region_id: 1, region_code: 'baina_town', pos_x: 7, pos_y: -166, pos_z: 0,
        activity_status: active ? 'active' : 'resting' }]];
      if (sql.includes('SELECT 1 FROM map_npcs WHERE code=')) return [atShop ? [{ '1': 1 }] : []];
      if (sql.includes('FROM player_travels')) return [traveling ? [{ '1': 1 }] : []];
      if (sql.includes('FROM player_resource_mining')) return [mining ? [{ '1': 1 }] : []];
      if (sql.includes('FROM combat_sessions')) {
        assert.match(sql, /LEFT JOIN combat_members cm ON cm\.session_id=cs\.id/);
        assert.match(sql, /cs\.state='active'/);
        assert.deepEqual(args, [7, 7]);
        return [teammateCombat || leaderCombat ? [{ '1': 1 }] : []];
      }
      if (sql.includes('FROM player_pvp_battle_sessions')) return [[]];
      if (sql.includes('FROM home_shop_offers o') && sql.includes('FOR UPDATE')) {
        const exchange = Number(args[0]) !== 1;
        const grouped = Number(args[0]) === 3;
        return [[{ id: Number(args[0]), offer_code: exchange ? 'exchange_living_wood' : 'buy_wood', output_item_id: 8,
          output_quantity: grouped ? 3 : exchange ? 10 : 1, input_item_id: exchange ? 9 : null, input_quantity: grouped ? 2 : exchange ? 1 : 0,
          copper_price: exchange ? 0 : 5, output_name: '木材' }]];
      }
      if (sql.startsWith('SELECT quantity,trade_bound_quantity,personal_bound_quantity FROM player_inventory')) return [[{
        quantity: material.unbound + material.trade + material.personal,
        trade_bound_quantity: material.trade, personal_bound_quantity: material.personal }]];
      if (sql.startsWith('UPDATE characters SET copper_coins=')) { copper -= Number(args[0]); return [{ affectedRows: 1 }]; }
      if (sql.startsWith('INSERT IGNORE INTO player_item_codex')) return [{ affectedRows: 1 }];
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: () => 'uuid' },
    './achievement-events': { recordAchievement: () => undefined },
    './talent-production': { talentMaterialPayment: async () => 0, consumeTalentMaterial: async () => undefined },
    './inventory-binding': {
      consumeBinding,
      productionBinding,
      consumeInventory: async (_connection: unknown, _owner: number, _item: number, amount: number) => {
        const used = consumeBinding(material, amount);
        material = { unbound: material.unbound - used.unbound, trade: material.trade - used.trade,
          personal: material.personal - used.personal };
        return used;
      },
      grantInventory: async (_connection: unknown, _owner: number, _item: number, binding: Binding) => {
        for (const kind of ['unbound', 'trade', 'personal'] as const) gainedBinding[kind] += binding[kind];
        gained += binding.unbound + binding.trade + binding.personal;
      }
    },
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

  await assert.rejects(home.tradeHomeOfferInTransaction(connection, 'player', 1, 2, true), /百纳居/);
  atShop = true;
  active = false;
  await assert.rejects(home.requireHomeShopTarget(connection, 'player', 'baina_residence'), /当前状态/);
  active = true;
  traveling = true;
  await assert.rejects(home.listHomeShop('player'), /旅行途中/);
  traveling = false;
  mining = true;
  await assert.rejects(home.homeShopOfferDetail('player', 2), /开采尚未结束/);
  mining = false;
  teammateCombat = true;
  await assert.rejects(home.listHomeShop('player'), /战斗中/);
  await assert.rejects(home.tradeHomeOfferInTransaction(connection, 'player', 2, 2, true), /战斗中/);
  await assert.rejects(home.tradeHomeOfferInTransaction(connection, 'player', 2, 2), /战斗中/);
  teammateCombat = false;
  leaderCombat = true;
  await assert.rejects(home.tradeHomeOfferInTransaction(connection, 'player', 1, 2, true), /战斗中/);
  leaderCombat = false;
  assert.deepEqual([copper, material, gained, operations], [100, { unbound: 1, trade: 1, personal: 1 }, 0, 0]);
  const buy = await home.tradeHomeOfferInTransaction(connection, 'player', 1, 2, true);
  assert.deepEqual([buy.quantity, buy.price, buy.copperAfter], [2, 10, 90]);
  const exchange = await home.tradeHomeOfferInTransaction(connection, 'player', 2, 2, true);
  assert.deepEqual([exchange.quantity, exchange.inputQuantity, exchange.inputOwnedAfter], [20, 2, 1]);
  assert.deepEqual(exchange.inputBindingUsed, { personal: 1, trade: 1, unbound: 0 });
  assert.deepEqual(exchange.outputBinding, { unbound: 0, trade: 10, personal: 10 });
  assert.deepEqual([copper, material, gained, operations], [100, { unbound: 1, trade: 1, personal: 1 }, 0, 0]);
  await home.tradeHomeOfferInTransaction(connection, 'player', 1, 2);
  await home.tradeHomeOfferInTransaction(connection, 'player', 2, 2);
  assert.deepEqual([copper, material, gained, operations], [90, { unbound: 1, trade: 0, personal: 0 }, 22, 2]);
  assert.deepEqual(gainedBinding, { unbound: 2, trade: 10, personal: 10 });
  await assert.rejects(home.tradeHomeOfferInTransaction(connection, 'player', 2, 2, true), /兑换材料不足/);
  material.personal = 1;
  const mixed = await home.tradeHomeOfferInTransaction(connection, 'player', 2, 2, true);
  assert.deepEqual(mixed.outputBinding, { unbound: 10, trade: 0, personal: 10 });
  assert.deepEqual([material, gained], [{ unbound: 1, trade: 0, personal: 1 }, 22]);
  await home.tradeHomeOfferInTransaction(connection, 'player', 2, 2);
  assert.deepEqual([material, gained, operations], [{ unbound: 0, trade: 0, personal: 0 }, 42, 3]);
  assert.deepEqual(gainedBinding, { unbound: 12, trade: 10, personal: 20 });
  material = { unbound: 1, trade: 0, personal: 1 };
  const grouped = await home.tradeHomeOfferInTransaction(connection, 'player', 3, 1, true);
  assert.deepEqual([grouped.quantity, grouped.inputQuantity, grouped.outputBinding],
    [3, 2, { unbound: 0, trade: 0, personal: 3 }]);
  await home.tradeHomeOfferInTransaction(connection, 'player', 3, 1);
  assert.deepEqual([material, gained, operations], [{ unbound: 0, trade: 0, personal: 0 }, 45, 4]);
  assert.deepEqual(gainedBinding, { unbound: 12, trade: 10, personal: 23 });
});
