import test from 'node:test';
import assert from 'node:assert/strict';
import { mapHiddenAdvancedProfessions, worldTreeAdvancedProfessions } from '../src/game/advanced-profession.config';
import { mapHiddenMentorLocations } from '../src/game/map-hidden-mentor.locations';
import { worldSurfaceRegions } from '../src/config/world-surface';

test('六名隐藏导师位置唯一、对应职业，且不占公开导师 code', () => {
  assert.equal(mapHiddenMentorLocations.length, 6);
  assert.deepEqual(new Set(mapHiddenMentorLocations.map(entry => entry.professionCode)),
    new Set(mapHiddenAdvancedProfessions.map(entry => entry.code)));
  assert.equal(new Set(mapHiddenMentorLocations.map(entry => entry.mentorCode)).size, 6);
  assert.equal(new Set(mapHiddenMentorLocations.map(entry => `${entry.regionCode}:${entry.x}:${entry.y}:${entry.z}`)).size, 6);
  const publicMentors = new Set(worldTreeAdvancedProfessions.map(entry => entry.mentor.code));
  for (const location of mapHiddenMentorLocations) {
    const profession = mapHiddenAdvancedProfessions.find(entry => entry.code === location.professionCode);
    assert.equal(location.mentorCode, profession?.mentor.code);
    assert.equal(publicMentors.has(location.mentorCode), false);
    assert.ok(location.minimumRange > 0);
  }
});

test('五名地表导师坐标落在各自区域边界内', () => {
  for (const location of mapHiddenMentorLocations.filter(entry => entry.regionCode !== 'dark_forest_deep')) {
    const region = worldSurfaceRegions.find(entry => entry.code === location.regionCode);
    assert.ok(region, location.regionCode);
    assert.ok(location.x >= region.minX && location.x <= region.maxX, location.mentorCode);
    assert.ok(location.y >= region.minY && location.y <= region.maxY, location.mentorCode);
    assert.equal(location.z, 0);
  }
});
