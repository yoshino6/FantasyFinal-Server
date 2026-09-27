import { talentByCode } from "./talent.config.js";
import { specializationGrowthFactor } from "./skill-specialization.js";

//#region src/game/passive-specialization.ts
/** 有具体数值落点的被动开放强效；布尔规则、免死次数、资源循环与探测权限保持固定。 */
const residentScalablePassives = new Set("A08 B07 C07 C08 D08 E07 E08 F07 F08 G07 G08 H07 H08 I01 I08 K07 L07 M07".split(" ").map((id) => `resident_${id.toLowerCase()}`));
const numericKeys = /* @__PURE__ */ new Set([
	"damageBonusPct",
	"damageReductionPct",
	"healingBonusPct",
	"regenerationBonusPct",
	"magicDamagePct",
	"lightSkillBonusPct",
	"lifestealPct",
	"venomDamagePct",
	"criticalDamageBonusPct"
]);
const canSpecializePassive = (code, effect = {}) => !talentByCode.has(code) && (residentScalablePassives.has(code) || Object.entries(effect).some(([key, value]) => numericKeys.has(key) && typeof value === "number" && value > 0));
const passiveSpecializationFactor = (level, tier) => Math.min(1.25, specializationGrowthFactor(level, tier, .015));
const specializedPassiveValue = (key, value, level, tier) => numericKeys.has(key) ? value * passiveSpecializationFactor(level, tier) : value;

//#endregion
export { canSpecializePassive, passiveSpecializationFactor, residentScalablePassives, specializedPassiveValue };