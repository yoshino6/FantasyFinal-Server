import test from 'node:test';
import assert from 'node:assert/strict';
import { redeemThiefReservation } from '../src/game/thief-loot-ledger';

test('无最终合法掉落时不能凭空兑现', () => {
  const result = redeemThiefReservation([{ code: 'boss_core', quantity: 1 }], new Set(['common_herb']));
  assert.equal(result.stolen, null);
  assert.deepEqual(result.remaining, [{ code: 'boss_core', quantity: 1 }]);
});

test('每次预占从真实最终包扣一件，总量不增加', () => {
  const pack = [{ code: 'common_herb', quantity: 2 }, { code: 'copper_coin', quantity: 4 }];
  const first = redeemThiefReservation(pack, new Set(['common_herb']));
  assert.deepEqual(first.stolen, { code: 'common_herb', quantity: 1 });
  assert.equal(first.remaining.find(drop => drop.code === 'common_herb')?.quantity, 1);
  assert.deepEqual(pack[0], { code: 'common_herb', quantity: 2 });
  const second = redeemThiefReservation(first.remaining, new Set(['common_herb']));
  assert.equal(second.remaining.some(drop => drop.code === 'common_herb'), false);
  assert.equal(second.remaining.reduce((sum, drop) => sum + drop.quantity, 0) + first.stolen!.quantity + second.stolen!.quantity, 6);
});
