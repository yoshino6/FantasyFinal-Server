import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('web bank preview and confirmation recheck location and balances, then settle only once', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/bank.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const requests = new Map<string, { owner: number; kind: string; snapshot: any; result: any }>();
  let sequence = 0;
  let pocket = 1000;
  let demand = 200;
  let atBank = true;
  let mutations = 0;
  const uuid = () => `00000000-0000-0000-0000-${String(++sequence).padStart(12, '0')}`;
  const access = () => { if (!atBank) throw new Error('请站在对应建筑入口办理。'); };
  const finance = {
    depositProducts: { seven: { name: '七日定存' }, thirty: { name: '三十日定存' }, hundred: { name: '百日定存' } },
    bankTransferInTransaction: async (_connection: unknown, _user: string, amount: number, direction: 'in' | 'out', preview: boolean) => {
      access();
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('金额无效。');
      if (direction === 'in' && pocket < amount) throw new Error('随身银币不足。');
      if (direction === 'out' && demand < amount) throw new Error('活期余额不足。');
      const quote = { copper: amount, direction, pocketBefore: pocket, pocketAfter: pocket + (direction === 'in' ? -amount : amount),
        demandBefore: demand, demandAfter: demand + (direction === 'in' ? amount : -amount) };
      if (!preview) { pocket = quote.pocketAfter; demand = quote.demandAfter; mutations++; }
      return quote;
    },
    openBankDepositInTransaction: async (_connection: unknown, _user: string, code: string, amount: number, preview: boolean) => {
      access();
      if (demand < amount) throw new Error('活期余额不足。');
      const quote = { copper: amount, interest: 2, due: Date.now() + 7 * 86400000, name: '七日定存',
        productCode: code, demandBefore: demand, demandAfter: demand - amount };
      if (!preview) { demand -= amount; mutations++; return { id: 19, ...quote }; }
      return quote;
    },
    settleBankDepositInTransaction: async (_connection: unknown, _user: string, id: number, early: boolean, preview: boolean) => {
      access();
      const quote = { depositId: id, productCode: 'thirty', principal: 100, credit: early ? 99 : 105,
        interest: early ? 0 : 5, penalty: early ? 1 : 0, matured: !early, due: 1,
        demandBefore: demand, demandAfter: demand + (early ? 99 : 105) };
      if (!preview) { demand = quote.demandAfter; mutations++; }
      return quote;
    }
  };
  const craft = {
    craftCharacterId: async () => 1,
    createCraftRequest: async (_connection: unknown, owner: number, kind: string, snapshot: any) => {
      const token = uuid(); requests.set(token, { owner, kind, snapshot, result: null }); return token;
    },
    craftRequestFor: async (_connection: unknown, owner: number, kind: string, token: string) => {
      const request = requests.get(token);
      if (!request || request.owner !== owner || request.kind !== kind) throw new Error('Invalid request');
      return request;
    },
    completeCraftRequest: async (_connection: unknown, _owner: number, token: string, result: any) => {
      requests.get(token)!.result = result;
    }
  };
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: uuid },
    '../database/pool': { withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work({}) },
    '../game/alchemy-journal.service': craft,
    '../game/finance.service': finance
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const service = loaded.exports;

  atBank = false;
  await assert.rejects(service.previewBankAction('player', { action: 'deposit', amount: 100 }), /建筑入口/);
  assert.equal(requests.size, 0);
  atBank = true;
  const preview = await service.previewBankAction('player', { action: 'deposit', amount: 100 });
  assert.deepEqual([preview.quote.pocketAfter, preview.quote.demandAfter], [900, 300]);
  assert.equal(mutations, 0);
  await assert.rejects(service.confirmBankAction('player', preview.token, uuid()), /凭据不匹配/);
  atBank = false;
  await assert.rejects(service.confirmBankAction('player', preview.token, preview.idempotencyKey), /建筑入口/);
  atBank = true;
  pocket = 990;
  await assert.rejects(service.confirmBankAction('player', preview.token, preview.idempotencyKey), /状态已变化/);
  assert.equal(mutations, 0);
  pocket = 1000;
  const first = await service.confirmBankAction('player', preview.token, preview.idempotencyKey);
  assert.deepEqual(await service.confirmBankAction('player', preview.token, preview.idempotencyKey), first);
  assert.deepEqual([pocket, demand, mutations], [900, 300, 1]);

  const term = await service.previewBankAction('player', { action: 'term_open', productCode: 'seven', amount: 100 });
  assert.equal(term.quote.interest, 2);
  assert.equal(mutations, 1);
  const opened = await service.confirmBankAction('player', term.token, term.idempotencyKey);
  assert.equal(opened.id, 19);
  assert.deepEqual([demand, mutations], [200, 2]);
  const early = await service.previewBankAction('player', { action: 'early_settle', depositId: 19 });
  assert.deepEqual([early.quote.credit, early.quote.penalty], [99, 1]);
  await service.confirmBankAction('player', early.token, early.idempotencyKey);
  assert.deepEqual([demand, mutations], [299, 3]);
});
