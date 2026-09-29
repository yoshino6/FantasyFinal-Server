//#region src/game/sword-shadow-combo.ts
/** 剑影连击只在一次真实命中的可连击主动攻击后判定；复制段不能调用本函数。 */
const swordShadowComboChance = (speed, accuracy, chain) => Math.max(.05, Math.min(.35, .05 + Math.max(0, speed) * .001 + Math.max(0, accuracy) * .0035 + Math.min(3, Math.max(0, chain)) * .02));
const swordShadowCopyCount = (sheathed, storm, passiveRoll, speed, accuracy, chain) => Math.min(storm ? 1 : 2, Number(sheathed) + Number(passiveRoll < swordShadowComboChance(speed, accuracy, chain)));
const advanceSwordShadowChain = (previous, targetId, turn, hit) => {
	const before = turn - previous.lastTurn > 2 ? 0 : previous.stacks;
	const switched = previous.targetId !== null && previous.targetId !== targetId;
	const retained = Math.max(0, before - Number(switched));
	const stacks = hit ? Math.min(5, retained + 1) : Math.max(0, retained - 1);
	return {
		stacks,
		targetId,
		lastTurn: turn,
		switched,
		missPreserved: !hit && stacks > 0
	};
};

//#endregion
export { advanceSwordShadowChain, swordShadowComboChance, swordShadowCopyCount };