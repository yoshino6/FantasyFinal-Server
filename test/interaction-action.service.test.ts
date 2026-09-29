import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CoreRouteExecution } from '../src/core-command-bridge';
import type { AppSession } from '../src/game/app-channel.service';
import { createCoreInteractionActionService, CoreInteractionActionError } from '../src/app-api/interaction-action.service';

const session = (playerId: number): AppSession => ({
  loginId: `H-${playerId}`,
  gameUserId: String(10_000_000 + playerId),
  displayName: `玩家${playerId}`,
  passwordLoginEnabled: true,
  playerId,
  characterId: playerId
});

const result = (...buttons: Array<{ label: string; command: string }>): CoreRouteExecution => ({
  matched: true,
  result: { matched: true },
  formats: [[
    { type: 'Markdown', value: [{ type: 'MD.text', value: '请选择后续操作。' }] },
    { type: 'BT.group', value: [{ type: 'BT.row', value: buttons.map(button => ({
      type: 'Button', value: button.label, options: { type: 'command', data: button.command, autoEnter: true }
    })) }] }
  ]]
});

const assertCode = (code: CoreInteractionActionError['code']) => (error: unknown): boolean =>
  error instanceof CoreInteractionActionError && error.code === code;

test('only a public Core result can issue opaque buttons, without exposing commands', async () => {
  const service = createCoreInteractionActionService({
    resolveQqUser: async s => `app_${s.playerId}`,
    publicCoreCommands: () => [{ command: 'NPC对话' }]
  });
  const execution = result({ label: '继续', command: '/隐藏剧情 下一步' }, { label: '待填写', command: '/确认注销 ' });
  await assert.rejects(service.issue({ session: session(1), sessionToken: 'session-credential-1', originCommand: '/隐藏剧情', execution }), assertCode('invalid_action'));
  const issued = await service.issue({ session: session(1), sessionToken: 'session-credential-1', originCommand: '/NPC对话 梨子喵', execution });
  assert.equal(issued.messages[0]?.buttons.length, 1);
  assert.equal(issued.messages[0]?.buttons[0]?.label, '继续');
  assert.equal(JSON.stringify(issued).includes('隐藏剧情'), false);
  assert.equal(JSON.stringify(issued).includes('确认注销'), false);
});

test('web market writes are not issued as Core buttons or executed through an old action', async () => {
  let executions = 0;
  const service = createCoreInteractionActionService({
    resolveQqUser: async s => `app_${s.playerId}`,
    publicCoreCommands: () => [{ command: '万叶订单' }],
    executeCore: async () => { executions++; return result(); }
  });
  const execution = result({ label: '撤销订单', command: '/万叶撤单 7' }, { label: '刷新', command: '/万叶订单' });
  const web = await service.issue({ session: session(1), sessionToken: 'session-credential-1', originCommand: '/万叶订单', execution, blockWebProtectedWrites: true });
  assert.deepEqual(web.messages[0]?.buttons.map(button => button.label), ['刷新']);

  const older = await service.issue({ session: session(1), sessionToken: 'session-credential-1', originCommand: '/万叶订单', execution });
  const cancel = older.messages[0]!.buttons[0]!;
  await assert.rejects(service.execute({ session: session(1), sessionToken: 'session-credential-1', actionId: cancel.actionId,
    revision: cancel.revision, idempotencyKey: 'request-market-1', blockWebProtectedWrites: true }), assertCode('invalid_action'));
  assert.equal(executions, 0);
});

test('web skill writes require the dedicated preview even for previously issued buttons', async () => {
  let executions = 0;
  const service = createCoreInteractionActionService({
    resolveQqUser: async s => `app_${s.playerId}`,
    publicCoreCommands: () => [{ command: '技能详情' }],
    executeCore: async () => { executions++; return result(); }
  });
  const execution = result({ label: '升级', command: '/升级专精 8 强效' }, { label: '返回', command: '/技能列表 已学习' });
  const web = await service.issue({ session: session(1), sessionToken: 'session-credential-1', originCommand: '/技能详情 8', execution, blockWebProtectedWrites: true });
  assert.deepEqual(web.messages[0]?.buttons.map(button => button.label), ['返回']);
  const older = await service.issue({ session: session(1), sessionToken: 'session-credential-1', originCommand: '/技能详情 8', execution });
  const upgrade = older.messages[0]!.buttons[0]!;
  await assert.rejects(service.execute({ session: session(1), sessionToken: 'session-credential-1', actionId: upgrade.actionId,
    revision: upgrade.revision, idempotencyKey: 'request-skill-1', blockWebProtectedWrites: true }), assertCode('invalid_action'));
  assert.equal(executions, 0);
});

