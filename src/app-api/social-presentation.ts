import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { registeredAdvancedProfessionByCode } from '../game/advanced-profession.config';

export type SocialPortrait = { baseKey: string; poseKey: string; fallbackKey?: string };
export type SocialIdentity = { avatarUrl?: string; portrait?: SocialPortrait; gender?: string; level?: number; profession?: string };
export type SocialChatIdentity = SocialIdentity & { gameId?: number; name: string };
type IdentityRow = RowDataPacket & { id: number; game_id: number; player_id: number; name: string; avatar_data_url?: string | null; gender: string | null; level: number; profession_code: string | null; profession_name: string | null; advanced_profession_code: string | null };

/** Uploaded avatars are bounded JPEG data URLs, never arbitrary remote or executable URLs. */
const storedAvatarUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 65_535) return undefined;
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return undefined;
  const pixels = Buffer.from(match[1]!, 'base64');
  return pixels.length >= 5 && pixels.toString('base64') === match[1] &&
    pixels[0] === 0xff && pixels[1] === 0xd8 && pixels[2] === 0xff &&
    pixels[pixels.length - 2] === 0xff && pixels[pixels.length - 1] === 0xd9 ? value : undefined;
};

/** Presentation only: semantic portrait keys come from the character's committed identity. */
export const socialIdentityFromCharacter = (row: Pick<IdentityRow, 'gender' | 'level' | 'profession_code' | 'profession_name' | 'advanced_profession_code' | 'avatar_data_url'>): SocialIdentity => {
  const identity: SocialIdentity = {};
  const avatarUrl = storedAvatarUrl(row.avatar_data_url);
  if (avatarUrl) identity.avatarUrl = avatarUrl;
  if (Number.isSafeInteger(Number(row.level)) && Number(row.level) > 0) identity.level = Number(row.level);
  const advanced = row.advanced_profession_code ? registeredAdvancedProfessionByCode(row.advanced_profession_code) : null;
  const professionName = advanced?.name ?? row.profession_name;
  if (professionName) identity.profession = String(professionName);
  if (row.gender !== '男' && row.gender !== '女') return identity;
  identity.gender = row.gender;
  const gender = row.gender === '女' ? 'female' : 'male';
  const profession = ['warrior', 'mage', 'rogue', 'priest', 'archer'].includes(String(row.profession_code)) ? row.profession_code : null;
  const fallbackKey = profession ? `profession_${profession}_${gender}` : `player_${gender}_initial`;
  identity.portrait = advanced
    ? { baseKey: `advanced_${advanced.code}_${gender}`, poseKey: `standing_${advanced.code}`, fallbackKey }
    : { baseKey: fallbackKey, poseKey: profession ? `standing_${profession}` : 'standing_initial' };
  return identity;
};

/** Batch reads only identities already authorized by the enclosing social/channel query. */
const identityRows = async (db: Pool | PoolConnection, values: number[], key: 'game_id' | 'id' | 'player_id'): Promise<IdentityRow[]> => {
  const ids = [...new Set(values.filter(value => Number.isSafeInteger(value) && value > 0))];
  const result: IdentityRow[] = [];
  for (let start = 0; start < ids.length; start += 100) {
    const chunk = ids.slice(start, start + 100);
    const [rows] = await db.execute<IdentityRow[]>(`SELECT c.id,c.game_id,c.player_id,c.name,p.avatar_data_url,c.gender,c.level,c.profession_code,pd.name AS profession_name,ap.profession_code AS advanced_profession_code
      FROM characters c LEFT JOIN players p ON p.id=c.player_id LEFT JOIN profession_definitions pd ON pd.code=c.profession_code LEFT JOIN player_advanced_professions ap ON ap.character_id=c.id
      WHERE c.${key} IN (${chunk.map(() => '?').join(',')}) AND c.npc_code IS NULL`, chunk);
    result.push(...rows);
  }
  return result;
};

export const socialIdentities = async (db: Pool | PoolConnection, values: number[], key: 'game_id' | 'id' = 'game_id'): Promise<Map<number, SocialIdentity>> =>
  new Map((await identityRows(db, values, key)).map(row => [Number(row[key]), socialIdentityFromCharacter(row)]));

/** Chat needs the current public character identity; account IDs remain map keys only. */
export const socialChatIdentities = async (db: Pool | PoolConnection, values: number[], key: 'id' | 'player_id' = 'id'): Promise<Map<number, SocialChatIdentity>> =>
  new Map((await identityRows(db, values, key)).map(row => [Number(row[key]), {
    ...socialIdentityFromCharacter(row), name: String(row.name ?? '').replace(/\u0000/g, '').trim().slice(0, 64),
    ...(Number.isSafeInteger(Number(row.game_id)) && Number(row.game_id) > 0 ? { gameId: Number(row.game_id) } : {})
  }]));

/** Existing relationshipDisplayStage already applies friend/oath display limits. */
export const socialAffinityProgress = (stage: unknown): { min: number; nextMin: number | null; toNext: number } | undefined => {
  if (!stage || typeof stage !== 'object') return undefined;
  const value = stage as { min?: unknown; nextMin?: unknown; toNext?: unknown };
  if (typeof value.min !== 'number' || !Number.isFinite(value.min) || typeof value.toNext !== 'number' || !Number.isFinite(value.toNext)) return undefined;
  if (value.nextMin !== null && (typeof value.nextMin !== 'number' || !Number.isFinite(value.nextMin))) return undefined;
  return { min: value.min, nextMin: value.nextMin as number | null, toNext: value.toNext };
};
