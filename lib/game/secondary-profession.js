//#region src/game/secondary-profession.ts
/** 所有副职业共用锻造师的等级上限与熟练度曲线。 */
const secondaryProfessionMaxLevel = 11;
const secondaryProfessionProficiencyRequired = (level) => ({
	1: 100,
	2: 500,
	3: 2e3,
	4: 1e4,
	5: 3e4,
	6: 1e5,
	7: 3e5,
	8: 1e6,
	9: 1e7,
	10: 1e8
})[level] ?? 0;
const secondaryProfessionBonus = (level) => Math.max(0, (Math.min(11, level) - 1) * 5);

//#endregion
export { secondaryProfessionBonus, secondaryProfessionMaxLevel, secondaryProfessionProficiencyRequired };