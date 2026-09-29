//#region src/game/titan-wound.ts
const integer = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
const turnNumber = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
const readState = (cooldowns) => {
	const raw = cooldowns.titanWounds;
	if (!raw || typeof raw !== "object") return { ticks: [] };
	return {
		ticks: Array.isArray(raw.ticks) ? raw.ticks.map((tick) => ({
			turn: turnNumber(tick.turn),
			amount: integer(tick.amount)
		})).filter((tick) => tick.amount > 0) : [],
		lastSettledTurn: raw.lastSettledTurn === void 0 ? void 0 : turnNumber(raw.lastSettledTurn),
		deferralCap: raw.deferralCap === void 0 ? void 0 : integer(raw.deferralCap)
	};
};
const withState = (cooldowns, state) => ({
	...cooldowns,
	titanWounds: state
});
const mergeTicks = (ticks) => {
	const totals = /* @__PURE__ */ new Map();
	for (const tick of ticks) if (tick.amount > 0) totals.set(tick.turn, (totals.get(tick.turn) ?? 0) + tick.amount);
	return [...totals].sort(([a], [b]) => a - b).map(([turn, amount]) => ({
		turn,
		amount
	}));
};
/** 已完成护盾、减伤和分担后的最终 HP 余量才调用；返回值须写回成员 cooldowns。 */
const enqueueTitanWound = (cooldowns, damage, currentTurn) => {
	const total = integer(damage);
	if (!total) return {
		cooldowns,
		queued: 0,
		ticks: []
	};
	const turn = turnNumber(currentTurn);
	const quotient = Math.floor(total / 3);
	const remainder = total % 3;
	const added = [
		1,
		2,
		3
	].map((offset, index) => ({
		turn: turn + offset,
		amount: quotient + (index < remainder ? 1 : 0)
	})).filter((tick) => tick.amount > 0);
	const state = readState(cooldowns);
	state.ticks = mergeTicks([...state.ticks, ...added]);
	return {
		cooldowns: withState(cooldowns, state),
		queued: total,
		ticks: added
	};
};
/** 缓伤准备：只推迟下一跳的有限额度，不消除伤势，也不能叠存。 */
const deferTitanWoundTick = (cooldowns, cap) => {
	const state = readState(cooldowns);
	state.deferralCap = integer(cap);
	return withState(cooldowns, state);
};
/** 每个自身行动至多结算一次；HP 流失不能再次送入伤势钩子。 */
const settleTitanWound = (cooldowns, currentTurn, hp, hpMax) => {
	const turn = turnNumber(currentTurn);
	const state = readState(cooldowns);
	const currentHp = Math.min(integer(hp), integer(hpMax));
	if (state.lastSettledTurn === turn) return {
		cooldowns,
		hp: currentHp,
		loss: 0,
		deferred: 0,
		defeated: currentHp <= 0,
		pending: state.ticks.reduce((sum, tick) => sum + tick.amount, 0)
	};
	const due = state.ticks.filter((tick) => tick.turn <= turn).reduce((sum, tick) => sum + tick.amount, 0);
	let deferred = 0;
	if (due > 0 && state.deferralCap) {
		deferred = Math.min(due, state.deferralCap, Math.floor(due * .15));
		state.deferralCap = void 0;
	}
	const loss = due - deferred;
	state.ticks = mergeTicks([...state.ticks.filter((tick) => tick.turn > turn), ...deferred > 0 ? [{
		turn: turn + 1,
		amount: deferred
	}] : []]);
	state.lastSettledTurn = turn;
	return {
		cooldowns: withState(cooldowns, state),
		hp: Math.max(0, currentHp - loss),
		loss,
		deferred,
		defeated: loss >= currentHp && loss > 0,
		pending: state.ticks.reduce((sum, tick) => sum + tick.amount, 0)
	};
};
/** 战斗结束、逃跑、异常收束时结清所有延期伤势，避免跨战斗规避伤害。 */
const flushTitanWounds = (cooldowns, hp, hpMax) => {
	const loss = readState(cooldowns).ticks.reduce((sum, tick) => sum + tick.amount, 0);
	const currentHp = Math.min(integer(hp), integer(hpMax));
	const next = { ...cooldowns };
	delete next.titanWounds;
	return {
		cooldowns: next,
		hp: Math.max(0, currentHp - loss),
		loss,
		defeated: loss >= currentHp && loss > 0
	};
};
const titanWoundSchedule = (cooldowns) => readState(cooldowns).ticks;

//#endregion
export { deferTitanWoundTick, enqueueTitanWound, flushTitanWounds, settleTitanWound, titanWoundSchedule };