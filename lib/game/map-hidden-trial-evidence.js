//#region src/game/map-hidden-trial-evidence.ts
/** Pure verdict for the service's audited battle-event ledger; never callable from a player route. */
const trialEventEvidenceSatisfied = (professionCode, quest, events) => {
	const has = (code) => events.some((event) => event.event_code === code);
	const turns = (code) => new Set(events.filter((event) => event.event_code === code).map((event) => Number(event.turn_no)));
	const trialTargets = new Set([
		quest.trial_spawn_id,
		quest.practice_spawn_id,
		quest.practice_spawn_id_2
	].filter((id) => Boolean(id)).map(Number));
	const attackSequence = events.filter((event) => trialTargets.has(Number(event.target_id)) && [
		"sword_attack_hit",
		"stringblade_ranged_hit",
		"stringblade_melee_hit"
	].includes(event.event_code));
	if (professionCode === "sword_shadow") {
		const hits = attackSequence.filter((event) => event.event_code === "sword_attack_hit");
		return hits.some((first) => hits.some((second) => Number(second.turn_no) === Number(first.turn_no) + 1 && Number(second.target_id) !== Number(first.target_id) && hits.some((third) => Number(third.turn_no) === Number(first.turn_no) + 2 && Number(third.target_id) === Number(first.target_id)) && hits.some((fourth) => Number(fourth.turn_no) === Number(first.turn_no) + 3))) && has("sword_switched_target") && has("sword_polished_hit") && has("sword_combo_hit");
	}
	if (professionCode === "titan") {
		const sources = new Set(events.filter((event) => event.event_code === "titan_deferred_hit" && trialTargets.has(Number(event.target_id))).map((event) => Number(event.target_id)));
		const woundTurns = turns("titan_wound_tick");
		return sources.size >= 3 && [...woundTurns].some((turn) => woundTurns.has(turn + 1) && woundTurns.has(turn + 2)) && events.some((event) => event.event_code === "titan_guard_redirect" && Number(event.target_id) > 0 && Number(event.target_id) !== Number(quest.character_id));
	}
	if (professionCode === "spirit_summoner") {
		const rounds = turns("summoner_three_roles_round");
		return [...rounds].some((turn) => rounds.has(turn + 1) && rounds.has(turn + 2)) && has("summoner_attack_role") && has("summoner_guard_role") && has("summoner_heal_role") && has("summoner_resummon");
	}
	if (professionCode === "master_thief") return events.some((event) => event.event_code === "thief_training_pick" && Number(event.target_id) === Number(quest.practice_spawn_id)) && events.some((event) => event.event_code === "thief_forbidden_identified" && Number(event.target_id) === Number(quest.trial_spawn_id)) && has("thief_loaded_benefit");
	if (professionCode === "holy_knight") return has("paladin_courage_active") && has("paladin_guard_active") && events.some((event) => event.event_code === "paladin_guard_redirect" && Number(event.target_id) > 0 && Number(event.target_id) !== Number(quest.character_id));
	if (professionCode === "stringblade") {
		const order = [
			"stringblade_ranged_hit",
			"stringblade_melee_hit",
			"stringblade_ranged_hit",
			"stringblade_melee_hit"
		];
		return attackSequence.some((first) => {
			const steps = order.map((code, offset) => attackSequence.find((event) => event.event_code === code && Number(event.turn_no) === Number(first.turn_no) + offset));
			return steps.every(Boolean) && new Set(steps.map((event) => Number(event?.target_id))).size >= 2;
		}) && has("stringblade_alternate") && has("stringblade_switched_target");
	}
	return false;
};

//#endregion
export { trialEventEvidenceSatisfied };