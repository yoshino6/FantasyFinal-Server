import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import * as sourcePolicy from '../src/game/local-exploration-compact';
import { LocalExplorationError, assertExpectedLocalStep, isLocalPosition } from '../src/game/local-exploration-route';

const { compactLocalStepAllowed, compactLocalStepVitals } = process.env.FF_COMPACT_POLICY_STAGE
  ? await import(pathToFileURL(process.env.FF_COMPACT_POLICY_STAGE).href) : sourcePolicy;

const origin = { x: 0, y: 0, z: 0, regionId: 1 }, target = { ...origin, x: 1 };
const character = { id: 7, current_region_id: 1, pos_x: 1, pos_y: 0, pos_z: 0, region_name: '草原',
  current_hp: 80.2, current_mp: 20.3, stamina: 75.1, activity_status: 'active' };
const ordinary = { character, kind: 'event', targets: [] };
const source = readFileSync(process.env.FF_COMPACT_SERVICE_STAGE ?? new URL('../src/game/adventure.service.ts', import.meta.url), 'utf8');
const load = (source: string, dependencies: Record<string, unknown>) => {
  const module = { exports: {} as any };
  new Function(...Object.keys(dependencies), 'module', 'exports', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(...Object.values(dependencies), module, module.exports);
  return module.exports;
};
const section = (source: string, start: string, end: string) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, start); return source.slice(first, last);
};

test('compact policy excludes every special landing, cross-region move, reward and invalid current vital state', () => {
  assert.equal(compactLocalStepAllowed(ordinary, origin), true);
  for (const kind of ['encounter', 'main_quest_story', 'interaction', 'resource', 'npc', 'dungeon_entrance', 'dungeon', 'object', 'story']) {
    assert.equal(compactLocalStepAllowed({ ...ordinary, kind }, origin), false, kind);
  }
  for (const patch of [{ enteredTown: true }, { talentScavengeNotice: '拾取木材' }, { current_region_id: 2 }, { pos_z: -1 }, { pos_x: 3 }]) {
    assert.equal(compactLocalStepAllowed({ ...ordinary, character: { ...character, ...patch } }, origin), false);
  }
  assert.equal(compactLocalStepAllowed({ ...ordinary, companionFindNotice: true }, origin), false);
  assert.equal(compactLocalStepAllowed({ ...ordinary, targets: ['npc'] }, origin), false);
  assert.deepEqual(compactLocalStepVitals(character, target), { position: target, region: '草原', hp: 80, mp: 20, stamina: 75 });
  for (const patch of [{ current_hp: 0 }, { current_mp: NaN }, { stamina: -1 }, { activity_status: 'resting' }, { pos_x: 2 }]) {
    assert.equal(compactLocalStepVitals({ ...character, ...patch }, target), undefined);
  }
});

