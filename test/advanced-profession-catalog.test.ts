import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeSkillCodesForAdvancedProfession, advancedBoundSkillDefinitions, advancedProfessionByCode,
  advancedProfessionByMentor, mapHiddenAdvancedProfessions, registeredAdvancedProfessionByCode,
  renameAdvancedMentorText, worldTreeAdvancedProfessions
} from '../src/game/advanced-profession.config';
import { hiddenProfessions } from '../src/game/hidden-profession.config';
import { newAdvancedSkillDefinitions } from '../src/game/map-hidden-advanced-skills.config';
import { legacySpiritSummonerSkillCodes } from '../src/game/spirit-summoner.config';

test('魔导进入公开目录，唤灵师只保留隐藏入口与旧职业身份', () => {
  assert.deepEqual(worldTreeAdvancedProfessions.filter(profession => profession.baseProfession === '法师').map(profession => profession.name), ['元素使', '战斗法师', '魔导']);
  assert.equal(advancedProfessionByCode('spirit_summoner'), undefined);
  assert.equal(advancedProfessionByMentor('mentor_summoner_mia'), undefined);
  assert.equal(registeredAdvancedProfessionByCode('spirit_summoner')?.name, '唤灵师');
  assert.equal(mapHiddenAdvancedProfessions.find(profession => profession.code === 'spirit_summoner')?.mentor.code, 'mentor_summoner_mia');
  assert.equal(renameAdvancedMentorText('米娅'), '栖羽');
});

test('所有二转各有四项主动技，新增路线有完整技能和双绑定定义', () => {
  const professions = [...worldTreeAdvancedProfessions, ...mapHiddenAdvancedProfessions, ...hiddenProfessions];
  const newCodes = new Set(newAdvancedSkillDefinitions.map(skill => skill.code));
  assert.equal(newCodes.size, newAdvancedSkillDefinitions.length);
  for (const profession of professions) assert.equal(activeSkillCodesForAdvancedProfession(profession.code).length, 4, profession.code);
  for (const profession of [...mapHiddenAdvancedProfessions, worldTreeAdvancedProfessions.find(entry => entry.code === 'arcane_magister')!]) {
    assert.ok(activeSkillCodesForAdvancedProfession(profession.code).every(code => newCodes.has(code)), profession.code);
    assert.equal(advancedBoundSkillDefinitions.filter(skill => skill.professionCode === profession.code).length, 2, profession.code);
  }
  assert.ok(activeSkillCodesForAdvancedProfession('spirit_summoner').every(code => !legacySpiritSummonerSkillCodes.includes(code)));
});
