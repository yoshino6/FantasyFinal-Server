//#region src/game/boss-summon-inheritance.ts
/** Boss 召唤物继承来源词条的非生命面板；hpMax 始终原样保留。 */
const applyBossSummonTrait = (stats, trait) => {
	if (!trait) return stats;
	const multiplier = (stat) => Number((stat ? trait.statMultipliers?.[stat] : void 0) ?? trait.statMultiplier ?? 1);
	const scaled = (value, pctKey, stat) => Math.floor(value * multiplier(stat) * (1 + Number(pctKey ? trait[pctKey] ?? 0 : 0) / 100));
	return {
		...stats,
		hpMax: stats.hpMax,
		mpMax: scaled(stats.mpMax, "mpPct"),
		physicalAttack: scaled(stats.physicalAttack, "physicalAttackPct", "physicalAttack"),
		magicAttack: scaled(stats.magicAttack, "magicAttackPct", "magicAttack"),
		physicalDefense: scaled(stats.physicalDefense, "physicalDefensePct", "physicalDefense"),
		magicDefense: scaled(stats.magicDefense, "magicDefensePct", "magicDefense"),
		accuracy: scaled(stats.accuracy, "accuracyPct", "accuracy"),
		evasion: scaled(stats.evasion, "evasionPct", "evasion"),
		crit: scaled(stats.crit, "critRatePct", "critRate"),
		critResist: scaled(stats.critResist, "critResistPct", "critResist"),
		critDamage: scaled(stats.critDamage, "critDamagePct", "critDamage"),
		critReduction: scaled(stats.critReduction, "critReductionPct", "critReduction"),
		tenacity: scaled(stats.tenacity, void 0, "tenacity"),
		tenacityPierce: scaled(stats.tenacityPierce),
		speed: scaled(stats.speed, "speedPct", "speed"),
		perception: scaled(stats.perception)
	};
};

//#endregion
export { applyBossSummonTrait };