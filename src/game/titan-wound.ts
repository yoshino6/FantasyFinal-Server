/** 泰坦的伤势随战斗成员 cooldowns 保存；每条入队伤害拆成未来三次自身行动的 HP 流失。 */
export type TitanWoundTick = { turn: number; amount: number };
export type TitanWoundState = {
  ticks: TitanWoundTick[];
  lastSettledTurn?: number;
  /** 下次有伤势到期时，最多把多少 HP 流失推迟一回合。 */
  deferralCap?: number;
};
export type TitanWoundCooldowns = Record<string, unknown> & { titanWounds?: TitanWoundState };

const integer = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
const turnNumber = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;

const readState = (cooldowns: TitanWoundCooldowns): TitanWoundState => {
  const raw = cooldowns.titanWounds;
  if (!raw || typeof raw !== 'object') return { ticks: [] };
  return {
    ticks: Array.isArray(raw.ticks) ? raw.ticks.map(tick => ({ turn: turnNumber(tick.turn), amount: integer(tick.amount) })).filter(tick => tick.amount > 0) : [],
    lastSettledTurn: raw.lastSettledTurn === undefined ? undefined : turnNumber(raw.lastSettledTurn),
    deferralCap: raw.deferralCap === undefined ? undefined : integer(raw.deferralCap)
  };
};

const withState = (cooldowns: TitanWoundCooldowns, state: TitanWoundState): TitanWoundCooldowns => ({ ...cooldowns, titanWounds: state });

const mergeTicks = (ticks: TitanWoundTick[]) => {
  const totals = new Map<number, number>();
  for (const tick of ticks) if (tick.amount > 0) totals.set(tick.turn, (totals.get(tick.turn) ?? 0) + tick.amount);
  return [...totals].sort(([a], [b]) => a - b).map(([turn, amount]) => ({ turn, amount }));
};

/** 已完成护盾、减伤和分担后的最终 HP 余量才调用；返回值须写回成员 cooldowns。 */
export const enqueueTitanWound = (cooldowns: TitanWoundCooldowns, damage: number, currentTurn: number) => {
  const total = integer(damage);
  if (!total) return { cooldowns, queued: 0, ticks: [] as TitanWoundTick[] };
  const turn = turnNumber(currentTurn);
  const quotient = Math.floor(total / 3);
  const remainder = total % 3;
  const added = [1, 2, 3].map((offset, index) => ({ turn: turn + offset, amount: quotient + (index < remainder ? 1 : 0) })).filter(tick => tick.amount > 0);
  const state = readState(cooldowns);
  state.ticks = mergeTicks([...state.ticks, ...added]);
  return { cooldowns: withState(cooldowns, state), queued: total, ticks: added };
};

/** 缓伤准备：只推迟下一跳的有限额度，不消除伤势，也不能叠存。 */
export const deferTitanWoundTick = (cooldowns: TitanWoundCooldowns, cap: number) => {
  const state = readState(cooldowns);
  state.deferralCap = integer(cap);
  return withState(cooldowns, state);
};

/** 每个自身行动至多结算一次；HP 流失不能再次送入伤势钩子。 */
export const settleTitanWound = (cooldowns: TitanWoundCooldowns, currentTurn: number, hp: number, hpMax: number) => {
  const turn = turnNumber(currentTurn);
  const state = readState(cooldowns);
  const currentHp = Math.min(integer(hp), integer(hpMax));
  if (state.lastSettledTurn === turn) return { cooldowns, hp: currentHp, loss: 0, deferred: 0, defeated: currentHp <= 0, pending: state.ticks.reduce((sum, tick) => sum + tick.amount, 0) };
  const due = state.ticks.filter(tick => tick.turn <= turn).reduce((sum, tick) => sum + tick.amount, 0);
  let deferred = 0;
  if (due > 0 && state.deferralCap) {
    deferred = Math.min(due, state.deferralCap, Math.floor(due * .15));
    state.deferralCap = undefined;
  }
  const loss = due - deferred;
  state.ticks = mergeTicks([
    ...state.ticks.filter(tick => tick.turn > turn),
    ...(deferred > 0 ? [{ turn: turn + 1, amount: deferred }] : [])
  ]);
  state.lastSettledTurn = turn;
  return { cooldowns: withState(cooldowns, state), hp: Math.max(0, currentHp - loss), loss, deferred, defeated: loss >= currentHp && loss > 0, pending: state.ticks.reduce((sum, tick) => sum + tick.amount, 0) };
};

/** 战斗结束、逃跑、异常收束时结清所有延期伤势，避免跨战斗规避伤害。 */
export const flushTitanWounds = (cooldowns: TitanWoundCooldowns, hp: number, hpMax: number) => {
  const state = readState(cooldowns);
  const loss = state.ticks.reduce((sum, tick) => sum + tick.amount, 0);
  const currentHp = Math.min(integer(hp), integer(hpMax));
  const next = { ...cooldowns };
  delete next.titanWounds;
  return { cooldowns: next, hp: Math.max(0, currentHp - loss), loss, defeated: loss >= currentHp && loss > 0 };
};

export const titanWoundSchedule = (cooldowns: TitanWoundCooldowns) => readState(cooldowns).ticks;
