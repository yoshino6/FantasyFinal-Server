import test from 'node:test';
import assert from 'node:assert/strict';
import { trialEventEvidenceSatisfied } from '../src/game/map-hidden-trial-evidence';

const quest = { character_id: 1, trial_spawn_id: 10, practice_spawn_id: 11, practice_spawn_id_2: 12 };
const event = (turn_no: number, event_code: string, target_id = 0, id = 0) => ({ id, turn_no, event_code, target_id });

test('剑影要有连续四轮转火回打、拭剑有效命中和真实追加连击', () => {
  const evidence = [event(1, 'sword_attack_hit', 10), event(2, 'sword_attack_hit', 11),
    event(3, 'sword_attack_hit', 10), event(4, 'sword_attack_hit', 10),
    event(2, 'sword_switched_target', 11), event(3, 'sword_polished_hit', 10), event(3, 'sword_combo_hit', 10)];
  assert.equal(trialEventEvidenceSatisfied('sword_shadow', quest, evidence), true);
  assert.equal(trialEventEvidenceSatisfied('sword_shadow', quest, evidence.filter(entry => entry.event_code !== 'sword_combo_hit')), false);
  assert.equal(trialEventEvidenceSatisfied('sword_shadow', quest, evidence.filter(entry => entry.turn_no !== 3)), false);
});

test('泰坦要三名真实来源、连续三轮伤势扣血和队友代承', () => {
  const evidence = [event(1, 'titan_deferred_hit', 10), event(2, 'titan_deferred_hit', 11), event(3, 'titan_deferred_hit', 12),
    event(2, 'titan_guard_redirect', 2), ...[1, 2, 3].map(turn => event(turn, 'titan_wound_tick'))];
  assert.equal(trialEventEvidenceSatisfied('titan', quest, evidence), true);
  assert.equal(trialEventEvidenceSatisfied('titan', quest, evidence.filter(entry => entry.target_id !== 12)), false);
  assert.equal(trialEventEvidenceSatisfied('titan', quest, evidence.filter(entry => entry.event_code !== 'titan_guard_redirect')), false);
});

test('唤灵师三职责须连续三轮并发生有代价的重召', () => {
  const evidence = [event(1, 'summoner_attack_role'), event(1, 'summoner_guard_role'), event(1, 'summoner_heal_role'),
    event(1, 'summoner_three_roles_round'), event(2, 'summoner_three_roles_round'), event(3, 'summoner_three_roles_round'),
    event(4, 'summoner_resummon')];
  assert.equal(trialEventEvidenceSatisfied('spirit_summoner', quest, evidence), true);
  assert.equal(trialEventEvidenceSatisfied('spirit_summoner', quest, evidence.filter(entry => entry.event_code !== 'summoner_resummon')), false);
  assert.equal(trialEventEvidenceSatisfied('spirit_summoner', quest, evidence.filter(entry => entry.turn_no !== 2)), false);
});

test('妙手要从陪练合法探囊、识别导师不可偷并转成实际收益', () => {
  const evidence = [event(1, 'thief_forbidden_identified', 10), event(2, 'thief_training_pick', 11), event(3, 'thief_loaded_benefit', 11)];
  assert.equal(trialEventEvidenceSatisfied('master_thief', quest, evidence), true);
  assert.equal(trialEventEvidenceSatisfied('master_thief', quest, evidence.map(entry => entry.event_code === 'thief_training_pick' ? { ...entry, target_id: 10 } : entry)), false);
});

test('圣骑要两种誓言生效并实际代队友承伤', () => {
  const evidence = [event(1, 'paladin_courage_active'), event(2, 'paladin_guard_active'), event(3, 'paladin_guard_redirect', 2)];
  assert.equal(trialEventEvidenceSatisfied('holy_knight', quest, evidence), true);
  assert.equal(trialEventEvidenceSatisfied('holy_knight', quest, evidence.map(entry => entry.event_code === 'paladin_guard_redirect' ? { ...entry, target_id: 1 } : entry)), false);
});

test('弦刃使要连续远近远近、主动换目标并实际触发交替', () => {
  const evidence = [event(1, 'stringblade_ranged_hit', 10), event(2, 'stringblade_melee_hit', 11),
    event(3, 'stringblade_ranged_hit', 10), event(4, 'stringblade_melee_hit', 11),
    event(2, 'stringblade_alternate', 11), event(2, 'stringblade_switched_target', 11)];
  assert.equal(trialEventEvidenceSatisfied('stringblade', quest, evidence), true);
  assert.equal(trialEventEvidenceSatisfied('stringblade', quest, evidence.filter(entry => entry.turn_no !== 3)), false);
  assert.equal(trialEventEvidenceSatisfied('stringblade', quest, evidence.filter(entry => entry.event_code !== 'stringblade_switched_target')), false);
});
