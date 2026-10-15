import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { surfaceEnvironmentHint } from '../src/game/map-surface-message';
import { surfaceCombatTtlMs, surfaceWalkTtlMs } from '../src/game/map-surface-marks.service';
import { environmentObjectCells } from '../src/game/map-environment.config';

// Execute the current production declarations with an offline transport and DB.
// Only unrelated imports are omitted; panel, direction and snapshot logic are real.
class FormatFixture {
  value: any[] = [];
  static createButtonGroup = () => new FormatFixture();
  addRow() { return this; }
  addButton(label: string, command: string, options: unknown) { this.value.push({ label, command, options }); return this; }
}
const load = (source: string, dependencies: Record<string, unknown>) => {
  const result = { exports: {} as any };
  const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(name in dependencies, `unexpected dependency ${name}`);
    return dependencies[name];
  }, result, result.exports);
  return result.exports;
};
const section = (source: string, start: string, end: string) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `missing production declarations: ${start}`);
  return source.slice(a, b);
};
const responseSource = readFileSync(new URL('../src/response/adventure.ts', import.meta.url), 'utf8');
const serviceSource = readFileSync(new URL('../src/game/adventure.service.ts', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../src/response/panel.ts', import.meta.url), 'utf8');
const panel = load(`const Format = require('format');\n${section(panelSource, 'export type DirectionPanelState', 'const battlePanel =')}`, { format: FormatFixture });
const scene = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, scopeToken: 'world:0',
  recentWalks: [{ ageMs: 10, remainingMs: surfaceWalkTtlMs - 10 }],
  combatMarks: [{ kind: 'blood', ageMs: 20, remainingMs: surfaceCombatTtlMs - 20 }], ...overrides } as any);

test('QQ environment hints are anonymous and require live authorized public surface facts', () => {
  assert.equal(surfaceEnvironmentHint(), '');
  assert.equal(surfaceEnvironmentHint(scene({ recentWalks: [], combatMarks: [] })), '');
  assert.equal(surfaceEnvironmentHint(scene()), '草地留着浅浅脚印。\n附近留有战斗痕迹。');
  for (const scopeToken of ['private:1', 'dungeon:3:-1', 'world:-1', 'world:0:other']) assert.equal(surfaceEnvironmentHint(scene({ scopeToken })), '');
  assert.equal(surfaceEnvironmentHint(scene({ schemaVersion: 2 })), '');
  for (const mark of [{ ageMs: surfaceWalkTtlMs, remainingMs: 1 }, { ageMs: -1, remainingMs: 1 }, { ageMs: 1, remainingMs: 0 }, { ageMs: NaN, remainingMs: 1 }])
    assert.equal(surfaceEnvironmentHint(scene({ recentWalks: [mark], combatMarks: [] })), '');
  for (const mark of [{ kind: 'blood', ageMs: surfaceCombatTtlMs, remainingMs: 1 }, { kind: 'blood', ageMs: 1, remainingMs: 0 }, { kind: 'unknown', ageMs: 1, remainingMs: 100 }])
    assert.equal(surfaceEnvironmentHint(scene({ recentWalks: [], combatMarks: [mark] })), '');
  for (const kind of ['blood', 'slime', 'debris', 'magic']) assert.equal(surfaceEnvironmentHint(scene({ recentWalks: [], combatMarks: [{ kind, ageMs: 1, remainingMs: 100 }] })), '附近留有战斗痕迹。');
  const value = surfaceEnvironmentHint(scene({ playerId: 'secret-player', x: 9632, combatMarks: [{ kind: 'blood', ageMs: 10, remainingMs: 100, characterId: 'secret-player', x: 9632 }] }));
  assert.equal(value, '草地留着浅浅脚印。\n附近留有战斗痕迹。');
});

