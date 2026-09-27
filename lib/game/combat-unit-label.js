//#region src/game/combat-unit-label.ts
/** 姓名保持本名，玩家的召唤物与随从仅在展示时使用中空括号。 */
const combatUnitLabel = (unit) => unit.companion || unit.npc_code || unit.key?.startsWith("automaton:") ? `〖${unit.name}〗` : `【${unit.name}】`;

//#endregion
export { combatUnitLabel };