import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listCoreCommandCatalog, registerCoreCommandRouter } from '../src/core-command-bridge';

test('market order mutations require confirmation in the Core command catalog', () => {
  const paths = ['万叶市场', '万叶订单', '万叶卖出', '万叶求购', '万叶撤单'];
  const routes = new Map(paths.map(path => [path, { config: { path } }]));
  registerCoreCommandRouter({
    dispatch: async () => undefined,
    routes: new Map([['private.message.create', { one: routes, two: new Map() }]])
  });

  const catalog = new Map(listCoreCommandCatalog().map(entry => [entry.command, entry]));
  for (const command of ['万叶卖出', '万叶求购', '万叶撤单']) {
    assert.equal(catalog.get(command)?.readOnly, false, `${command} must be a write action`);
    assert.equal(catalog.get(command)?.requiresConfirm, true, `${command} must require confirmation`);
    assert.equal(catalog.get(command)?.category, 'shop', `${command} must appear with trade actions`);
  }
  for (const command of ['万叶市场', '万叶订单']) {
    assert.equal(catalog.get(command)?.readOnly, true, `${command} must remain read-only`);
  }
});

test('bank mutations require confirmation while the bank overview stays read-only', () => {
  const paths = ['钱庄', '钱庄存入', '钱庄取出', '钱庄定存', '钱庄兑付', '钱庄提前支取'];
  const routes = new Map(paths.map(path => [path, { config: { path } }]));
  registerCoreCommandRouter({
    dispatch: async () => undefined,
    routes: new Map([['private.message.create', { one: routes, two: new Map() }]])
  });

  const catalog = new Map(listCoreCommandCatalog().map(entry => [entry.command, entry]));
  for (const command of paths.slice(1)) {
    assert.equal(catalog.get(command)?.readOnly, false, `${command} must be a write action`);
    assert.equal(catalog.get(command)?.requiresConfirm, true, `${command} must require confirmation`);
    assert.equal(catalog.get(command)?.category, 'shop', `${command} must appear with shop actions`);
  }
  assert.equal(catalog.get('钱庄')?.readOnly, true);
});
