import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('buy selection includes eligible items without active orders', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/game/market.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    execute: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('FROM characters c JOIN players p')) return [[{
        id: 1, copper_coins: 500, level: 10, adventurer_registered: 1,
        created_at: new Date(Date.now() - 73 * 60 * 60_000)
      }]];
      if (sql.includes('SELECT COUNT(*) AS total FROM item_definitions i')) return [[{ total: 1 }]];
      if (sql.includes('FROM item_definitions i LEFT JOIN market_item_state')) return [[{
        id: 7, name: '未挂牌素材', item_category: '怪材', description: '可以求购',
        trade_price: 10, stack_limit: 99, reference_price: null
      }]];
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const modules: Record<string, unknown> = {
    './achievement-trade': {}, './achievement-events': {}, './talent-material-recovery': {},
    './inventory-binding': {}, '../database/pool': { getPool: async () => pool },
    './character-operation.service': {}
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);

  const result = await loaded.exports.marketTradables('player', 1, '怪材', '未挂牌');
  assert.deepEqual(result.items, [{
    id: 7, name: '未挂牌素材', category: '怪材', description: '可以求购',
    stackLimit: 99, reference: 20, band: { min: 14, max: 30 }
  }]);
  assert.equal(result.totalPages, 1);
  const catalogQueries = queries.slice(1);
  assert.equal(catalogQueries.length, 2);
  assert.ok(catalogQueries.every(query => !query.sql.includes('market_orders')));
  assert.ok(catalogQueries.every(query => query.sql.includes('i.is_tradeable=1')));
  assert.deepEqual(catalogQueries[0]?.params, ['怪材', '%未挂牌%']);
});
