import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { buildMovementVisual, captureMovementVisual, recordMovementVisual } from '../src/game/movement-visual';
import type { TravelPlan } from '../src/game/connected-travel.service';

const point = (x: number, y = 0, z = 0, regionId = 1) => ({ x, y, z, regionId });
const regions = [{ id: 1, code: 'baina_town', name: '百纳镇' }];
const plan: TravelPlan = {
  leaderId: 1, start: point(0), target: point(2), members: [{ id: 1, user: 'private-user' }], seconds: 0, destinationKind: 'normal',
  legs: [{ kind: 'walk', from: point(0), to: point(2), distance: 4, waypoints: [point(0), point(0, 1), point(2, 1), point(2)] }]
};
const load = (source: string, dependencies: Record<string, unknown>) => {
  const module = { exports: {} as any };
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code.replace(/\bimport\(/g, '__fixtureImport(');
  new Function(...Object.keys(dependencies), '__fixtureImport', 'module', 'exports', code)(...Object.values(dependencies), async (name: string) => (dependencies.require as (name: string) => unknown)(name), module, module.exports);
  return module.exports;
};

test('instant movement visual uses the confirmed endpoint and the real detour with cumulative distance', () => {
  const visual = buildMovementVisual(plan, point(2), 'instant-1', regions)!;
  assert.equal(visual.totalDistance, 4);
  assert.deepEqual(visual.waypoints.map(node => [node.x, node.y, node.distance]), [[0, 0, 0], [0, 1, 1], [2, 1, 3], [2, 0, 4]]);
  assert.equal(visual.origin.regionName, '百纳镇'); assert.equal(visual.target.x, 2);
  assert.equal(visual.waypoints.some(node => 'at' in node), false, 'committed geometry does not replace gameplay travel clocks');
  assert.equal(buildMovementVisual(plan, point(1), 'instant-1', regions), undefined);
  assert.equal(buildMovementVisual({ ...plan, legs: plan.legs.map(leg => ({ ...leg, waypoints: undefined })) }, point(2), 'instant-1', regions), undefined);
  assert.equal(buildMovementVisual({ ...plan, legs: plan.legs.map(leg => ({ ...leg, kind: 'portal' })) }, point(2), 'instant-1', regions), undefined);
  assert.equal(JSON.stringify(visual).includes('private-user'), false);
});

test('committed movement carries effective speed independently of detour distance and legacy callers', () => {
  const fast = buildMovementVisual(plan, point(2), 'fast', regions, 8)!;
  assert.equal(fast.totalDistance, 4);
  assert.equal(fast.movementSpeed, 8);
  assert.equal(fast.totalDistance / fast.movementSpeed! * 1000, 500);
  assert.equal(buildMovementVisual(plan, point(2), 'fractional', regions, 7.5)!.movementSpeed, 7.5);
  assert.equal(buildMovementVisual(plan, point(2), 'legacy', regions)!.movementSpeed, undefined);
  for (const invalid of [0, -1, NaN, Infinity]) assert.equal(buildMovementVisual(plan, point(2), 'invalid-speed', regions, invalid)!.movementSpeed, undefined);
});

test('movement capture is isolated between overlapping command/accounts and does not leak into later commands', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const visualA = buildMovementVisual(plan, point(2), 'account-a', regions)!;
  const visualB = { ...visualA, id: 'account-b' };
  const accountA = captureMovementVisual(async () => { await gate; recordMovementVisual(visualA); return 'a'; });
  const accountB = await captureMovementVisual(async () => { recordMovementVisual(visualB); return 'b'; });
  release();
  assert.equal((await accountA).movementVisual?.id, 'account-a');
  assert.equal(accountB.movementVisual?.id, 'account-b');
  assert.equal((await captureMovementVisual(async () => 'unrelated')).movementVisual, undefined);
  recordMovementVisual(visualA);
  assert.equal((await captureMovementVisual(async () => 'no ambient command')).movementVisual, undefined);
});

