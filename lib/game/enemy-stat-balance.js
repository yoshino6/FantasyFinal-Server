import { attributes } from "./types.js";
import { monsterCombatStats } from "./adventure.service.js";

//#region src/game/enemy-stat-balance.ts
const ENEMY_STAT_BALANCE_VERSION = 4;
const enemyBalanceJson = (raw) => typeof raw === "string" ? JSON.parse(raw) : raw;
/** 迁移专用旧生命上限：将旧线性成长展开为出生值，再走相同派生/虚拟装备/词条公式。 */
const previousMonsterHpMax = (row) => {
	const legacy = { ...row };
	for (const key of attributes) {
		legacy[key] = Number(row[key]) + Number(row[`${key}_growth`]) * Math.max(0, Number(row.level) - 1);
		legacy[`${key}_growth`] = 0;
	}
	legacy.traits_json = (enemyBalanceJson(row.traits_json) ?? []).filter((trait) => trait.code !== "main_quest_evolution" || trait.name);
	return monsterCombatStats(legacy).hpMax;
};
const migratedEnemyHp = (current, oldMax, newMax) => current <= 0 ? 0 : Math.min(newMax, Math.max(1, Math.floor(Math.min(1, current / Math.max(1, oldMax)) * newMax)));

//#endregion
export { ENEMY_STAT_BALANCE_VERSION, enemyBalanceJson, migratedEnemyHp, previousMonsterHpMax };