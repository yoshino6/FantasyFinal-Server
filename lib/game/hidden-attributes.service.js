import { drawHiddenAttribute, negotiationVersion } from "./negotiation-rules.js";

//#region src/game/hidden-attributes.service.ts
/** 只供服务端结算；不添加到 CharacterRow、管理页面或日志。 */
const hiddenAttributesFor = async (connection, characterId) => {
	await connection.execute("INSERT IGNORE INTO character_hidden_attributes (character_id,luck,charm,version) VALUES (?,?,?,?)", [
		characterId,
		drawHiddenAttribute(),
		drawHiddenAttribute(),
		1
	]);
	const [rows] = await connection.execute("SELECT luck,charm FROM character_hidden_attributes WHERE character_id=?", [characterId]);
	const row = rows[0];
	if (!row || !Number.isInteger(Number(row.luck)) || !Number.isInteger(Number(row.charm)) || Math.abs(Number(row.luck)) > 100 || Math.abs(Number(row.charm)) > 100) throw new Error("角色的结算数据异常，请联系管理员处理。");
	return {
		luck: Number(row.luck),
		charm: Number(row.charm)
	};
};

//#endregion
export { hiddenAttributesFor };