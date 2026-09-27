//#region src/game/boss-encounter-balance.ts
/** 召唤物自身模板修正；生命不继承 Boss 难度倍率，主线沿用原强度。 */
const encounterSummonProfiles = {
	goblin_royal_guard: {
		hpMax: 1.25,
		physicalAttack: 1.1,
		physicalDefense: 1.25,
		magicDefense: 1.15
	},
	goblin_royal_spearman: {
		hpMax: 1.25,
		physicalAttack: 1.2,
		magicAttack: 1.2,
		accuracy: 1.1
	},
	uzz_skeleton_berserker: {
		hpMax: 1.8,
		physicalAttack: 1.25,
		physicalDefense: 1.15,
		magicDefense: 1.15,
		accuracy: 1.1
	},
	uzz_skeleton_archer: {
		hpMax: 1.6,
		physicalAttack: 1.25,
		magicAttack: 1.25,
		accuracy: 1.15
	},
	uzz_pain_wraith: {
		hpMax: 1.4,
		magicAttack: 1.15,
		physicalDefense: 1.1,
		magicDefense: 1.1
	},
	uzz_skeleton_mage: {
		hpMax: 1.4,
		magicAttack: 1.2,
		accuracy: 1.1
	},
	uzz_frost_bone_dragon: {
		hpMax: 1.25,
		physicalAttack: 1.1,
		magicAttack: 1.1
	}
};
const applyEncounterSummonBalance = (stats, code, story = false) => {
	const profile = story ? void 0 : encounterSummonProfiles[code];
	if (!profile) return stats;
	const result = { ...stats };
	for (const [key, factor] of Object.entries(profile)) {
		const stat = key;
		result[stat] = Math.max(0, Math.floor(stats[stat] * factor));
	}
	return result;
};

//#endregion
export { applyEncounterSummonBalance, encounterSummonProfiles };