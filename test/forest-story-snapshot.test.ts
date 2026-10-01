import assert from 'node:assert/strict';
import test from 'node:test';
import { forestGuideSnapshotFor } from '../src/game/adventure.service';
import { forestArrivalTownScenes, forestArrivalGuildScenes } from '../src/game/forest-arrival-content';
import { pendingAppStory } from '../src/app-api/app-command.service';

test('registration and active battle metadata return without reading or advancing a character story', async () => {
  assert.deepEqual(await pendingAppStory('metadata-only', false), { command: '/注册', revision: 'registration' });
  assert.equal(await pendingAppStory('metadata-only', true, true), undefined);
});

test('restoring an arrival page preserves the committed stage and current text', () => {
  for (const [status, scenes, chapter] of [
    ['arrival_story', forestArrivalTownScenes, 'town'],
    ['guild_story', forestArrivalGuildScenes, 'guild']
  ] as const) {
    for (const [key, text] of Object.entries(scenes)) {
      const progress = { status, stage: Number(key) };
      const before = { ...progress };
      const first = forestGuideSnapshotFor(progress);
      assert.deepEqual(first, { ...before, text, chapter });
      assert.deepEqual(forestGuideSnapshotFor(progress), first);
      assert.deepEqual(progress, before);
    }
  }
});

test('waiting for arrival stays before town entry until the player continues', () => {
  const progress = { status: 'awaiting_arrival', stage: 5 };
  const snapshot = forestGuideSnapshotFor(progress);
  assert.equal(snapshot?.status, 'awaiting_arrival');
  assert.equal(snapshot?.stage, 5);
  assert.equal(snapshot?.chapter, 'town');
  assert.match(snapshot?.text ?? '', /前往百纳镇/);
});

test('forest meeting pages resume and battle or completed stages create no reading dialog', () => {
  for (let stage = 1; stage <= 4; stage++) {
    const snapshot = forestGuideSnapshotFor({ status: 'met', stage });
    assert.equal(snapshot?.stage, stage);
    assert.equal(snapshot?.chapter, 'forest');
    assert.ok(snapshot?.text);
  }
  for (const status of ['joined', 'declined', 'completed']) {
    assert.equal(forestGuideSnapshotFor({ status, stage: 3 }), null);
  }
  assert.equal(forestGuideSnapshotFor(null), null);
  assert.equal(forestGuideSnapshotFor({ status: 'arrival_story', stage: 999 }), null);
});
