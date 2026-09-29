import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceSwordShadowChain, swordShadowComboChance, swordShadowCopyCount } from '../src/game/sword-shadow-combo';

test('连击概率按速度、命中和连影计算，并受上下限限制', () => {
  assert.equal(swordShadowComboChance(0, 0, 0), .05);
  assert.equal(swordShadowComboChance(100, 20, 2), .26);
  assert.equal(swordShadowComboChance(1000, 1000, 5), .35);
});

test('持鞘只增加一次复制，剑刃风暴最多复制一次', () => {
  assert.equal(swordShadowCopyCount(false, false, 1, 0, 0, 0), 0);
  assert.equal(swordShadowCopyCount(true, false, 1, 0, 0, 0), 1);
  assert.equal(swordShadowCopyCount(true, false, 0, 1000, 1000, 5), 2);
  assert.equal(swordShadowCopyCount(true, true, 0, 1000, 1000, 5), 1);
});

test('命中叠连影，转火损一层，未命中保留剩余层，超窗清空', () => {
  const first = advanceSwordShadowChain({ stacks: 0, targetId: null, lastTurn: 0 }, 1, 1, true);
  const second = advanceSwordShadowChain(first, 1, 2, true);
  const switched = advanceSwordShadowChain(second, 2, 3, true);
  assert.equal(switched.stacks, 2);
  assert.equal(switched.switched, true);
  const missed = advanceSwordShadowChain(switched, 2, 4, false);
  assert.equal(missed.stacks, 1);
  assert.equal(missed.missPreserved, true);
  assert.equal(advanceSwordShadowChain(missed, 2, 7, true).stacks, 1);
});
