//#region src/game/finance-math.ts
const shanghaiParts = (date = /* @__PURE__ */ new Date()) => {
	const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23"
	}).formatToParts(date).map((part) => [part.type, part.value]));
	return {
		year: values.year,
		month: values.month,
		day: values.day,
		hour: Number(values.hour)
	};
};
const financeBusinessDate = (date = /* @__PURE__ */ new Date()) => {
	const p = shanghaiParts(date);
	return `${p.year}${p.month}${p.day}`;
};
const financePeriodKey = (date = /* @__PURE__ */ new Date()) => {
	const p = shanghaiParts(date);
	return `${p.year}${p.month}${p.day}${String(Math.floor(p.hour / 4) * 4).padStart(2, "0")}`;
};
const shiftFinancePeriod = (key, hours) => {
	const date = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)), Number(key.slice(8, 10))) + hours * 36e5);
	return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}${String(date.getUTCHours()).padStart(2, "0")}`;
};
const previousFinancePeriod = (key) => shiftFinancePeriod(key, -4);
const nextFinancePeriod = (key) => shiftFinancePeriod(key, 4);
/** 在硬性限幅和加权总值内尝试匹配传闻的整铜币方向；不可行时返回 null。 */
const tryConstrainedFinancePrices = (stocks, directions) => {
	if (!stocks.length) return [];
	const totalWeight = stocks.reduce((sum, item) => sum + item.priceMilli * item.shares, 0);
	const mean = stocks.reduce((sum, item) => sum + item.score * item.priceMilli * item.shares, 0) / totalWeight;
	const desired = stocks.map((item) => {
		const anchor = item.dayAnchorMilli ?? item.priceMilli;
		const quote = Math.max(1, Math.round(item.priceMilli / 1e3));
		const openingQuote = Math.max(1, Math.round(anchor / 1e3));
		const minQuote = Math.max(1, Math.ceil(quote * .95), Math.ceil(openingQuote * .8));
		const maxQuote = Math.min(Math.floor(quote * 1.05), Math.floor(openingQuote * 1.2));
		const direction = directions.get(item.code);
		const min = Math.max(1, Math.ceil(item.priceMilli * .95), Math.ceil(anchor * .8), minQuote * 1e3 - 500, direction === 1 ? quote * 1e3 + 500 : 1);
		const max = Math.min(Math.floor(item.priceMilli * 1.05), Math.floor(anchor * 1.2), maxQuote * 1e3 + 499, direction === -1 ? quote * 1e3 - 501 : Number.MAX_SAFE_INTEGER);
		if (min > max) return null;
		return {
			...item,
			target: item.priceMilli * (1 + .004 * Math.max(-20, Math.min(20, item.score - mean))),
			min,
			max
		};
	});
	if (desired.some((item) => item === null)) return null;
	const bounded = desired;
	const minimumWeight = bounded.reduce((sum, item) => sum + item.min * item.shares, 0);
	const maximumWeight = bounded.reduce((sum, item) => sum + item.max * item.shares, 0);
	if (totalWeight < minimumWeight || totalWeight > maximumWeight) return null;
	const evaluate = (shift) => bounded.reduce((sum, item) => sum + Math.max(item.min, Math.min(item.max, Math.round(item.target + shift))) * item.shares, 0);
	let shift = 0;
	if (evaluate(0) !== totalWeight) {
		let low = -Math.max(...stocks.map((item) => item.priceMilli)), high = Math.max(...stocks.map((item) => item.priceMilli));
		for (let step = 0; step < 48; step++) {
			const mid = (low + high) / 2;
			if (evaluate(mid) < totalWeight) low = mid;
			else high = mid;
		}
		shift = low;
	}
	const result = bounded.map((item) => ({
		code: item.code,
		priceMilli: item.priceMilli,
		shares: item.shares,
		score: item.score,
		nextMilli: Math.max(item.min, Math.min(item.max, Math.round(item.target + shift)))
	}));
	let residual = totalWeight - result.reduce((sum, item) => sum + item.nextMilli * item.shares, 0);
	for (const item of result) {
		if (!residual) break;
		const change = Math.trunc(residual / item.shares);
		if (!change) continue;
		const bounds = bounded.find((stock) => stock.code === item.code);
		const next = Math.max(bounds.min, Math.min(bounds.max, item.nextMilli + change));
		residual -= (next - item.nextMilli) * item.shares;
		item.nextMilli = next;
	}
	return residual === 0 ? result : null;
};
/** 平移并截断各股目标价，保持全市场按发行份额加权的参考总值。 */
const stableFinancePrices = (stocks) => {
	const result = tryConstrainedFinancePrices(stocks, /* @__PURE__ */ new Map());
	if (!result) throw new Error("证券参考价无法在限幅内保持总值守恒。");
	return result;
};

//#endregion
export { financeBusinessDate, financePeriodKey, nextFinancePeriod, previousFinancePeriod, stableFinancePrices, tryConstrainedFinancePrices };