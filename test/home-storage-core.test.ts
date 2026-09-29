import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { consumeBinding, type Binding } from '../src/game/inventory-binding';

const source = readFileSync(fileURLToPath(new URL('../src/game/home.service.ts', import.meta.url)), 'utf8');
const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
const copy = (binding: Binding): Binding => ({ ...binding });
const total = (binding: Binding) => binding.unbound + binding.trade + binding.personal;

const fixture = ({
  capacity = 10,
  storage = { unbound: 3, trade: 2, personal: 1 },
  inventory = { unbound: 2, trade: 1, personal: 1 },
  storageUpdateAffectedRows = 1,
  inherentlyPersonal = false,
  activityStatus = 'active',
  travel = false,
  mining = false,
  combat = false,
  pvp = false
}: {
  capacity?: number;
  storage?: Binding;
  inventory?: Binding;
  storageUpdateAffectedRows?: number;
  inherentlyPersonal?: boolean;
  activityStatus?: string;
  travel?: boolean;
  mining?: boolean;
  combat?: boolean;
  pvp?: boolean;
} = {}) => {
  const state = { storage: copy(storage), inventory: copy(inventory) };
  const updates: unknown[][] = [];
  const grants: Binding[] = [];
  const operations: unknown[] = [];
  let storageDeletes = 0;
  let storageInserts = 0;
  let inventoryConsumes = 0;
  const connection = {
    execute: async (sql: string, args: unknown[] = []) => {
      if (sql.includes('FROM characters c JOIN players p')) return [[{ id: 7, player_id: 2, name: '冒险者', activity_status: activityStatus }]];
      if (sql.includes("FROM player_homes WHERE character_id=? AND status='active'")) return [[{ id: 11, character_id: 7 }]];
      if (sql.includes('FROM player_travels')) return [travel ? [{ exists: 1 }] : []];
      if (sql.includes('FROM player_resource_mining')) return [mining ? [{ exists: 1 }] : []];
      if (sql.includes('FROM combat_sessions cs')) {
        assert.match(sql, /combat_members cm/);
        assert.deepEqual(args, [7, 7]);
        return [combat ? [{ exists: 1 }] : []];
      }
      if (sql.includes('FROM player_pvp_battle_sessions')) return [pvp ? [{ exists: 1 }] : []];
      if (sql.includes("JSON_EXTRACT(d.effect_json,'$.storageCapacity')")) return [[{ capacity }]];
      if (sql.includes('stored_weights')) return [[{ weight: total(state.storage) * 0.5 }]];
      if (sql.includes('FROM player_home_storage_items hs JOIN item_definitions i') && sql.includes('FOR UPDATE')) {
        return [total(state.storage) ? [{ item_id: 17, name: '魔晶', weight: 0.5, stackable: 1,
          quantity: total(state.storage), trade_bound_quantity: state.storage.trade,
          personal_bound_quantity: state.storage.personal, inherently_personal: Number(inherentlyPersonal) }] : []];
      }
      if (sql.includes('FROM player_inventory pi JOIN item_definitions i') && sql.includes('FOR UPDATE')) {
        return [total(state.inventory) ? [{ item_id: 17, name: '魔晶', weight: 0.5, personal_only: 0,
          quantity: total(state.inventory), trade_bound_quantity: state.inventory.trade,
          personal_bound_quantity: state.inventory.personal }] : []];
      }
      if (sql.startsWith('UPDATE player_home_storage_items SET')) {
        updates.push(args);
        if (!storageUpdateAffectedRows) return [{ affectedRows: 0 }];
        const [quantity, trade, personal, homeId, itemId, required, requiredTrade, requiredPersonal, requiredUnbound] = args.map(Number);
        assert.deepEqual([homeId, itemId], [11, 17]);
        assert.equal(quantity, required);
        assert.equal(trade, requiredTrade);
        assert.equal(personal, requiredPersonal);
        assert.ok(total(state.storage) >= required);
        assert.ok(state.storage.trade >= requiredTrade);
        assert.ok(state.storage.personal >= requiredPersonal);
        assert.ok(state.storage.unbound >= requiredUnbound);
        state.storage.unbound -= requiredUnbound;
        state.storage.trade -= requiredTrade;
        state.storage.personal -= requiredPersonal;
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('DELETE FROM player_home_storage_items')) {
        storageDeletes++;
        return [{ affectedRows: total(state.storage) === 0 ? 1 : 0 }];
      }
      if (sql.startsWith('INSERT INTO player_home_storage_items')) {
        storageInserts++;
        const [, , quantity, trade, personal] = args.map(Number);
        state.storage.personal += personal;
        state.storage.trade += trade;
        state.storage.unbound += quantity - trade - personal;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: () => 'uuid' },
    './achievement-events': { recordAchievement: () => undefined },
    './talent-production': { talentMaterialPayment: async () => 0, consumeTalentMaterial: async () => undefined },
    './inventory-binding': {
      consumeBinding,
      productionBinding: () => ({ unbound: 0, trade: 0, personal: 0 }),
      consumeInventory: async (_connection: unknown, _characterId: number, _itemId: number, quantity: number) => {
        inventoryConsumes++;
        const used = consumeBinding(state.inventory, quantity);
        state.inventory.unbound -= used.unbound;
        state.inventory.trade -= used.trade;
        state.inventory.personal -= used.personal;
        return used;
      },
      grantInventory: async (_connection: unknown, _characterId: number, _itemId: number, binding: Binding) => {
        grants.push(copy(binding));
        state.inventory.unbound += binding.unbound;
        state.inventory.trade += binding.trade;
        state.inventory.personal += binding.personal;
      }
    },
    './character-operation.service': { recordCharacterOperation: async (_connection: unknown, event: unknown) => { operations.push(event); } },
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
  return { home: loaded.exports, connection, state, updates, grants, operations,
    counts: () => ({ storageDeletes, storageInserts, inventoryConsumes }) };
};

test('storage without a chest permits withdrawal preview and settlement but blocks deposit', async () => {
  const f = fixture({ capacity: 0, storage: { unbound: 1, trade: 0, personal: 0 } });
  await assert.rejects(f.home.depositHomeStorageInTransaction(f.connection, 'player', 17, 1), /尚未摆放储物箱/);
  const quote = await f.home.withdrawHomeStorageInTransaction(f.connection, 'player', 17, 1, true);
  assert.deepEqual([quote.side, quote.capacity, quote.usedWeightBefore, quote.usedWeightAfter], ['withdraw', 0, 0.5, 0]);
  assert.deepEqual(f.state.storage, { unbound: 1, trade: 0, personal: 0 });
  assert.deepEqual([f.updates.length, f.grants.length, f.operations.length], [0, 0, 0]);
  await f.home.withdrawHomeStorageInTransaction(f.connection, 'player', 17, 1);
  assert.deepEqual(f.state.storage, { unbound: 0, trade: 0, personal: 0 });
  assert.deepEqual(f.grants, [{ personal: 0, trade: 0, unbound: 1 }]);
  assert.deepEqual([f.counts().storageDeletes, f.operations.length], [1, 1]);
});

test('withdrawal transfers mixed binding with exact conditional decrement', async () => {
  const f = fixture();
  const preview = await f.home.withdrawHomeStorageInTransaction(f.connection, 'player', 17, 5, true);
  assert.deepEqual(preview.bindingUsed, { personal: 1, trade: 2, unbound: 2 });
  assert.deepEqual([preview.usedWeightBefore, preview.usedWeightAfter, preview.capacity], [3, 0.5, 10]);
  assert.deepEqual(f.state.storage, { unbound: 3, trade: 2, personal: 1 });
  await f.home.withdrawHomeStorageInTransaction(f.connection, 'player', 17, 5);
  assert.deepEqual(f.updates, [[5, 2, 1, 11, 17, 5, 2, 1, 2]]);
  assert.deepEqual(f.state.storage, { unbound: 1, trade: 0, personal: 0 });
  assert.deepEqual(f.grants, [{ personal: 1, trade: 2, unbound: 2 }]);
  assert.equal(f.operations.length, 1);
  assert.equal(f.counts().storageDeletes, 1); // Zero-quantity cleanup is attempted conditionally.
});

test('legacy inherently personal storage stock returns as personal-bound inventory', async () => {
  const f = fixture({ inherentlyPersonal: true, storage: { unbound: 1, trade: 1, personal: 1 } });
  const preview = await f.home.withdrawHomeStorageInTransaction(f.connection, 'player', 17, 2, true);
  assert.deepEqual(preview.bindingUsed, { personal: 1, trade: 1, unbound: 0 });
  assert.deepEqual(preview.bindingReturned, { personal: 2, trade: 0, unbound: 0 });
  await f.home.withdrawHomeStorageInTransaction(f.connection, 'player', 17, 2);
  assert.deepEqual(f.state.storage, { unbound: 1, trade: 0, personal: 0 });
  assert.deepEqual(f.grants, [{ personal: 2, trade: 0, unbound: 0 }]);
});

test('failed conditional withdrawal update and over-withdraw produce no grant or operation', async () => {
  const f = fixture({ storageUpdateAffectedRows: 0 });
  await assert.rejects(f.home.withdrawHomeStorageInTransaction(f.connection, 'player', 17, 7), /仓储数量不足/);
  assert.equal(f.updates.length, 0);
  await assert.rejects(f.home.withdrawHomeStorageInTransaction(f.connection, 'player', 17, 5), /仓储数量或绑定状态已变化/);
  assert.deepEqual(f.updates, [[5, 2, 1, 11, 17, 5, 2, 1, 2]]);
  assert.deepEqual(f.state.storage, { unbound: 3, trade: 2, personal: 1 });
  assert.deepEqual([f.counts().storageDeletes, f.grants.length, f.operations.length], [0, 0, 0]);
});

test('deposit preview is read-only and settlement keeps mixed binding in storage', async () => {
  const f = fixture({ storage: { unbound: 1, trade: 0, personal: 0 } });
  const quote = await f.home.depositHomeStorageInTransaction(f.connection, 'player', 17, 3, true);
  assert.deepEqual(quote.bindingUsed, { personal: 1, trade: 1, unbound: 1 });
  assert.deepEqual([f.counts().inventoryConsumes, f.counts().storageInserts, f.operations.length], [0, 0, 0]);
  await f.home.depositHomeStorageInTransaction(f.connection, 'player', 17, 3);
  assert.deepEqual(f.state.inventory, { unbound: 1, trade: 0, personal: 0 });
  assert.deepEqual(f.state.storage, { unbound: 2, trade: 1, personal: 1 });
  assert.deepEqual([f.counts().inventoryConsumes, f.counts().storageInserts, f.operations.length], [1, 1, 1]);
});

test('withdrawal preview and confirmation reject travel, mining, teammate combat, PvP and inactive state', async () => {
  for (const [key, value, message] of [
    ['travel', true, /旅行途中/], ['mining', true, /开采尚未结束/],
    ['combat', true, /战斗中/], ['pvp', true, /玩家对战中/],
    ['activityStatus', 'resting', /当前状态/]
  ] as const) {
    const f = fixture({ [key]: value });
    await assert.rejects(f.home.withdrawHomeStorageInTransaction(f.connection, 'player', 17, 1, true), message);
    await assert.rejects(f.home.withdrawHomeStorageInTransaction(f.connection, 'player', 17, 1), message);
    assert.deepEqual([f.updates.length, f.grants.length, f.operations.length], [0, 0, 0]);
  }
});
