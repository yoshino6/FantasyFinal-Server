import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('Core guild shop previews use the same location, stock and binding checks without changing balances', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/game/guild-shop.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  let atGuild = true;
  let contribution = 100;
  let stock = 5;
  let owned = 4;
  let granted = 0;
  let ledger = 0;
  const connection = {
    execute: async (sql: string, args: unknown[] = []) => {
      if (sql.includes('SELECT c.id,c.guild_contribution FROM characters')) return [[{ id: 7, guild_contribution: contribution }]];
      if (sql.includes('SELECT item_category FROM item_definitions WHERE id=')) return [[{ item_category: '药剂' }]];
      if (sql.includes('FROM guild_shop_items si JOIN item_definitions i') && sql.includes('FOR UPDATE')) return [[{
        id: 3, name: '治疗药剂', item_type: 'consumable', item_category: '药剂', description: '恢复生命',
        trade_price: 20, rarity: '普通', skill_code: null, skill_tier: null, buy_price: 20, stock_quantity: stock
      }]];
      if (sql.startsWith('UPDATE characters SET guild_contribution=guild_contribution-')) {
        const price = Number(args[0]); if (contribution < price) return [{ affectedRows: 0 }];
        contribution -= price; return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE guild_shop_items SET stock_quantity=')) {
        const amount = Number(args[0]); if (stock < amount) return [{ affectedRows: 0 }];
        stock -= amount; return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('INSERT IGNORE INTO player_item_codex')) return [{ affectedRows: 1 }];
      if (sql.includes('FROM player_inventory pi JOIN item_definitions i') && sql.includes('FOR UPDATE')) return [[{
        id: 9, name: '兽材', item_type: 'material', item_category: '材料', quantity: owned,
        personal_bound_quantity: 1, trade_bound_quantity: 3, sell_price: 50
      }]];
      if (sql.includes('FROM pvp_stolen_loot')) return [[]];
      if (sql.startsWith('UPDATE player_inventory SET quantity=')) { owned -= Number(args[0]); return [{ affectedRows: 1 }]; }
      if (sql.startsWith('DELETE FROM player_inventory')) return [{ affectedRows: 0 }];
      if (sql.startsWith('UPDATE characters SET guild_contribution=guild_contribution+')) {
        contribution += Number(args[0]); return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const modules: Record<string, unknown> = {
    './achievement-hooks': { achievementItem: async () => undefined },
    'node:crypto': { randomUUID: () => 'uuid' },
    './character-operation.service': { recordCharacterOperation: async () => { ledger++; } },
    './inventory-binding': { grantInventory: async (_connection: unknown, _owner: number, _itemId: number, binding: any) => {
      granted += Number(binding.trade ?? 0) + Number(binding.personal ?? 0);
    } },
    '../database/pool': { getPool: async () => connection, withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work(connection) },
    './guild-context': { requireGuildService: async () => { if (!atGuild) throw new Error('请先到当地冒险者公会入口。'); } },
    './skill-access.config': { guildContributionSalePrice: (price: number) => Math.floor(price / 10), guildSkillBookContributionPrice: () => null },
    './divine-effects': { openingShopQuote: async (_connection: unknown, _owner: number, _item: unknown, quantity: number) => ({
      base: 20 * quantity, price: 20 * quantity, credit: 0, discount: 0
    }), payOpeningShopDiscount: async () => undefined },
    './guild-map.service': { guildMapCatalog: async () => [], guildMapContributionPrice: () => null }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const shop = loaded.exports;

  atGuild = false;
  await assert.rejects(shop.buyShopItemInTransaction(connection, 'player', 3, 2, true), /公会入口/);
  atGuild = true;
  const buy = await shop.buyShopItemInTransaction(connection, 'player', 3, 2, true);
  assert.deepEqual([buy.price, buy.stockAfter, buy.contributionAfter, buy.personalBound], [4, 3, 96, false]);
  assert.deepEqual([contribution, stock, granted, ledger], [100, 5, 0, 0]);
  await assert.rejects(shop.buyShopItemInTransaction(connection, 'player', 3, 6, true), /库存不足/);
  await shop.buyShopItemInTransaction(connection, 'player', 3, 2);
  assert.deepEqual([contribution, stock, granted, ledger], [96, 3, 2, 1]);
  await assert.rejects(shop.sellShopItemInTransaction(connection, 'player', 9, 4, true), /个人绑定/);
  const sell = await shop.sellShopItemInTransaction(connection, 'player', 9, 2, true);
  assert.deepEqual([sell.unitPrice, sell.price, sell.sellableAfter], [5, 10, 1]);
  assert.deepEqual([contribution, owned, ledger], [96, 4, 1]);
  await shop.sellShopItemInTransaction(connection, 'player', 9, 2);
  assert.deepEqual([contribution, owned, ledger], [106, 2, 2]);
});