test('web bank writes are hidden and old signed bank actions cannot bypass the quote', async () => {
  let executions = 0;
  const service = createCoreInteractionActionService({
    resolveQqUser: async s => `app_${s.playerId}`,
    publicCoreCommands: () => [{ command: '钱庄' }],
    executeCore: async () => { executions++; return result(); }
  });
  const execution = result({ label: '提前支取', command: '/钱庄提前支取 7' }, { label: '查看钱庄', command: '/钱庄' });
  const web = await service.issue({ session: session(1), sessionToken: 'session-credential-1', originCommand: '/钱庄', execution, blockWebProtectedWrites: true });
  assert.deepEqual(web.messages[0]?.buttons.map(button => button.label), ['查看钱庄']);
  const older = await service.issue({ session: session(1), sessionToken: 'session-credential-1', originCommand: '/钱庄', execution });
  const early = older.messages[0]!.buttons[0]!;
  await assert.rejects(service.execute({ session: session(1), sessionToken: 'session-credential-1', actionId: early.actionId,
    revision: early.revision, idempotencyKey: 'request-bank-1', blockWebProtectedWrites: true }), assertCode('invalid_action'));
  assert.equal(executions, 0);
});

test('web home overview keeps read buttons but cannot issue or execute home mutations', async () => {
  let executions = 0;
  const service = createCoreInteractionActionService({
    resolveQqUser: async s => `app_${s.playerId}`,
    publicCoreCommands: () => [{ command: '家园' }],
    executeCore: async () => { executions++; return result(); }
  });
  const execution = result({ label: '制作', command: '/家园制作 wooden_bed 1' }, { label: '制作清单', command: '/家园制作清单 1' });
  const web = await service.issue({ session: session(1), sessionToken: 'session-credential-1', originCommand: '/家园', execution, blockWebProtectedWrites: true });
  assert.deepEqual(web.messages[0]?.buttons.map(button => button.label), ['制作清单']);
  const older = await service.issue({ session: session(1), sessionToken: 'session-credential-1', originCommand: '/家园', execution });
  const craft = older.messages[0]!.buttons[0]!;
  await assert.rejects(service.execute({ session: session(1), sessionToken: 'session-credential-1', actionId: craft.actionId,
    revision: craft.revision, idempotencyKey: 'request-home-1', blockWebProtectedWrites: true }), assertCode('invalid_action'));
  assert.equal(executions, 0);
});

test('web home storage transfer requires the dedicated quote even for old signed buttons', async () => {
  let executions = 0;
  const service = createCoreInteractionActionService({
    resolveQqUser: async s => `app_${s.playerId}`,
    publicCoreCommands: () => [{ command: '家园储物' }],
    executeCore: async () => { executions++; return result(); }
  });
  const execution = result({ label: '放入', command: '/家园放入 3 2' },
    { label: '取出', command: '/家园取出 3 2' },
    { label: '查看', command: '/家园储物 仓储 材料' });
  const web = await service.issue({ session: session(1), sessionToken: 'session-credential-1',
    originCommand: '/家园储物 仓储 材料', execution, blockWebProtectedWrites: true });
  assert.deepEqual(web.messages[0]?.buttons.map(button => button.label), ['查看']);
  const older = await service.issue({ session: session(1), sessionToken: 'session-credential-1',
    originCommand: '/家园储物 仓储 材料', execution });
  for (const [index, key] of [[0, 'request-storage-in'], [1, 'request-storage-out']] as const) {
    const action = older.messages[0]!.buttons[index]!;
    await assert.rejects(service.execute({ session: session(1), sessionToken: 'session-credential-1',
      actionId: action.actionId, revision: action.revision, idempotencyKey: key,
      blockWebProtectedWrites: true }), assertCode('invalid_action'));
  }
  assert.equal(executions, 0);
});

test('web guild shop trades use the durable quote instead of old Core buttons', async () => {
  let executions = 0;
  const service = createCoreInteractionActionService({
    resolveQqUser: async s => `app_${s.playerId}`,
    publicCoreCommands: () => [{ command: '工会商店' }],
    executeCore: async () => { executions++; return result(); }
  });
  const execution = result({ label: '购买', command: '/购买商品 3 2' }, { label: '货架', command: '/商店购买' });
  const web = await service.issue({ session: session(1), sessionToken: 'session-credential-1', originCommand: '/工会商店', execution, blockWebProtectedWrites: true });
  assert.deepEqual(web.messages[0]?.buttons.map(button => button.label), ['货架']);
  const older = await service.issue({ session: session(1), sessionToken: 'session-credential-1', originCommand: '/工会商店', execution });
  const buy = older.messages[0]!.buttons[0]!;
  await assert.rejects(service.execute({ session: session(1), sessionToken: 'session-credential-1', actionId: buy.actionId,
    revision: buy.revision, idempotencyKey: 'request-shop-1', blockWebProtectedWrites: true }), assertCode('invalid_action'));
  assert.equal(executions, 0);
});

