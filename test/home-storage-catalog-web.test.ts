import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('web storage lists old contents at zero capacity, excludes personal-only deposits, and keeps instances read-only', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/home-storage.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  let characterLookups = 0;
  const stacked = { id: 3, code: 'home_wood', codex_id: 'materials_home_wood', name: '家园木材',
    item_category: '材料', description: '一段木材', quantity: 2, weight: 0.5,
    trade_bound_quantity: 1, personal_bound_quantity: 1 };
  const pool = { execute: async (sql: string, args: unknown[]) => {
    if (sql.includes('FROM player_home_storage_items hs')) {
      assert.deepEqual(args, [11, 'material']);
      return [[stacked]];
    }
    if (sql.includes('FROM player_home_storage_instances hs')) {
      assert.deepEqual(args, [11, 'material']);
      return [[{ id: 9, code: 'legacy_item', codex_id: 'legacy_codex', name: '旧仓实例',
        item_category: '材料', description: '一件旧物', weight: 1, quality: 86, durability: 20, durability_max: 30 }]];
    }
    if (sql.includes('FROM player_inventory pi')) {
      assert.deepEqual(args, [7, 'material']);
      return [[{ ...stacked, quantity: 3, personal_only: 0 },
        { ...stacked, id: 4, name: '永久纪念品', personal_only: 1 }]];
    }
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: () => 'unused' },
    '../database/pool': { getPool: async () => pool, withTransaction: async () => { throw new Error('Unexpected transaction'); } },
    '../game/alchemy-journal.service': { craftCharacterId: async () => { characterLookups++; return 7; } },
    '../game/home.service': { homeOverview: async () => ({ home: { id: 11, storage: { capacityKg: 0, usedKg: 2 } } }) }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const service = loaded.exports;

  const storage = await service.webHomeStorageCatalog('owner', 'storage', '材料', 1, '');
  assert.deepEqual([storage.capacityKg, storage.usedKg, storage.depositAvailable, storage.count, characterLookups], [0, 2, false, 2, 0]);
  assert.deepEqual(storage.items[0].binding, { unbound: 0, trade: 1, personal: 1 });
  assert.deepEqual([storage.items[0].code, storage.items[0].codexId, storage.items[0].transferable],
    ['home_wood', 'materials_home_wood', true]);
  assert.deepEqual([storage.items[1].kind, storage.items[1].transferable, storage.items[1].quality, storage.items[1].durabilityMax],
    ['instance', false, 86, 30]);

  const backpack = await service.webHomeStorageCatalog('owner', 'backpack', '材料', 1, '');
  assert.deepEqual([backpack.count, backpack.items[0].name, characterLookups], [1, '家园木材', 1]);
  assert.equal(backpack.items.some((item: any) => item.name === '永久纪念品'), false);
  await assert.rejects(service.webHomeStorageCatalog('owner', 'storage', '材料', 1, 'x'.repeat(81)), /过长/);
});