test('actual route service reads the locked current vitals and only the existing authorized window for compact nearby data', async () => {
  const start = source.includes('export const localExplorationRouteStep') ? 'export const localExplorationRouteStep =' : 'const localExplorationRouteStep =';
  const code = section(source, start, 'const coordinateInteractionTargetsFor =') + (start.startsWith('export') ? '' : '\nexport { localExplorationRouteStep };');
  const cells = [{ ...target, regionCode: 'worldtree_meadow', passable: true, reachable: true }];
  const map = { origin: target, range: 5, actionRange: 3, movement: { speed: 4, step: 3, maximum: 4 }, cells, environmentJob: null };
  let result: any = ordinary, current: any = character, mapReads = 0, freshReads = 0, nearbyReads = 0, committed = false;
  const connection = { execute: async (sql: string) => { assert.match(sql, /^SELECT code FROM map_regions/); return [[{ code: 'worldtree_meadow' }]]; } };
  const service = load(code, {
    isLocalPosition, LocalExplorationError, compactLocalStepAllowed, compactLocalStepVitals,
    withTransaction: async (run: (db: any) => Promise<any>) => { committed = false; const value = await run(connection); committed = true; return value; },
    moveToPosition: async (db: unknown) => { assert.equal(db, connection); return result; },
    coordinateInteractionTargetsFor: async () => result.targets,
    localExplorationMap: async (_user: string, db: unknown) => { assert.equal(db, connection); assert.equal(committed, false); mapReads++; return map; },
    readLocalExplorationCharacter: async (db: unknown) => { assert.equal(db, connection); freshReads++; return current; },
    nearbyPointsForWindow: async (_user: string, row: unknown, db: unknown, observed: unknown, travel: boolean, limits: unknown) => {
      nearbyReads++; assert.equal(db, connection); assert.equal(row, current); assert.equal(observed, cells);
      assert.equal(travel, false); assert.deepEqual(limits, { range: 5, actionRange: 3 });
      return { points: [{ x: 1, y: 1, z: 0, regionId: 1, interaction: { type: '资源', id: '2' } }], range: 5, actionRange: 3 };
    }
  });
  const compact = await service.localExplorationRouteStep('fixture', 1, 0, 0, origin, true);
  assert.equal(committed, true); assert.equal(compact.stepState.stamina, 75); assert.equal(compact.stepState.nearby.points[0].interaction.id, '2');
  assert.deepEqual(compact.stepState.movement, map.movement); assert.equal(compact.localMap, map);
  const legacy = await service.localExplorationRouteStep('fixture', 1, 0, 0, origin);
  assert.equal(legacy.stepState, undefined); assert.equal(freshReads, 1); assert.equal(nearbyReads, 1);
  for (const kind of ['encounter', 'story', 'resource']) {
    result = { ...ordinary, kind }; assert.equal((await service.localExplorationRouteStep('fixture', 1, 0, 0, origin, true)).stepState, undefined);
  }
  result = ordinary; current = { ...character, stamina: NaN };
  assert.equal((await service.localExplorationRouteStep('fixture', 1, 0, 0, origin, true)).stepState, undefined);
  assert.equal(nearbyReads, 1); assert.equal(mapReads, 6);
});

test('actual Web route opts in with a strict boolean and skips the full panel only when the service supplies safe state', async () => {
  const path = process.env.FF_COMPACT_ROUTER_STAGE ?? new URL('../src/app-api/router.ts', import.meta.url);
  const routerSource = readFileSync(path, 'utf8'), quote = String(path).endsWith('.js') ? '"' : "'";
  let handler: (ctx: any) => Promise<void> = async () => {}, panels = 0, requested: any[] = [];
  const code = section(routerSource, `router.post(apiPath(${quote}/explore/route/step${quote})`, `router.post(apiPath(${quote}/explore/move${quote})`)
    .replace(/await import\((['"])\.\.\/game\/adventure\.service(?:\.js)?\1\)/g, 'await loadAdventure()');
  const stepState = { ...compactLocalStepVitals(character, target), movement: {}, nearby: { points: [] } };
  let safe = true;
  const install = (apiPrefix: string) => load(code, {
    router: { post: (_path: unknown, value: any) => { handler = value; } }, apiPath: (value: string) => value, apiPrefix,
    requireSession: async () => ({}), parseBody: async (ctx: any) => ctx.request.body,
    isLocalPosition, assertExpectedLocalStep, LocalExplorationError, appSessionQqUser: async () => 'fixture',
    appMovementNeedsStory: async () => false,
    loadAdventure: async () => ({ localExplorationRouteStep: async (...args: any[]) => { requested.push(args); return { position: target, moved: true, localMap: {}, ...(safe && args[5] ? { stepState } : {}) }; } }),
    appQuickPanel: async () => { panels++; return { summary: {} }; }, apiError: (_ctx: any, _status: number, message: string) => assert.fail(message)
  });
  install('/api/web/v1');
  for (const compact of [true, undefined, false, 'true', 1]) {
    const ctx: any = { request: { body: { ...target, expectedFrom: origin, compact } } }; await handler(ctx);
    assert.equal(Boolean(ctx.body.stepState), compact === true); assert.equal(Boolean(ctx.body.panel), compact !== true);
  }
  safe = false; await handler({ request: { body: { ...target, expectedFrom: origin, compact: true } } });
  install('/api/app/v1'); await handler({ request: { body: { ...target, expectedFrom: origin, compact: true } } });
  assert.deepEqual(requested.map(args => args[5]), [true, false, false, false, false, true, false]);
  assert.equal(panels, 6);
});
