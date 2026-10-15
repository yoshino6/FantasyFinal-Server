import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { worldTreeAdvancedProfessions } from '../src/game/advanced-profession.config';
import { worldSurfaceMonsters, worldSurfaceRegions } from '../src/config/world-surface';

test('every public mentor route has reachable target definitions, proof material and map coverage', () => {
  const bootstrap = readFileSync(new URL('../src/database/bootstrap.ts', import.meta.url), 'utf8');
  assert.ok(bootstrap.includes('worldSurfaceMonsters'));
  for (const profession of worldTreeAdvancedProfessions) {
    const { route } = profession;
    assert.ok(route.maps.includes(route.regionCode));
    const region = worldSurfaceRegions.find(r => r.code === route.regionCode);
    if (region) {
      assert.ok(route.x >= region.minX && route.x <= region.maxX);
      assert.ok(route.y >= region.minY && route.y <= region.maxY);
    } else assert.equal(route.regionCode, 'dark_forest_deep');
    for (const code of [...profession.first.targetCodes, ...profession.second.targetCodes]) {
      const target = worldSurfaceMonsters.find(m => m.code === code);
      if (target) { assert.equal(target.regionCode, route.regionCode); assert.equal(target.materialCode, route.materialCode); }
      else { assert.equal(route.regionCode, 'dark_forest_deep'); assert.ok(bootstrap.includes(`('${code}',`), code); }
    }
    assert.ok(profession.trial.code); assert.ok(profession.mentor.code); assert.ok(profession.second.materialCount > 0);
  }
  assert.match(bootstrap, /'sky_dust','chance',0\.40/);
});
