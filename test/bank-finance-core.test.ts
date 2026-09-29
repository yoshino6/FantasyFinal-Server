import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('Core bank transfer quote is read-only and both quote and write enforce the building gate', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/game/finance.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  let pocket = 500;
  let demand = 200;
  let atBank = true;
  let active = true;
  let leaderCombat = false;
  let teammateCombat = false;
  let ledgerEntries = 0;
  let operationEntries = 0;
  const connection = {
    execute: async (sql: string, args: unknown[] = []) => {
      if (sql.includes('FROM characters c JOIN players p') && sql.includes('JOIN map_regions r')) return [[{
        id: 1, copper_coins: pocket, level: 10, adventurer_registered: 1, created_at: new Date(),
        activity_status: active ? 'active' : 'traveling', current_region_id: 2, pos_x: 3, pos_y: 4, pos_z: 0,
        is_spawn_enabled: 0, is_owner_only: 0, is_enabled: 1
      }]];
      if (sql.includes('FROM player_travels') || sql.includes('FROM player_pvp_battle_sessions')) return [[]];
      if (sql.includes('FROM combat_sessions')) {
        assert.match(sql, /LEFT JOIN combat_members cm ON cm\.session_id=cs\.id/);
        assert.match(sql, /cs\.state='active'/);
        assert.deepEqual(args, [1, 1]);
        return [leaderCombat || teammateCombat ? [{ '1': 1 }] : []];
      }
      if (sql.includes('FROM map_npcs')) {
        assert.deepEqual(args, [2, 'silver_bell_bank', 3, 4, 0]);
        return [atBank ? [{ 1: 1 }] : []];
      }
      if (sql.startsWith('INSERT IGNORE INTO finance_bank_accounts')) return [{ affectedRows: 0 }];
      if (sql.includes('SELECT demand_copper FROM finance_bank_accounts')) return [[{ demand_copper: demand }]];
      if (sql.startsWith('UPDATE characters SET copper_coins=copper_coins-')) {
        const amount = Number(args[0]);
        if (pocket < amount) return [{ affectedRows: 0 }];
        pocket -= amount; return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE characters SET copper_coins=copper_coins+')) {
        pocket += Number(args[0]); return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE finance_bank_accounts SET demand_copper=demand_copper+')) {
        demand += Number(args[0]); return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE finance_bank_accounts SET demand_copper=demand_copper-')) {
        const amount = Number(args[0]);
        if (demand < amount) return [{ affectedRows: 0 }];
        demand -= amount; return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('INSERT INTO finance_ledger')) { ledgerEntries++; return [{ affectedRows: 1 }]; }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: () => 'uuid' },
    '../database/pool': { getPool: async () => connection, withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work(connection) },
    './character-operation.service': { recordCharacterOperation: async () => { operationEntries++; } },
    './finance-content': { financeFaction: () => null },
    './finance-math': { financeBusinessDate: () => '2026-09-28' },
    './finance-money': { copperText: String, reservedInterestCopper: () => 0 },
    './finance-npc': { npcBuyAllocation: () => ({}), npcSellSupport: () => ({}) }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const finance = loaded.exports;

  atBank = false;
  await assert.rejects(finance.bankSummaryAtBuilding('player'), /建筑入口/);
  await assert.rejects(finance.bankTransferInTransaction(connection, 'player', 100, 'in', true), /建筑入口/);
  assert.deepEqual([pocket, demand, ledgerEntries], [500, 200, 0]);
  atBank = true;
  active = false;
  await assert.rejects(finance.bankTransferInTransaction(connection, 'player', 100, 'in', true), /当前状态/);
  active = true;
  teammateCombat = true;
  await assert.rejects(finance.bankSummaryAtBuilding('player'), /战斗中/);
  await assert.rejects(finance.bankTransferInTransaction(connection, 'player', 100, 'in', true), /战斗中/);
  await assert.rejects(finance.bankTransferInTransaction(connection, 'player', 100, 'in'), /战斗中/);
  assert.deepEqual([pocket, demand, ledgerEntries], [500, 200, 0]);
  teammateCombat = false;
  leaderCombat = true;
  await assert.rejects(finance.bankTransferInTransaction(connection, 'player', 100, 'in', true), /战斗中/);
  leaderCombat = false;
  const quote = await finance.bankTransferInTransaction(connection, 'player', 100, 'in', true);
  assert.deepEqual([quote.pocketBefore, quote.pocketAfter, quote.demandBefore, quote.demandAfter], [500, 400, 200, 300]);
  assert.deepEqual([pocket, demand, ledgerEntries, operationEntries], [500, 200, 0, 0]);
  await finance.bankTransferInTransaction(connection, 'player', 100, 'in');
  assert.deepEqual([pocket, demand, ledgerEntries, operationEntries], [400, 300, 1, 1]);
  await assert.rejects(finance.bankTransferInTransaction(connection, 'player', 301, 'out', true), /活期余额不足/);
  await finance.bankTransferInTransaction(connection, 'player', 40, 'out');
  assert.deepEqual([pocket, demand, ledgerEntries, operationEntries], [440, 260, 2, 2]);
});
