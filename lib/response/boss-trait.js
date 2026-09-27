import { useGameMessage } from "../game/use-game-message.js";
import { level32BossDifficultyCodeFromTraits } from "../game/level32-boss-difficulty.config.js";
import { battleStatus, bossRandomEffectSummary, currentEncounter } from "../game/adventure.service.js";
import { bossTraitCardImage } from "../game/boss-trait-card.service.js";
import { Format, useEvent } from "alemonjs";

//#region src/response/boss-trait.ts
const uniqueLines = (values) => [...new Set(values.filter(Boolean))];
const uniqueCards = (cards) => [...new Map(cards.map((card) => [`${card.bossCode}:${card.difficultyCode}`, card])).values()];
var boss_trait_default = async () => {
	const [event] = useEvent();
	const [message] = useGameMessage();
	const qqUserId = String(event.current.UserId);
	let foundBoss = false;
	let lines = [];
	let cards = [];
	try {
		const bosses = (await currentEncounter(qqUserId))?.spawns.filter((spawn) => spawn.monster_class === "boss") ?? [];
		if (bosses.length) {
			foundBoss = true;
			lines = uniqueLines(bosses.flatMap((boss) => bossRandomEffectSummary(boss.traits_json)));
			cards = bosses.flatMap((boss) => {
				const difficultyCode = level32BossDifficultyCodeFromTraits(String(boss.template_code ?? ""), boss.traits_json);
				return difficultyCode ? [{
					bossCode: String(boss.template_code),
					bossName: String(boss.name),
					difficultyCode,
					effects: bossRandomEffectSummary(boss.traits_json)
				}] : [];
			});
		}
	} catch {}
	if (!foundBoss) try {
		const bosses = (await battleStatus(qqUserId)).targets.filter((target) => target.isBoss && !target.isBossComponent);
		if (bosses.length) {
			foundBoss = true;
			lines = uniqueLines(bosses.flatMap((target) => target.randomEffects));
			cards = bosses.flatMap((target) => target.difficultyCode ? [{
				bossCode: String(target.bossCode),
				bossName: String(target.name),
				difficultyCode: target.difficultyCode,
				effects: target.randomEffects
			}] : []);
		}
	} catch {}
	const currentCards = uniqueCards(cards);
	if (currentCards.length) {
		for (const card of currentCards) await message.send({ format: Format.create().addImage(await bossTraitCardImage(card)) });
		return;
	}
	if (foundBoss && !lines.length) return;
	const markdown = Format.createMarkdown().addTitle("当前BOSS特殊效果").addNewline().addNewline();
	if (!foundBoss) markdown.addBlockquote("当前没有正在遇战或战斗中的 BOSS。");
	else lines.forEach((line, index) => {
		markdown.addBlockquote(line);
		if (index < lines.length - 1) markdown.addNewline();
	});
	await message.send({ format: Format.create().addMarkdown(markdown) });
};

//#endregion
export { boss_trait_default as default };