test('web bookshop trades cannot use old signed Core buttons', async () => {
  let executions = 0;
  const service = createCoreInteractionActionService({
    resolveQqUser: async s => `app_${s.playerId}`,
    publicCoreCommands: () => [{ command: '百味书屋' }],
    executeCore: async () => { executions++; return result(); }
  });
  const execution = result({ label: '购买', command: '/购买书屋物品 3 2' },
    { label: '出售', command: '/出售书屋物品 5 1' },
    { label: '货架', command: '/书屋购买' });
  const web = await service.issue({ session: session(1), sessionToken: 'session-credential-1',
    originCommand: '/百味书屋', execution, blockWebProtectedWrites: true });
  assert.deepEqual(web.messages[0]?.buttons.map(button => button.label), ['货架']);
  const older = await service.issue({ session: session(1), sessionToken: 'session-credential-1', originCommand: '/百味书屋', execution });
  for (const [index, key] of [[0, 'request-bookshop-buy'], [1, 'request-bookshop-sell']] as const) {
    const action = older.messages[0]!.buttons[index]!;
    await assert.rejects(service.execute({ session: session(1), sessionToken: 'session-credential-1',
      actionId: action.actionId, revision: action.revision, idempotencyKey: key, blockWebProtectedWrites: true }), assertCode('invalid_action'));
  }
  assert.equal(executions, 0);
});

test('web home purchase and 百纳居 exchange require durable quotes, including old signed buttons', async () => {
  let executions = 0;
  const service = createCoreInteractionActionService({
    resolveQqUser: async s => `app_${s.playerId}`,
    publicCoreCommands: () => [{ command: '百纳居' }],
    executeCore: async () => { executions++; return result(); }
  });
  const execution = result({ label: '购房', command: '/家园购买' },
    { label: '兑换', command: '/百纳居交易 2 3' },
    { label: '货架', command: '/百纳居' });
  const web = await service.issue({ session: session(1), sessionToken: 'session-credential-1',
    originCommand: '/百纳居', execution, blockWebProtectedWrites: true });
  assert.deepEqual(web.messages[0]?.buttons.map(button => button.label), ['货架']);
  const older = await service.issue({ session: session(1), sessionToken: 'session-credential-1', originCommand: '/百纳居', execution });
  for (const [index, key] of [[0, 'request-home-buy'], [1, 'request-home-shop']] as const) {
    const action = older.messages[0]!.buttons[index]!;
    await assert.rejects(service.execute({ session: session(1), sessionToken: 'session-credential-1',
      actionId: action.actionId, revision: action.revision, idempotencyKey: key, blockWebProtectedWrites: true }), assertCode('invalid_action'));
  }
  assert.equal(executions, 0);
});

test('web evolution mutations and unsupported injections cannot use old signed Core buttons', async () => {
  let executions = 0;
  const service = createCoreInteractionActionService({
    resolveQqUser: async s => `app_${s.playerId}`,
    publicCoreCommands: () => [{ command: '进化研究室' }],
    executeCore: async () => { executions++; return result(); }
  });
  const execution = result({ label: '暂停', command: '/进化变异操作 5 pause' },
    { label: '注射', command: '/进化注射 conservative' },
    { label: '档案', command: '/进化变异' });
  const web = await service.issue({ session: session(1), sessionToken: 'session-credential-1',
    originCommand: '/进化研究室', execution, blockWebProtectedWrites: true });
  assert.deepEqual(web.messages[0]?.buttons.map(button => button.label), ['档案']);
  const older = await service.issue({ session: session(1), sessionToken: 'session-credential-1', originCommand: '/进化研究室', execution });
  for (const [index, key] of [[0, 'request-evolution-toggle'], [1, 'request-evolution-inject']] as const) {
    const action = older.messages[0]!.buttons[index]!;
    await assert.rejects(service.execute({ session: session(1), sessionToken: 'session-credential-1',
      actionId: action.actionId, revision: action.revision, idempotencyKey: key, blockWebProtectedWrites: true }), assertCode('invalid_action'));
  }
  assert.equal(executions, 0);
});

