import { getConfigValue } from "alemonjs";

//#region src/config/app-api-server.ts
const boundedInteger = (value, fallback, min, max) => {
	const number = Number(value);
	return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
};
const getAppApiServerConfig = () => {
	const raw = getConfigValue().FantasyFinal?.appApiServer ?? {};
	return {
		enabled: raw.enabled !== false,
		port: boundedInteger(raw.port, 17117, 1024, 65535),
		listenHost: raw.listenHost === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1"
	};
};

//#endregion
export { getAppApiServerConfig };