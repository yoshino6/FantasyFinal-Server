import { getConfigValue } from "alemonjs";

//#region src/config/core-api.ts
const integer = (value, fallback, min, max) => {
	const n = Number(value);
	return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
const getCoreApiConfig = () => {
	const raw = getConfigValue().FantasyFinal?.coreApi ?? {};
	return {
		enabled: raw.enabled !== false,
		port: integer(raw.port, 17200, 1024, 65535),
		listenHost: raw.listenHost === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1",
		serviceToken: String(raw.serviceToken ?? process.env.FANTASYFINAL_CORE_SERVICE_TOKEN ?? process.env.FANTASYFINAL_CORE_TOKEN ?? "").trim(),
		maxBodyBytes: integer(raw.maxBodyBytes, 262144, 16384, 2097152)
	};
};

//#endregion
export { getCoreApiConfig };