//#region src/game/combat-dispel-policy.ts
const isHardControlEffect = (code) => [
	"sleep",
	"petrify",
	"charm",
	"fear",
	"stun",
	"alchemy_stun",
	"hidden_freeze",
	"hidden_stun",
	"nightmare"
].includes(code);
const nativeCleanseLimit = (code) => ({
	saint_healer_absolution_hand: 2,
	saint_healer_revival_sanctuary: 1,
	summoner_returning_veil: 1,
	dawn_judgment_litany: 1,
	purifying_light: 2
})[code] ?? Infinity;
/** 普通净化不能越过强控；神圣净化也不能替代明确的部位/阶段机制。 */
const protectedControlCodes = /* @__PURE__ */ new Set(["petrify", "charm"]);
const canDispelCombatEffect = (code, authority = "ordinary", mechanismLocked = false) => {
	if (authority === "mechanism") return true;
	if (mechanismLocked || code === "nightmare") return false;
	return authority === "holy" || !protectedControlCodes.has(code);
};

//#endregion
export { canDispelCombatEffect, isHardControlEffect, nativeCleanseLimit, protectedControlCodes };