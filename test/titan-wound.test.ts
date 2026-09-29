import test from 'node:test';
import assert from 'node:assert/strict';
import { deferTitanWoundTick, enqueueTitanWound, flushTitanWounds, settleTitanWound, titanWoundSchedule } from '../src/game/titan-wound';

test('一击按未来三个自身行动分摊，余数从第一跳扣除', () => {
  let cooldowns = enqueueTitanWound({}, 10, 4).cooldowns;
  assert.deepEqual(titanWoundSchedule(cooldowns), [{ turn: 5, amount: 4 }, { turn: 6, amount: 3 }, { turn: 7, amount: 3 }]);
  let hp = 20;
  for (const [turn, expectedLoss] of [[5, 4], [6, 3], [7, 3]]) {
    const result = settleTitanWound(cooldowns, turn, hp, 20);
    assert.equal(result.loss, expectedLoss);
    cooldowns = result.cooldowns; hp = result.hp;
  }
  assert.equal(hp, 10);
  assert.deepEqual(titanWoundSchedule(cooldowns), []);
});

test('连续受伤合并到期额度，额外行动同一回合不会重复扣血', () => {
  let cooldowns = enqueueTitanWound({}, 9, 2).cooldowns;
  cooldowns = enqueueTitanWound(cooldowns, 6, 2).cooldowns;
  assert.deepEqual(titanWoundSchedule(cooldowns), [{ turn: 3, amount: 5 }, { turn: 4, amount: 5 }, { turn: 5, amount: 5 }]);
  const first = settleTitanWound(cooldowns, 3, 30, 30);
  assert.equal(first.hp, 25);
  const bonusAction = settleTitanWound(first.cooldowns, 3, first.hp, 30);
  assert.equal(bonusAction.loss, 0);
  assert.equal(bonusAction.hp, 25);
});

test('缓伤只将下一跳的小部分后移，三回合伤势总额不变', () => {
  let cooldowns = deferTitanWoundTick(enqueueTitanWound({}, 30, 1).cooldowns, 2);
  const first = settleTitanWound(cooldowns, 2, 100, 100);
  assert.equal(first.loss, 9);
  assert.equal(first.deferred, 1);
  assert.equal(first.pending, 21);
  cooldowns = first.cooldowns;
  const second = settleTitanWound(cooldowns, 3, first.hp, 100);
  assert.equal(second.loss, 11);
  const third = settleTitanWound(second.cooldowns, 4, second.hp, 100);
  assert.equal(third.loss, 10);
  assert.equal(third.hp, 70);
});

test('治疗不清除队列；战斗结束结清余额并删除战斗状态', () => {
  const cooldowns = enqueueTitanWound({}, 18, 1).cooldowns;
  const first = settleTitanWound(cooldowns, 2, 20, 30);
  assert.equal(first.hp, 14);
  const healedHp = 24;
  const exit = flushTitanWounds(first.cooldowns, healedHp, 30);
  assert.equal(exit.loss, 12);
  assert.equal(exit.hp, 12);
  assert.equal('titanWounds' in exit.cooldowns, false);
});

test('完全被护盾吸收时没有伤势；到期 HP 流失可以致死', () => {
  const zero = enqueueTitanWound({}, 0, 1);
  assert.equal(zero.queued, 0);
  assert.deepEqual(titanWoundSchedule(zero.cooldowns), []);
  const queued = enqueueTitanWound({}, 6, 1);
  const result = settleTitanWound(queued.cooldowns, 2, 1, 10);
  assert.equal(result.loss, 2);
  assert.equal(result.hp, 0);
  assert.equal(result.defeated, true);
});
