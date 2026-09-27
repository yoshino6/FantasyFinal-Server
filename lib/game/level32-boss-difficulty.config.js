//#region src/game/level32-boss-difficulty.config.ts
const level32DifficultyBossCodes = [
	"goblin_king",
	"gruen_mountainheart",
	"valk_forge_overseer",
	"threehead_mother",
	"necromancer_uz"
];
const stats = (hp, attack, defense, accuracy, evasion, critRate, critDamage, critResist, critReduction, tenacity, speed) => ({
	hp,
	physicalAttack: attack,
	magicAttack: attack,
	physicalDefense: defense,
	magicDefense: defense,
	accuracy,
	evasion,
	critRate,
	critDamage,
	critResist,
	critReduction,
	tenacity,
	speed
});
/**
* 五只 Lv.32 Boss 的满培养校准表。
*
* - 深渊/地狱：Lv.30 满培养、满进化、100% 稀有装备与二转被动。
* - 猩红/腐化/神圣：同条件的 100% 传说装备。
* - 黄金/璀璨/梦幻：同条件的 100% 史诗装备。
*
* 这里给出最终词条倍率，不与旧的通用难度倍率相乘。这样双防、暴免、暴抗和韧性
* 都能按档位明确校准，也不会把低等级 Boss 一并抬高。
*/
const level32BossDifficultyTraits = {
	infernal: {
		code: "infernal",
		name: "深渊的",
		referenceEquipment: "稀有",
		role: "均衡",
		statMultiplier: 1.6,
		statMultipliers: stats(8, 1.45, 1.65, 1.6, 1.55, 1.4, 1.4, 2, 2, 2.5, 1.45),
		experiencePct: 70,
		dropPct: 200
	},
	abyssal: {
		code: "abyssal",
		name: "地狱的",
		referenceEquipment: "稀有",
		role: "均衡",
		statMultiplier: 1.85,
		statMultipliers: stats(12, 1.55, 1.8, 1.8, 1.7, 1.5, 1.5, 2.5, 2.5, 3.2, 1.65),
		experiencePct: 110,
		dropPct: 300
	},
	crimson: {
		code: "crimson",
		name: "猩红的",
		referenceEquipment: "传说",
		role: "强攻",
		statMultiplier: 2.5,
		statMultipliers: stats(14, 2, 2.05, 2.25, 2, 1.9, 2, 3, 3, 4, 2.3),
		experiencePct: 170,
		dropPct: 500
	},
	corrupted: {
		code: "corrupted",
		name: "腐化的",
		referenceEquipment: "传说",
		role: "重防",
		statMultiplier: 2.15,
		statMultipliers: stats(25, 1.65, 2.45, 2.1, 2, 1.55, 1.55, 5, 5.6, 5.5, 1.9),
		experiencePct: 180,
		dropPct: 500
	},
	holy: {
		code: "holy",
		name: "神圣的",
		referenceEquipment: "传说",
		role: "机动",
		statMultiplier: 2.25,
		statMultipliers: stats(20, 1.7, 2.2, 2.25, 2.55, 1.6, 1.6, 4.3, 4.8, 5, 2.8),
		experiencePct: 190,
		dropPct: 500
	},
	golden: {
		code: "golden",
		name: "黄金的",
		referenceEquipment: "史诗",
		role: "均衡",
		statMultiplier: 2.7,
		statMultipliers: stats(24, 1.85, 2.6, 2.55, 2.6, 1.7, 1.7, 5.3, 6, 7, 3),
		experiencePct: 280,
		dropPct: 900
	},
	brilliant: {
		code: "brilliant",
		name: "璀璨的",
		referenceEquipment: "史诗",
		role: "均衡",
		statMultiplier: 3.1,
		statMultipliers: stats(30, 2, 3.1, 3, 3.15, 1.85, 1.85, 6.5, 7.5, 12, 3.5),
		experiencePct: 450,
		dropPct: 1400
	},
	dreamlike: {
		code: "dreamlike",
		name: "梦幻的",
		referenceEquipment: "史诗",
		role: "均衡",
		statMultiplier: 3.6,
		statMultipliers: stats(38, 2.15, 3.6, 3.4, 3.5, 2, 2, 8, 9.5, 20, 4.2),
		experiencePct: 900,
		dropPct: 1900
	}
};
const level32DifficultyBossCodeSet = new Set(level32DifficultyBossCodes);
const level32DifficultyCodeSet = new Set(Object.keys(level32BossDifficultyTraits));
const level32BossDifficultyTraitFor = (bossCode, difficultyCode) => level32DifficultyBossCodeSet.has(bossCode) ? level32BossDifficultyTraits[difficultyCode] : void 0;
const applyLevel32BossDifficultyTraits = (bossCode, traits) => traits.map((trait) => level32BossDifficultyTraitFor(bossCode, trait.code) ?? trait);
const difficultyTraitValues = (traits) => {
	if (Array.isArray(traits)) return traits;
	if (typeof traits !== "string") return [];
	try {
		const parsed = JSON.parse(traits);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
};
const level32BossDifficultyCodeFromTraits = (bossCode, traits) => {
	if (!level32DifficultyBossCodeSet.has(bossCode)) return void 0;
	return difficultyTraitValues(traits).map((trait) => String(trait && typeof trait === "object" ? trait.code ?? "" : "")).find((code) => level32DifficultyCodeSet.has(code));
};

//#endregion
export { applyLevel32BossDifficultyTraits, level32BossDifficultyCodeFromTraits, level32BossDifficultyTraitFor, level32BossDifficultyTraits, level32DifficultyBossCodes };