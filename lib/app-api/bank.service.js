import { withTransaction } from "../database/pool.js";
import { completeCraftRequest, craftCharacterId, craftRequestFor, createCraftRequest } from "../game/alchemy-journal.service.js";
import { bankTransferInTransaction, depositProducts, openBankDepositInTransaction, settleBankDepositInTransaction } from "../game/finance.service.js";
import { randomUUID } from "node:crypto";

//#region src/app-api/bank.service.ts
const BANK_TARGET_ID = "silver_bell_bank";
const BANK_ACTIONS = [
	"deposit",
	"withdraw",
	"term_open",
	"settle",
	"early_settle"
];
const requestKind = "web_bank_action";
const quoteMinutes = 2;
const validCredential = (value) => /^[0-9a-f-]{36}$/i.test(value);
const actionResult = async (connection, qqUserId, input, preview) => {
	switch (input.action) {
		case "deposit": return bankTransferInTransaction(connection, qqUserId, Number(input.amount), "in", preview);
		case "withdraw": return bankTransferInTransaction(connection, qqUserId, Number(input.amount), "out", preview);
		case "term_open":
			if (!input.productCode || !(input.productCode in depositProducts)) throw new Error("未知存单期限。");
			return openBankDepositInTransaction(connection, qqUserId, input.productCode, Number(input.amount), preview);
		case "settle": return settleBankDepositInTransaction(connection, qqUserId, Number(input.depositId), false, preview);
		case "early_settle": return settleBankDepositInTransaction(connection, qqUserId, Number(input.depositId), true, preview);
		default: throw new Error("不支持该钱庄操作。");
	}
};
/** The maturity timestamp starts when a term is actually opened, so compare its financial terms instead. */
const bankQuoteFingerprint = (quote) => {
	const { due, id, ...stable } = quote;
	return JSON.stringify(stable);
};
const previewBankAction = (qqUserId, input) => withTransaction(async (connection) => {
	const characterId = await craftCharacterId(connection, qqUserId, true);
	const quote = await actionResult(connection, qqUserId, input, true);
	const idempotencyKey = randomUUID();
	return {
		token: await createCraftRequest(connection, characterId, requestKind, {
			...input,
			quote,
			idempotencyKey
		}, quoteMinutes),
		idempotencyKey,
		expiresAt: new Date(Date.now() + quoteMinutes * 6e4).toISOString(),
		quote
	};
});
const confirmBankAction = (qqUserId, token, idempotencyKey) => withTransaction(async (connection) => {
	if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error("确认凭据无效，请重新获取钱庄报价。");
	const characterId = await craftCharacterId(connection, qqUserId, true);
	const request = await craftRequestFor(connection, characterId, requestKind, token);
	if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error("确认凭据不匹配，请重新获取钱庄报价。");
	if (request.result) return request.result;
	const fresh = await actionResult(connection, qqUserId, request.snapshot, true);
	if (bankQuoteFingerprint(fresh) !== bankQuoteFingerprint(request.snapshot.quote)) throw new Error("钱庄余额或存单状态已变化，请重新获取报价。");
	const result = await actionResult(connection, qqUserId, request.snapshot, false);
	await completeCraftRequest(connection, characterId, token, result);
	return result;
});

//#endregion
export { BANK_ACTIONS, BANK_TARGET_ID, bankQuoteFingerprint, confirmBankAction, previewBankAction };