import { getConfigValue } from 'alemonjs';

type RawCoreApiConfig = { enabled?: boolean; port?: number; listenHost?: '127.0.0.1' | '0.0.0.0'; serviceToken?: string; maxBodyBytes?: number };
type AppConfig = { FantasyFinal?: { runtime?: string; coreApi?: RawCoreApiConfig } };
export type CoreApiConfig = { enabled: boolean; port: number; listenHost: '127.0.0.1' | '0.0.0.0'; serviceToken: string; maxBodyBytes: number };
const integer = (value: unknown, fallback: number, min: number, max: number) => { const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; };
export const getCoreApiConfig = (): CoreApiConfig => {
  const raw = getConfigValue<AppConfig>().FantasyFinal?.coreApi ?? {};
  return {
    enabled: raw.enabled !== false,
    port: integer(raw.port, 17200, 1024, 65535),
    listenHost: raw.listenHost === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
    serviceToken: String(raw.serviceToken ?? process.env.FANTASYFINAL_CORE_SERVICE_TOKEN ?? process.env.FANTASYFINAL_CORE_TOKEN ?? '').trim(),
    maxBodyBytes: integer(raw.maxBodyBytes, 256 * 1024, 16 * 1024, 2 * 1024 * 1024)
  };
};
