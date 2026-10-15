import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'mysql2/promise';
import { socialAffinityProgress, socialIdentities, socialIdentityFromCharacter } from '../src/app-api/social-presentation';

const character = { gender: '女', level: 30, profession_code: 'mage', profession_name: '法师', advanced_profession_code: null as string | null };

test('social portrait follows committed profession and gender, including advanced equipment artwork', () => {
  assert.deepEqual(socialIdentityFromCharacter(character), { gender: '女', level: 30, profession: '法师', portrait: { baseKey: 'profession_mage_female', poseKey: 'standing_mage' } });
  assert.deepEqual(socialIdentityFromCharacter({ ...character, advanced_profession_code: 'elementalist' }), { gender: '女', level: 30, profession: '元素使', portrait: { baseKey: 'advanced_elementalist_female', poseKey: 'standing_elementalist', fallbackKey: 'profession_mage_female' } });
  assert.equal(socialIdentityFromCharacter({ ...character, gender: '男', profession_code: 'archer' }).portrait?.baseKey, 'profession_archer_male');
});

test('missing identity does not invent a gender, character or online status', () => {
  assert.deepEqual(socialIdentityFromCharacter({ ...character, gender: null }), { level: 30, profession: '法师' });
  assert.deepEqual(socialIdentityFromCharacter({ gender: '未公开', level: 0, profession_code: null, profession_name: null, advanced_profession_code: null }), {});
  assert.deepEqual(socialIdentityFromCharacter({ ...character, level: NaN, profession_code: 'unknown', advanced_profession_code: 'not-a-real-profession' }).portrait, { baseKey: 'player_female_initial', poseKey: 'standing_initial' });
  assert.equal('online' in socialIdentityFromCharacter(character), false);
});

test('progress retains actual relationship boundaries and the final stage without a fabricated cap', () => {
  assert.deepEqual(socialAffinityProgress({ min: 100, nextMin: 300, toNext: 57, title: '熟悉' }), { min: 100, nextMin: 300, toNext: 57 });
  assert.deepEqual(socialAffinityProgress({ min: 600, nextMin: null, toNext: 0 }), { min: 600, nextMin: null, toNext: 0 });
  for (const invalid of [null, '知己', {}, { min: 1, nextMin: undefined, toNext: 2 }, { min: Infinity, nextMin: 3, toNext: 2 }]) assert.equal(socialAffinityProgress(invalid), undefined);
});

test('authorized identity lookup deduplicates, binds and batches IDs and performs SELECT only', async () => {
  const calls: { sql: string; values: number[] }[] = [];
  const db = { execute: async (sql: string, values: number[]) => {
    calls.push({ sql, values });
    return [values.filter(value => value !== 109).map(value => ({ ...character, id: value + 5000, game_id: value }))];
  } } as unknown as Pool;
  const ids = Array.from({ length: 205 }, (_, index) => index + 1);
  const identities = await socialIdentities(db, [...ids, 1, 2, 0, -1, NaN, Infinity, 1.5]);
  assert.deepEqual(calls.map(call => call.values.length), [100, 100, 5]);
  assert.deepEqual(calls.flatMap(call => call.values), ids);
  for (const call of calls) {
    assert.match(call.sql, /^SELECT /);
    assert.match(call.sql, /WHERE c\.game_id IN \(/);
    assert.match(call.sql, /c\.npc_code IS NULL/);
    assert.equal((call.sql.match(/\?/g) ?? []).length, call.values.length);
  }
  assert.equal(identities.size, 204);
  assert.equal(identities.has(109), false);
  assert.equal(identities.get(205)?.portrait?.baseKey, 'profession_mage_female');
  await socialIdentities(db, [0, -1, NaN]);
  assert.equal(calls.length, 3, 'empty valid-ID set must not query all characters');
});

test('chat uses actual character IDs rather than player IDs or parsed channel names', async () => {
  const db = { execute: async (sql: string, values: number[]) => {
    assert.match(sql, /WHERE c\.id IN \(\?\)/);
    assert.deepEqual(values, [912]);
    return [[{ ...character, id: 912, game_id: 16382 }]];
  } } as unknown as Pool;
  const identities = await socialIdentities(db, [912], 'id');
  assert.equal(identities.has(912), true);
  assert.equal(identities.has(16382), false);
});
