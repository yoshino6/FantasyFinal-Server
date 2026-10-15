import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

test('grid movement preserves opening and both town tour gates without advancing state', async () => {
  let opening: any = null, leaf: any = null, tree: any = null;
  const modules: Record<string, unknown> = {
    '../game/opening.service': { openingStatus: async () => opening },
    '../game/floating-leaf.service': { floatingTourState: async () => leaf },
    '../game/worldtree-witness.service': { worldtreeWitnessState: async () => tree }
  };
  const loaded = { exports: {} as any };
  const compiled = transformSync(readFileSync(new URL('../src/app-api/movement-story.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  new Function('require', 'module', 'exports', compiled)((name: string) => modules[name] ?? assert.fail(name), loaded, loaded.exports);
  const check = loaded.exports.appMovementNeedsStory;
  for (const route of ['F01','F02','F03','M01','M02','S03','A01']) {
    opening = { route, state: 'armed' }; assert.equal(await check('player'), true);
    opening.state = 'completed'; assert.equal(await check('player'), false);
  }
  for (const stage of [0,1,2,3,4,5,6]) {
    leaf = { stage, ready: true, atGuild: true };
    assert.equal(await check('player'), stage < 6);
    leaf = null; tree = { tour: stage, ready: true, atGuild: true };
    assert.equal(await check('player'), stage < 6); tree = null;
  }
  leaf = { stage: 0, ready: false, atGuild: true }; assert.equal(await check('player'), false);
  leaf = { stage: 0, ready: true, atGuild: false }; assert.equal(await check('player'), false);
});
