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

test('environment clear actions explicitly separate reading progress from persistent writes', () => {
  const paths = ['景物详情', '清理景物', '刷新清理', '结算清理', '取消清理'];
  registerCoreCommandRouter({ dispatch: async () => undefined, routes: new Map([['private.message.create', { one: new Map(paths.map(path => [path, { config: { path } }])), two: new Map() }]]) });
  const catalog = new Map(listCoreCommandCatalog().map(entry => [entry.command, entry]));
  for (const command of paths) {
    const entry = catalog.get(command)!;
    const reading = command === '景物详情' || command === '刷新清理';
    assert.equal(entry.category, 'explore');
    assert.equal(entry.readOnly, reading);
    assert.equal(entry.risk, reading ? 'read' : 'write');
    assert.ok(entry.refresh.includes('nearby'));
    if (!reading) assert.ok(entry.refresh.includes('map'));
  }
  assert.ok(catalog.get('结算清理')!.refresh.includes('inventory'));
});
