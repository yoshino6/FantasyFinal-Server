import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

// Compile the real presentation/handlers against a no-network adapter. No game
// pool, platform transport, startup module or production configuration is loaded.
class FormatFixture {
  value: any[] = [];
  static create = () => new FormatFixture();
  static createMarkdown = () => new FormatFixture();
  static createButtonGroup = () => new FormatFixture();
  addRow() { return this; }
  addButton(label: string, command: string, options: unknown) { this.value.push({ type: 'Button', value: label, command, options }); return this; }
  addTitle(value: string) { this.value.push({ type: 'title', value }); return this; }
  addText(value: string) { this.value.push({ type: 'text', value }); return this; }
  addBlockquote(value: string) { this.value.push({ type: 'quote', value }); return this; }
  addNewline() { return this; }
  addMarkdown(value: FormatFixture) { this.value.push(...value.value); return this; }
  addButtonGroup(value: FormatFixture) { this.value.push(...value.value); return this; }
}
const load = (source: string, dependencies: Record<string, unknown>, importService?: (name: string) => unknown) => {
  const result = { exports: {} as any };
  const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code.replace(/\bimport\(/g, '__fixtureImport(');
  new Function('require', '__fixtureImport', 'module', 'exports', code)((name: string) => {
    assert.ok(name in dependencies, `unexpected dependency ${name}`);
    return dependencies[name];
  }, async (name: string) => importService?.(name), result, result.exports);
  return result.exports;
};
const panelSource = readFileSync(new URL('../src/response/panel.ts', import.meta.url), 'utf8');
const panel = load(`const Format = require('format');\n${panelSource.slice(panelSource.indexOf('export type DirectionPanelState'), panelSource.indexOf('const battlePanel ='))}`, { format: FormatFixture });
const buttons = (format: FormatFixture) => format.value.filter(node => node.type === 'Button');
const open = () => ({ canMove: true });

test('QQ blocked direction refreshes without moving and never enables dungeon-only actions on the surface', () => {
  const obstacle = { canMove: false, reason: 'obstacle', label: '倒木', objectId: 'env1:dark_forest:2:2:0:0', destructible: true };
  const format = panel.panelButtons(false, false, { isDungeon: false, directions: { 上: obstacle, 下: open(), 左: obstacle, 右: open() } });
  const rendered = buttons(format);
  assert.equal(rendered.filter(button => button.value === '倒木·阻挡').length, 2);
  for (const blocked of rendered.filter(button => button.value === '倒木·阻挡')) {
    assert.equal(blocked.command, '/面板');
    assert.equal(blocked.options.style, undefined);
  }
  assert.ok(rendered.some(button => button.command === '/移动 右'));
  assert.ok(rendered.some(button => button.command === '/移动 下'));
  assert.equal(rendered.some(button => ['/移动 上', '/移动 左', '/脱离'].includes(button.command)), false);
  assert.equal(rendered.filter(button => button.command.startsWith('/清理景物 ')).length, 1, 'one multi-cell object has one clear entry');
  assert.ok(rendered.every(button => button.options.autoEnter === false && !('show' in button.options)));
  assert.ok(rendered.some(button => button.command === '/寻怪'));
});

test('QQ direction panel uses explicit dungeon context and fails closed without an authoritative snapshot', () => {
  const dungeon = buttons(panel.panelButtons(false, false, { isDungeon: true, directions: { 上: open(), 下: open(), 左: open(), 右: open() } }));
  assert.ok(dungeon.some(button => button.command === '/脱离'));
  assert.equal(buttons(panel.panelButtons()).some(button => button.command.startsWith('/移动 ')), false);
});

test('QQ v2 living-tree directions and clear buttons use the same manually sent commands', () => {
  const objectId = 'env2:dark_forest:-11:4:0:0';
  const tree = { canMove: false, reason: 'obstacle', label: '青叶橡树', objectId, destructible: true };
  const rendered = buttons(panel.panelButtons(false, false, { isDungeon: false, directions: { 上: tree, 下: open(), 左: tree, 右: open() } }));
  assert.equal(rendered.filter(button => button.command === `/清理景物 ${objectId}`).length, 1);
  assert.equal(rendered.filter(button => button.value === '青叶橡树·阻挡').length, 2);
  assert.ok(rendered.filter(button => button.value === '青叶橡树·阻挡').every(button => button.command === '/面板'));
  assert.ok(rendered.every(button => button.options.autoEnter === false && !('show' in button.options)));
  assert.ok(!rendered.some(button => ['/移动 上', '/移动 左'].includes(button.command)));
});

test('QQ refresh reads progress only and all clear controls require manual sending', async () => {
  const calls: string[] = [], sent: FormatFixture[] = [];
  const job = { id: 'job', objectId: 'object', objectName: '倒木', remainingSeconds: 0, ready: true, finishesAt: '2026-10-11T00:00:00Z' };
  const service = {
    environmentInspect: async () => { calls.push('inspect'); return { job, objects: [] }; },
    environmentStatus: async () => { calls.push('status'); return { job }; },
    environmentStartClear: async () => { calls.push('start'); return { job, message: '开始清理' }; },
    environmentCancelClear: async () => { calls.push('cancel'); return { message: '取消清理' }; },
    environmentFinishClear: async () => { calls.push('settle'); return { message: '已结算' }; }
  };
  const source = readFileSync(new URL('../src/response/map-environment.ts', import.meta.url), 'utf8');
  const presentation = load(source, {
    alemonjs: { Format: FormatFixture, useEvent: () => [{ current: { UserId: 'fixture' } }], useRoute: () => [{ param: () => 'object' }] },
    '../game/use-game-message': { useGameMessage: () => [{ send: async ({ format }: any) => { sent.push(format); } }], withoutAutomatonInteractions: (message: unknown) => message },
    '../game/message': { messageFormat: (title: string, text: string) => FormatFixture.create().addTitle(title).addText(text) },
    '../game/time-format': { durationText: (seconds: number) => `${seconds}秒` }
  }, name => name === './adventure' ? { movementButtons: async () => { calls.push('directions'); return FormatFixture.createButtonGroup().addButton('右', '/移动 右', { type: 'command', autoEnter: false }); } } : service);
  await presentation.mapEnvironmentHandler('status')();
  assert.deepEqual(calls, ['status']);
  assert.ok(buttons(sent[0]!).some(button => button.command === '/结算清理 object'));
  await presentation.mapEnvironmentHandler('settle')();
  assert.deepEqual(calls, ['status', 'settle', 'directions']);
  assert.ok(buttons(sent[1]!).some(button => button.command === '/移动 右'), 'settled result immediately includes refreshed directions');
  for (const format of sent) {
    assert.ok(buttons(format).every(button => button.options.autoEnter === false && !('show' in button.options)));
    assert.equal(format.value.some(node => node.type === 'Image'), false);
  }
});
