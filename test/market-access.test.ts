import assert from 'node:assert/strict';
import { test } from 'node:test';
import { marketEligibilityReason } from '../src/game/market.service';
import { marketRemoteStoryReason } from '../src/app-api/market.service';

test('remote market access keeps the existing character and story gates', () => {
  const oldEnough = new Date(Date.now() - 73 * 60 * 60_000);
  const tooNew = new Date(Date.now() - 71 * 60 * 60_000);
  assert.match(marketEligibilityReason(undefined) ?? '', /注册角色/);
  assert.match(marketEligibilityReason({ level: 9, adventurer_registered: 1, created_at: oldEnough }) ?? '', /10 级/);
  assert.match(marketEligibilityReason({ level: Number.NaN, adventurer_registered: 1, created_at: oldEnough }) ?? '', /10 级/);
  assert.match(marketEligibilityReason({ level: 10, adventurer_registered: 0, created_at: oldEnough }) ?? '', /已登记/);
  assert.match(marketEligibilityReason({ level: 10, adventurer_registered: 1, created_at: tooNew }) ?? '', /72 小时/);
  assert.equal(marketEligibilityReason({ level: 10, adventurer_registered: 1, created_at: oldEnough }), null);
  assert.match(marketRemoteStoryReason(5) ?? '', /谢礼之约/);
  assert.equal(marketRemoteStoryReason(6), null);
});