test('web advanced profession quest and trial writes cannot use old signed Core buttons', async () => {
  let executions = 0;
  const service = createCoreInteractionActionService({
    resolveQqUser: async s => `app_${s.playerId}`,
    publicCoreCommands: () => [{ command: '二转导师' }],
    executeCore: async () => { executions++; return result(); }
  });
  const execution = result({ label: '接取', command: '/接受二转 war_lord' },
    { label: '切换任务', command: '/确认切换二转 elementalist' },
    { label: '提交见闻', command: '/推进二转 war_lord' },
    { label: '提交凭证', command: '/提交二转凭证 war_lord' },
    { label: '导师试炼', command: '/开启导师试炼 war_lord' },
    { label: '职业说明', command: '/二转职业 mentor_warlord' });
  const web = await service.issue({ session: session(1), sessionToken: 'session-credential-1',
    originCommand: '/二转导师 mentor_warlord', execution, blockWebProtectedWrites: true });
  assert.deepEqual(web.messages[0]?.buttons.map(button => button.label), ['职业说明']);
  const older = await service.issue({ session: session(1), sessionToken: 'session-credential-1',
    originCommand: '/二转导师 mentor_warlord', execution });
  for (let index = 0; index < 5; index++) {
    const action = older.messages[0]!.buttons[index]!;
    await assert.rejects(service.execute({ session: session(1), sessionToken: 'session-credential-1',
      actionId: action.actionId, revision: action.revision, idempotencyKey: `request-advanced-${index}`,
      blockWebProtectedWrites: true }), assertCode('invalid_action'));
  }
  assert.equal(executions, 0);
});

test('session, player, revision and expiry are checked before execution', async () => {
  let now = 100_000;
  let executions = 0;
  const service = createCoreInteractionActionService({
    now: () => now,
    resolveQqUser: async s => `app_${s.playerId}`,
    publicCoreCommands: () => [{ command: 'NPC对话' }],
    executeCore: async () => { executions++; return result(); }
  });
  const issued = await service.issue({ session: session(1), sessionToken: 'session-credential-1', originCommand: '/NPC对话 梨子喵', execution: result({ label: '继续', command: '/隐藏剧情 下一步' }) });
  const button = issued.messages[0]!.buttons[0]!;
  const submit = { actionId: button.actionId, revision: button.revision, idempotencyKey: 'request-1' };
  await assert.rejects(service.execute({ ...submit, session: session(2), sessionToken: 'session-credential-1' }), assertCode('invalid_action'));
  await assert.rejects(service.execute({ ...submit, session: session(1), sessionToken: 'session-credential-2' }), assertCode('invalid_action'));
  await assert.rejects(service.execute({ ...submit, revision: 'tampered', session: session(1), sessionToken: 'session-credential-1' }), assertCode('invalid_action'));
  assert.equal(executions, 0);
  now += 2 * 60_000 + 1;
  await assert.rejects(service.execute({ ...submit, session: session(1), sessionToken: 'session-credential-1' }), assertCode('expired_action'));
  assert.equal(executions, 0);
});

test('one choice executes once and a matching retry receives the same result', async () => {
  let executions = 0;
  let release: (() => void) | undefined;
  const waitForCore = new Promise<void>(resolve => { release = resolve; });
  const service = createCoreInteractionActionService({
    resolveQqUser: async s => `app_${s.playerId}`,
    publicCoreCommands: () => [{ command: 'NPC对话' }],
    executeCore: async request => {
      executions++;
      assert.equal(request.command, '/隐藏剧情 选一');
      assert.equal(request.source, 'interaction');
      await waitForCore;
      return result({ label: '再继续', command: '/隐藏剧情 结束' });
    }
  });
  const issued = await service.issue({
    session: session(1), sessionToken: 'session-credential-1', originCommand: '/NPC对话 梨子喵',
    execution: result({ label: '选一', command: '/隐藏剧情 选一' }, { label: '选二', command: '/隐藏剧情 选二' })
  });
  const [first, second] = issued.messages[0]!.buttons;
  const submit = { session: session(1), sessionToken: 'session-credential-1', actionId: first!.actionId, revision: first!.revision, idempotencyKey: 'request-1' };
  const pending = service.execute(submit);
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(service.execute({ ...submit, actionId: second!.actionId }), assertCode('stale_action'));
  await assert.rejects(service.execute({ ...submit, idempotencyKey: 'request-2' }), assertCode('used_action'));
  const retry = service.execute(submit);
  release?.();
  const [completed, repeated] = await Promise.all([pending, retry]);
  assert.deepEqual(repeated, completed);
  assert.equal(executions, 1);
  assert.equal(completed.messages[0]?.buttons[0]?.label, '再继续');
  assert.equal(JSON.stringify(completed).includes('隐藏剧情'), false);
});
