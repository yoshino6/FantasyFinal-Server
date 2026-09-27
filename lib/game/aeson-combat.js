//#region src/game/aeson-combat.ts
/** 艾森的战斗决策是单一状态机，生命阶段高于普通轮转。 */
const aesonNextSkill = (state) => {
	if (state.hpRatio < .1) return {
		code: "aeson_destruction",
		combo: state.combo
	};
	if (!state.inspired) return {
		code: "aeson_inspire",
		combo: state.combo
	};
	if (state.hpRatio <= .6 && !state.willUsed) return {
		code: "aeson_ironwill",
		combo: state.combo
	};
	if (state.hpRatio <= .3 && !state.berserkUsed) return {
		code: "aeson_berserk",
		combo: state.combo
	};
	if (state.hpRatio > .6) {
		const loop = [
			"aeson_earthbreak",
			"aeson_softbreak",
			"aeson_shortfist"
		];
		return {
			code: loop[state.combo % loop.length],
			combo: state.combo + 1
		};
	}
	const pool = [
		"aeson_earthbreak",
		"aeson_softbreak",
		"aeson_shortfist",
		"aeson_snakebind",
		"aeson_ultimate"
	];
	return {
		code: pool[Math.max(0, Math.min(pool.length - 1, Math.floor(state.roll * pool.length)))],
		combo: state.combo
	};
};

//#endregion
export { aesonNextSkill };