test('actual moveTo publishes only after commit and only for its confirmed short-distance landing', async () => {
  const source = readFileSync(new URL('../src/game/adventure.service.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export const moveTo ='), end = source.indexOf('/** 感知范围内的怪物可直接突进攻击', start);
  let committed = false, commitFails = false, actualX = 2;
  const publications: boolean[] = [];
  const db = { execute: async (sql: string) => {
    if (sql.startsWith('SELECT id FROM characters')) return [[{ id: 1 }]];
    if (sql.startsWith('SELECT r.id,r.code')) return [[{ id: 1, code: 'baina_town', name: '百纳镇', is_owner_only: 0, is_enabled: 1 }]];
    if (sql.includes('SELECT party_id FROM party_members')) return [[]];
    if (sql.startsWith('SELECT id,code,name FROM map_regions')) return [regions];
    assert.fail(sql);
  } };
  const service = load(source.slice(start, end), {
    inventory: async () => ({ movementSpeed: 4 }),
    withTransaction: async (work: (db: unknown) => Promise<unknown>) => { const result = await work(db); if (commitFails) throw Error('simulated transaction commit failure'); committed = true; return result; },
    characterFor: async () => ({ id: 1, pos_x: 0, pos_y: 0, pos_z: 0, current_region_id: 1, region_name: '百纳镇' }),
    repairInvalidCombatFor: async () => {}, isInHome: async () => false, assertNoNegotiation: async () => {}, assertOwnerOnlyRegionAccess: async () => {},
    planConnectedTravel: async () => structuredClone(plan),
    moveToPosition: async () => ({ kind: 'event', text: '已抵达', character: { pos_x: actualX, pos_y: 0, pos_z: 0, current_region_id: 1 } }),
    buildMovementVisual, localPositionFor: (row: any) => point(row.pos_x, row.pos_y, row.pos_z, row.current_region_id), randomUUID: () => 'committed-instant',
    recordMovementVisual: (visual: any) => { publications.push(committed); recordMovementVisual(visual); }
  });
  const success = await captureMovementVisual(() => service.moveTo('synthetic', 2, 0, 0));
  assert.equal(success.movementVisual?.id, 'committed-instant');
  assert.deepEqual(publications, [true]);
  assert.equal(success.result.movementVisual.totalDistance, 4);
  assert.equal(success.result.movementVisual.movementSpeed, 4, 'successful command transmits its actual effective movement speed');
  committed = false; commitFails = true;
  await assert.rejects(captureMovementVisual(() => service.moveTo('synthetic', 2, 0, 0)), /commit failure/);
  assert.deepEqual(publications, [true], 'rolled-back or failed commits publish no replay');
  commitFails = false; actualX = 1;
  const changed = await captureMovementVisual(() => service.moveTo('synthetic', 2, 0, 0));
  assert.equal(changed.movementVisual, undefined); assert.equal(changed.result.movementVisual, undefined);
});

test('actual Core bridge captures the committed movement and signed responses retain it', async () => {
  const source = readFileSync(new URL('../src/core-command-bridge.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export const executeCoreGameCommand =');
  const visual = buildMovementVisual(plan, point(2), 'core-instant', regions)!;
  const core = load(source.slice(start), {
    commandRouter: { dispatch: async () => { recordMovementVisual(visual); return { matched: true }; } },
    ensureWebNotificationInbox: async () => {}, captureMovementVisual,
    withEventContext: (_event: unknown, _next: unknown, work: () => Promise<unknown>) => work(), withCoreMessageCapture: (_capture: unknown, work: () => Promise<unknown>) => work()
  });
  const result = await core.executeCoreGameCommand({ actor: { provider: 'app', subject: 'synthetic' }, command: '/前往 2 0 0', source: 'message', requestId: 'test' });
  assert.equal(result.movementVisual.id, 'core-instant');
  const routerSource = readFileSync(new URL('../src/app-api/router.ts', import.meta.url), 'utf8');
  const first = routerSource.indexOf('const signedCoreResponse ='), last = routerSource.indexOf('/**', first);
  const signed = load(`${routerSource.slice(first, last)}\nexport { signedCoreResponse };`, {
    issueCoreInteractionActions: async () => ({ messages: [{ text: '已抵达', buttons: [] }], actions: [] })
  });
  assert.equal((await signed.signedCoreResponse({}, 'synthetic-token', '/前往 2 0 0', result)).movementVisual.id, 'core-instant');
});

test('actual signed interaction execute and HTTP response preserve movement replay on idempotent retries', async () => {
  const visual = buildMovementVisual(plan, point(2), 'issued-instant', regions)!;
  let executions = 0, release!: () => void, began!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  const bridgeSource = readFileSync(new URL('../src/core-command-bridge.ts', import.meta.url), 'utf8');
  const core = load(bridgeSource.slice(bridgeSource.indexOf('export const executeCoreGameCommand =')), {
    commandRouter: { dispatch: async (event: any) => {
      assert.equal(event.MessageText, '/前往 2 0 0');
      executions++; began(); await gate;
      recordMovementVisual(visual);
      return { matched: true };
    } },
    ensureWebNotificationInbox: async () => {}, captureMovementVisual,
    withEventContext: (_event: unknown, _next: unknown, work: () => Promise<unknown>) => work(),
    withCoreMessageCapture: (capture: any, work: () => Promise<unknown>) => { capture.formats.push([{ type: 'Text', value: '已抵达' }]); return work(); }
  });
  const presentationSource = readFileSync(new URL('../src/app-api/core-interaction-presentation.ts', import.meta.url), 'utf8');
  const presentation = load(presentationSource.slice(presentationSource.indexOf('export type CoreInteractionPresentation')), { openingHubs: {} });
  const serviceSource = readFileSync(new URL('../src/app-api/interaction-action.service.ts', import.meta.url), 'utf8');
  const actions = load(serviceSource.slice(serviceSource.indexOf('const ACTION_TTL_MS')), {
    createHash, randomBytes,
    executeCoreGameCommand: core.executeCoreGameCommand,
    listCoreCommandCatalog: () => [{ command: 'NPC对话' }],
    appSessionQqUser: async (session: any) => `synthetic_${session.playerId}`,
    formatValueToAppMessage: () => ({ text: '已抵达', buttons: [] }),
    coreInteractionPresentation: presentation.coreInteractionPresentation
  });
  const session = { playerId: 1, displayName: '合成玩家' }, token = 'synthetic-session-credential-1';
  const issued = await actions.issueCoreInteractionActions({
    session, sessionToken: token, originCommand: '/NPC对话 引路人',
    execution: { matched: true, formats: [[{ type: 'Button', value: '前往', options: { type: 'command', data: '/前往 2 0 0' } }]] }
  });
  assert.equal(issued.movementVisual, undefined);
  assert.equal(JSON.stringify(issued).includes('/前往'), false, 'the signed button still exposes no executable command');
  const button = issued.messages[0].buttons[0];
  const body = { actionId: button.actionId, revision: button.revision, idempotencyKey: 'same-movement-request' };
  const routerSource = readFileSync(new URL('../src/app-api/router.ts', import.meta.url), 'utf8');
  const start = routerSource.indexOf("  router.post(apiPath('/interactions/actions'),"), end = routerSource.indexOf("  router.get(apiPath('/panel'),", start);
  let handler!: (ctx: any) => Promise<void>;
  load(routerSource.slice(start, end), {
    router: { post: (_path: string, work: (ctx: any) => Promise<void>) => { handler = work; } }, apiPath: (path: string) => path,
    requireSession: async (ctx: any) => ctx.session, parseBody: async (ctx: any) => ctx.requestBody, bearer: (ctx: any) => ctx.token,
    apiPrefix: '/api/web/v1', executeIssuedCoreInteractionAction: actions.executeIssuedCoreInteractionAction,
    CoreInteractionActionError: actions.CoreInteractionActionError,
    apiError: (_ctx: unknown, _status: unknown, message: string) => assert.fail(message)
  });
  const first: any = { session, token, requestBody: body }, retry: any = { session, token, requestBody: body };
  const pending = handler(first); await started;
  const repeated = handler(retry);
  release(); await Promise.all([pending, repeated]);
  assert.equal(executions, 1);
  assert.equal(first.body.ok, true); assert.equal(first.body.presentation, 'page'); assert.equal(first.body.destination, 'explore');
  assert.deepEqual(first.body.movementVisual, visual);
  assert.deepEqual(retry.body.movementVisual, visual, 'retries reuse the same committed replay identifier');
  assert.equal(JSON.stringify(first.body).includes('/前往'), false);
  const otherAccount: any = { session: { ...session, playerId: 2 }, token: 'synthetic-session-credential-2', requestBody: body };
  await handler(otherAccount);
  assert.equal(otherAccount.status, 403); assert.equal(otherAccount.body.code, 'invalid_action');
  assert.equal(otherAccount.body.movementVisual, undefined);
  const differentKey: any = { session, token, requestBody: { ...body, idempotencyKey: 'different-request' } };
  await handler(differentKey);
  assert.equal(differentKey.status, 409); assert.equal(differentKey.body.code, 'used_action');
  assert.equal(executions, 1, 'neither a different retry key nor another account can execute the move again');
});

test('App coordinate/map command helpers retain movement metadata without changing their command text', async () => {
  const source = readFileSync(new URL('../src/app-api/app-command.service.ts', import.meta.url), 'utf8');
  const mapStart = source.indexOf('const mapTravelText ='), mapEnd = source.indexOf('/**', mapStart);
  const coordinateStart = source.indexOf('const moveToCoordinateText ='), coordinateEnd = source.indexOf('const moveToNearbyMonsterText =', coordinateStart);
  const visual = buildMovementVisual(plan, point(2), 'app-instant', regions)!;
  const helpers = load(`${source.slice(mapStart, mapEnd)}\n${source.slice(coordinateStart, coordinateEnd)}\nexport { mapTravelText, moveToCoordinateText };`, {
    moveTo: async () => ({ kind: 'event', text: '真实移动结果', movementVisual: visual }),
    moveToMap: async () => ({ kind: 'event', text: '真实地图移动结果', movementVisual: visual }),
    plainAppMessage: (text: string, buttons: unknown[], petReply: string) => ({ text, buttons, petReply })
  });
  const coordinate = await helpers.moveToCoordinateText('synthetic', 2, 0, 0);
  assert.equal(coordinate.text, '真实移动结果'); assert.equal(coordinate.movementVisual.id, 'app-instant');
  const map = await helpers.mapTravelText('synthetic', 'map-code');
  assert.equal(map.text, '真实地图移动结果'); assert.equal(map.movementVisual.id, 'app-instant');
});

test('direct /explore/travel instant results contain the same committed replay and authoritative landing', async () => {
  const source = readFileSync(new URL('../src/app-api/router.ts', import.meta.url), 'utf8');
  const start = source.indexOf("  router.post(apiPath('/explore/travel'),"), end = source.indexOf('  /** H5 行程面板', start);
  const visual = buildMovementVisual(plan, point(2), 'direct-instant', regions)!;
  let handler!: (ctx: any) => Promise<void>;
  load(source.slice(start, end), {
    router: { post: (_path: string, work: (ctx: any) => Promise<void>) => { handler = work; } }, apiPath: (path: string) => path,
    requireSession: async () => ({}), appSessionQqUser: async () => 'synthetic', parseBody: async () => ({ x: 2, y: 0, z: 0 }),
    require: () => ({
      moveTo: async () => ({ kind: 'event', text: '已抵达', character: { pos_x: 2, pos_y: 0, pos_z: 0, current_region_id: 1 }, movementVisual: visual }),
      travelStatus: async () => assert.fail('an instant result has no timed travel')
    }),
    appQuickPanel: async () => null, apiError: (_ctx: unknown, _status: unknown, message: string) => assert.fail(message)
  });
  const ctx: any = {};
  await handler(ctx);
  assert.equal(ctx.body.kind, 'event'); assert.equal(ctx.body.remaining, 0);
  assert.deepEqual(ctx.body.position, point(2)); assert.equal(ctx.body.movementVisual.id, 'direct-instant');
  assert.equal(ctx.body.travel, undefined);
});
