import { getConfigValue } from "alemonjs";

//#region src/config/app-api.ts
const getAppApiConfig = () => {
	const raw = getConfigValue().FantasyFinal?.appApi ?? {};
	return {
		enabled: raw.enabled !== false,
		allowInsecurePublicHttp: raw.allowInsecurePublicHttp === true
	};
};

//#endregion
export { getAppApiConfig };