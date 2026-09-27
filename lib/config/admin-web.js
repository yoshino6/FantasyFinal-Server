import { getConfigValue } from "alemonjs";

//#region src/config/admin-web.ts
const boundedInteger = (value, fallback, min, max) => {
	const number = Number(value);
	return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
};
/**
* 后台在没有 publicBaseUrl 时仅允许 localhost，便于首次本地初始化。
* 配置了公网地址后，默认严格校验 Host 与来自可信反向代理的 HTTPS 协议。
* HTTP 公网直连必须同时显式开启 allowInsecurePublicHttp，避免误暴露后台。
*/
const getAdminWebConfig = () => {
	const raw = getConfigValue().FantasyFinal?.adminWeb ?? {};
	const base = String(raw.publicBaseUrl ?? "").trim().replace(/\/$/, "");
	const allowInsecurePublicHttp = raw.allowInsecurePublicHttp === true;
	let publicBaseUrl = null;
	if (base) try {
		const url = new URL(base);
		if (!(url.protocol === "http:" && allowInsecurePublicHttp) && url.protocol !== "https:" || !url.hostname) throw new Error("后台公网地址必须为 HTTPS URL；仅在 allowInsecurePublicHttp=true 时允许 HTTP。");
		publicBaseUrl = url.toString().replace(/\/$/, "");
	} catch (error) {
		throw new Error(error instanceof Error ? error.message : "后台公网地址无效。");
	}
	const trustedProxyIps = Array.isArray(raw.trustedProxyIps) ? raw.trustedProxyIps.map((value) => String(value).trim()).filter(Boolean).slice(0, 16) : [
		"127.0.0.1",
		"::1",
		"::ffff:127.0.0.1"
	];
	return {
		enabled: raw.enabled !== false,
		port: boundedInteger(raw.port, 17118, 1024, 65535),
		listenHost: raw.listenHost === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1",
		publicBaseUrl,
		allowInsecurePublicHttp,
		trustedProxyIps,
		sessionIdleMinutes: boundedInteger(raw.sessionIdleMinutes, 30, 5, 720),
		sessionAbsoluteMinutes: boundedInteger(raw.sessionAbsoluteMinutes, 480, 15, 1440),
		ownerBootstrapPasswordHash: String(raw.ownerBootstrapPasswordHash ?? "").trim() || null
	};
};

//#endregion
export { getAdminWebConfig };