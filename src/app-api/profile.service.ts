import sharp from 'sharp';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { getPool } from '../database/pool';

const MAX_AVATAR_BYTES = 256 * 1024;
const MAX_AVATAR_URL_BYTES = 65_535;
const MAX_AVATAR_SIDE = 512;
export const AVATAR_REQUEST_LIMIT = 384 * 1024;

export class AvatarInputError extends Error {}

const playerIdForAvatar = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new AvatarInputError('账号不可用，请重新登录。');
  return value;
};

/** Only bounded raster pixels cross the persistence boundary; source metadata is discarded. */
export const preparePlayerAvatar = async (value: unknown): Promise<string> => {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_AVATAR_BYTES / 3) * 4 + 32) {
    throw new AvatarInputError('头像图片不能超过 256 KB，请重新裁剪。');
  }
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new AvatarInputError('请选择 JPEG、PNG 或 WebP 图片。');
  const input = Buffer.from(match[2]!, 'base64');
  if (!input.length || input.length > MAX_AVATAR_BYTES || input.toString('base64') !== match[2]) {
    throw new AvatarInputError('头像图片格式或大小无效。');
  }
  try {
    const image = sharp(input, { limitInputPixels: MAX_AVATAR_SIDE * MAX_AVATAR_SIDE, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== match[1] || !metadata.width || !metadata.height ||
      metadata.width !== metadata.height || metadata.width > MAX_AVATAR_SIDE ||
      Number(metadata.pages ?? 1) !== 1) {
      throw new AvatarInputError('请上传裁剪后的正方形静态头像，尺寸不超过 512 像素。');
    }
    const output = await image.rotate().resize(256, 256, { fit: 'cover' })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    const avatarUrl = `data:image/jpeg;base64,${output.toString('base64')}`;
    if (avatarUrl.length > MAX_AVATAR_URL_BYTES) throw new AvatarInputError('头像内容过大，请选择更简单的图片。');
    return avatarUrl;
  } catch (error) {
    if (error instanceof AvatarInputError) throw error;
    throw new AvatarInputError('图片无法读取，请重新选择或裁剪图片。');
  }
};

export const uploadPlayerAvatar = async (playerId: number, imageData: unknown, db?: Pick<Pool, 'execute'>) => {
  const ownerId = playerIdForAvatar(playerId);
  const avatarUrl = await preparePlayerAvatar(imageData);
  const [result] = await (db ?? await getPool()).execute<ResultSetHeader>(
    `UPDATE players SET avatar_data_url=? WHERE id=?
     AND (status='active' OR (status='registering' AND LEFT(qq_user_id,4)='app_'))`,
    [avatarUrl, ownerId]
  );
  if (!result.affectedRows) throw new AvatarInputError('账号不可用，请重新登录。');
  return { avatarUrl };
};

export const readPlayerAvatar = async (playerId: number, db?: Pick<Pool, 'execute'>): Promise<string | null> => {
  const ownerId = playerIdForAvatar(playerId);
  const [rows] = await (db ?? await getPool()).execute<(RowDataPacket & { avatar_data_url: string | null })[]>(
    'SELECT avatar_data_url FROM players WHERE id=? LIMIT 1', [ownerId]
  );
  const value = rows[0]?.avatar_data_url;
  return typeof value === 'string' && value.length <= MAX_AVATAR_URL_BYTES &&
    /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
};

export type IdentityChangeAllowance = {
  freeRemaining: 0 | 1;
  cardQuantity: number;
  itemName: string;
  code: string;
  requiredQuantity: 1;
};

export type PlayerIdentityChanges = {
  name: string;
  gender: string;
  rename: IdentityChangeAllowance;
  genderChange: IdentityChangeAllowance;
};

/** 仅查询当前角色的独立免费次数及对应道具，不刷新属性或预先消耗次数。 */
export const readPlayerIdentityChanges = async (playerId: number, db?: Pick<Pool, 'execute'>): Promise<PlayerIdentityChanges | null> => {
  const ownerId = playerIdForAvatar(playerId);
  const [rows] = await (db ?? await getPool()).execute<(RowDataPacket & {
    name: string; gender: string; free_name_change_used: number; free_gender_change_used: number;
    rename_card_quantity: number; gender_card_quantity: number;
  })[]>(
    `SELECT c.name,c.gender,c.free_name_change_used,c.free_gender_change_used,
      COALESCE((SELECT pi.quantity FROM player_inventory pi JOIN item_definitions i ON i.id=pi.item_id
        WHERE pi.character_id=c.id AND i.code='rename_card' LIMIT 1),0) AS rename_card_quantity,
      COALESCE((SELECT pi.quantity FROM player_inventory pi JOIN item_definitions i ON i.id=pi.item_id
        WHERE pi.character_id=c.id AND i.code='gender_change_card' LIMIT 1),0) AS gender_card_quantity
     FROM characters c WHERE c.player_id=? LIMIT 1`, [ownerId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    name: row.name,
    gender: row.gender,
    rename: { freeRemaining: Number(row.free_name_change_used) ? 0 : 1, cardQuantity: Math.max(0, Number(row.rename_card_quantity) || 0), itemName: '改名卡', code: 'rename_card', requiredQuantity: 1 },
    genderChange: { freeRemaining: Number(row.free_gender_change_used) ? 0 : 1, cardQuantity: Math.max(0, Number(row.gender_card_quantity) || 0), itemName: '改性卡', code: 'gender_change_card', requiredQuantity: 1 }
  };
};