const fixture = () => {
  let mapReads = 0;
  const map = { origin: { x: 2, y: 3, z: 0 }, surfaceScene: scene(), environmentJob: null,
    cells: [{ x: 2, y: 4, passable: false }, { x: 2, y: 2, passable: true }, { x: 1, y: 3, passable: true }, { x: 3, y: 3, passable: true }],
    environment: [{ id: 'rock:1', name: '巨石', x: 2, y: 4, z: 0, regionId: 3, footprint: [{ dx: 0, dy: 0 }], blocking: true, destructible: true }] };
  const localExplorationMap = async () => { mapReads++; return map; };
  const directions = load(`const { localExplorationMap, readLocalExplorationCharacter, getPool, environmentObjectCells } = require('fixture');\n${section(serviceSource, 'export const environmentDirectionState =', 'export const localExplorationRoutePreview =')}`, {
    fixture: { localExplorationMap, readLocalExplorationCharacter: async () => ({ region_name: '世界树草原' }), getPool: async () => ({}), environmentObjectCells }
  });
  const snapshots: unknown[] = [];
  const dependencies = { localExplorationMap, surfaceEnvironmentHint, panelButtons: panel.panelButtons,
    environmentDirectionState: async (user: string, snapshot?: unknown) => { snapshots.push(snapshot); return directions.environmentDirectionState(user, snapshot); },
    autoBattleConfig: async () => ({ settings: { enabled: true } }), mapHiddenMentorAtCurrentCell: async () => null,
    nearbyPoints: async () => ({ character: { activity_status: 'active', pos_x: 2, pos_y: 3 }, range: 4, points: [], landmarks: [], mapUnlocked: true }),
    movementProfile: async () => ({ step: 1, maximum: 3, showLandmarks: true, showPlayers: true }),
    dungeonTrackingHint: async () => '原有识踪', omniscientTraces: async () => '原有痕迹', movedLocationText: () => '原有位置', outsidePanel: (...args: unknown[]) => ({ args }) };
  const source = `const { ${Object.keys(dependencies).join(',')} } = require('fixture');\n${section(responseSource, 'const movementMapSnapshots =', '// 战斗按键')}\n${section(responseSource, 'export const movementPanel =', 'const interactionTypeLabel:')}`;
  return { ...load(source, { fixture: dependencies }), map, snapshots, get mapReads() { return mapReads; } };
};

test('QQ panel and actual direction function reuse one local map and preserve original text and blocked controls', async () => {
  const f = fixture(), response = await f.movementPanel('fixture-account', '原有描述');
  assert.equal(f.mapReads, 1);
  assert.equal(response.args[1], '原有位置'); assert.equal(response.args[6], '原有描述');
  assert.equal(response.args[10], '原有痕迹\n【地宫识踪】原有识踪\n草地留着浅浅脚印。\n附近留有战斗痕迹。');
  const buttons: FormatFixture = await f.movementButtons('fixture-account', false, response);
  assert.equal(f.mapReads, 1, 'direction lookup must not repeat local map generation');
  assert.equal(f.snapshots[0], f.map);
  const blocked = buttons.value.find(button => button.label === '巨石·阻挡');
  assert.ok(blocked); assert.equal(blocked.command, '/面板'); assert.equal(blocked.options.style, undefined);
  assert.equal(buttons.value.some(button => button.command === '/移动 上'), false);
  for (const direction of ['下', '左', '右']) assert.ok(buttons.value.some(button => button.command === `/移动 ${direction}`));
  assert.ok(buttons.value.every(button => button.options.autoEnter === false && !('show' in button.options)));
  assert.equal(buttons.value.some(button => button.command === '/脱离'), false);
});

test('QQ per-panel snapshots cannot cross accounts and missing snapshots read fresh authoritative direction state', async () => {
  const f = fixture(), response = await f.movementPanel('first-account', '描述');
  await f.movementButtons('second-account', false, response);
  assert.equal(f.snapshots[0], undefined); assert.equal(f.mapReads, 2);
  await f.movementButtons('first-account');
  assert.equal(f.snapshots[1], undefined); assert.equal(f.mapReads, 3);
  f.map.environmentJob = { id: 'active-clear' } as any;
  const buttons: FormatFixture = await f.movementButtons('first-account', true, response);
  assert.equal(f.snapshots[2], f.map);
  assert.equal(buttons.value.some(button => button.command.startsWith('/移动 ')), false, 'active clearing disables every direction');
  assert.equal(buttons.value.some(button => button.command.startsWith('/清理景物 ')), false, 'resting never starts a clear action');
});
