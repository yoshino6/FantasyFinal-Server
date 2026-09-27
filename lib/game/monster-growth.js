import { playerGrowthShares } from "./growth-rules.js";
import { attributes } from "./types.js";
import { monsterGrowthAnchors } from "../config/monster-growth-anchors.js";

//#region src/game/monster-growth.ts
const monsterIdentityCode = (row) => String(row.growth_template_code ?? row.template_code ?? row.code ?? "");
const isResidentMonsterCode = (code) => code.startsWith("city_") || code.startsWith("mentor_trial_") || code === "scholar_ga";
/** g有效=g原始×(校准等级-1)/G(校准等级)。g有效在同一种类内固定，升级仍按1/2/3/4…倍累加。 */
const monsterGrowthCoefficient = (code, _referenceLevel) => {
	if (isResidentMonsterCode(code)) return 1;
	const anchor = Math.max(10, monsterGrowthAnchors[code] ?? 10);
	return (anchor - 1) / playerGrowthShares(anchor);
};
const monsterGrowthAllocation = (row, multiplier = 1) => {
	const shares = playerGrowthShares(Number(row.level)) * monsterGrowthCoefficient(monsterIdentityCode(row), Number(row.level));
	return Object.fromEntries(attributes.map((key) => [key, Math.floor((Number(row[key]) + Number(row[`${key}_growth`]) * shares) * multiplier + 1e-9)]));
};

//#endregion
export { isResidentMonsterCode, monsterGrowthAllocation, monsterGrowthCoefficient, monsterIdentityCode };