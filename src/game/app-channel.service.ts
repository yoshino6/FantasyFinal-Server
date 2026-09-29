import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { getPool, withTransaction } from '../database/pool';

const GAME_ID_BASE = 10_000_000;
const BINDING_CODE_TTL_MINUTES = 10;
const SESSION_TTL_DAYS = 30;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_LOCK_MINUTES = 15;
const scrypt = promisify(scryptCallback);

export type AppSession = {
  loginId: string;
  gameUserId: string;
  displayName: string;
  passwordLoginEnabled: boolean;
  playerId: number;
  characterId: number | null;
};

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

const passwordHash = async (password: string) => {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${derived.toString('hex')}`;
};

const passwordMatches = async (password: string, encoded: string | null | undefined) => {
  const [algorithm, salt, expected] = String(encoded ?? '').split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const actual = await scrypt(password, salt, 64) as Buffer;
  const target = Buffer.from(expected, 'hex');
  return target.length === actual.length && timingSafeEqual(target, actual);
};

const validPassword = (password: string) => password.length >= 8 && password.length <= 64 && password.trim().length > 0;

// game_id 对应 characters.game_id（10000000 + characters.id），反查 player_id
const playerIdByGameId = async (connection: Pool | PoolConnection, gameId: number): Promise<number | null> => {
  const [rows] = await connection.execute<RowDataPacket[]>(
    'SELECT player_id FROM characters WHERE game_id=? AND npc_code IS NULL LIMIT 1',
    [gameId]
  );
  return rows[0] ? Number(rows[0].player_id) : null;
};

const parseGameId = (v: unknown): number => {
  const n = Number(String(v ?? '').trim());
  if (!Number.isFinite(n) || n < GAME_ID_BASE) throw new Error('Game ID 格式错误。');
  return n;
};

const assertPassword = (password: unknown, field = '密码') => {
  const value = String(password ?? '');
  if (!validPassword(value)) throw new Error(`${field}长度必须为 8～64 位，且不能是空白。`);
  return value;
};

const bindingCode = () => String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
const newLoginId = () => `H-${randomBytes(14).toString('hex').toUpperCase()}`;
const appAccountAvailable = (row: RowDataPacket | undefined) => Boolean(row && (
  String(row.status) === 'active' ||
  (String(row.status) === 'registering' && String(row.qq_user_id ?? '').startsWith('app_'))
));

const qqUserIdForPlayer = async (connection: Pool | PoolConnection, playerId: number): Promise<string> => {
  const [rows] = await connection.execute<RowDataPacket[]>(
    'SELECT qq_user_id FROM players WHERE id=? LIMIT 1',
    [playerId]
  );
  return String(rows[0]?.qq_user_id ?? '');
};

// 注册即生成独立于角色的永久登录号；密码、玩家和会话在同一事务内落库。
export const createAppUser = async (displayName: string, passwordValue: unknown): Promise<{ loginId: string; gameUserId: string; token: string; qqUserId: string }> => {
  const safeName = String(displayName ?? '').trim().slice(0, 32) || '旅人';
  const password = assertPassword(passwordValue);
  const hash = await passwordHash(password);
  const qqUserId = `app_${randomBytes(8).toString('hex')}`;
  const loginId = newLoginId();
  const token = randomBytes(32).toString('base64url');
  return withTransaction(async connection => {
    const [result] = await connection.execute(
      "INSERT INTO players (qq_user_id,app_login_id,qq_nickname,password_hash,password_updated_at,status) VALUES (?,?,?,?,NOW(),'active')",
      [qqUserId, loginId, safeName, hash]
    );
    const playerId = Number((result as any).insertId);
    await connection.execute(
      `INSERT INTO app_sessions (player_id,token_hash,expires_at) VALUES (?,?,DATE_ADD(NOW(),INTERVAL ? DAY))`,
      [playerId, tokenHash(token), SESSION_TTL_DAYS]
    );
    return { loginId, gameUserId: '', token, qqUserId };
  });
};

const createSession = async (connection: Pool | PoolConnection, playerId: number) => {
  const token = randomBytes(32).toString('base64url');
  await connection.execute(
    `INSERT INTO app_sessions (player_id,token_hash,expires_at) VALUES (?,?,DATE_ADD(NOW(),INTERVAL ? DAY))`,
    [playerId, tokenHash(token), SESSION_TTL_DAYS]
  );
  return token;
};

// 旧版会话只记录 app_user_id；改密时也需撤销这些仍可访问同一玩家的会话。
const revokePlayerSessions = async (connection: Pool | PoolConnection, playerId: number) => {
  await connection.execute(
    `DELETE s FROM app_sessions s
     LEFT JOIN player_app_bindings b ON b.app_user_id=s.app_user_id
     LEFT JOIN players own_player ON own_player.qq_user_id=s.app_user_id
     WHERE s.player_id=? OR (s.player_id IS NULL AND COALESCE(b.player_id,own_player.id)=?)`,
    [playerId, playerId]
  );
};

// 永久 H 登录号在建角前即可使用；建角后也兼容数字 Game ID。
export const loginAppUser = async (loginIdValue: unknown, passwordValue: unknown): Promise<{ loginId: string; gameUserId: string; token: string; qqUserId: string }> => {
  const password = String(passwordValue ?? '');
  const identifier = String(loginIdValue ?? '').trim().toUpperCase();
  const appLoginId = /^H-[A-Z0-9]{3,30}$/.test(identifier) ? identifier : null;
  const gameId = /^\d+$/.test(identifier) ? Number(identifier) : null;
  const failureMessage = '登录号或密码错误。';
  if (!validPassword(password) || (!appLoginId && (!Number.isSafeInteger(gameId) || Number(gameId) < GAME_ID_BASE))) throw new Error(failureMessage);
  const result = await withTransaction(async connection => {
    const playerId = appLoginId
      ? Number((await connection.execute<RowDataPacket[]>('SELECT id FROM players WHERE app_login_id=? LIMIT 1', [appLoginId]))[0][0]?.id ?? 0)
      : await playerIdByGameId(connection, Number(gameId));
    if (!playerId) return { ok: false as const };
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id,app_login_id,password_hash,status,failed_login_count,locked_until,qq_user_id
       FROM players WHERE id=? LIMIT 1 FOR UPDATE`,
      [playerId]
    );
    const row = rows[0];
    const lockedUntil = row?.locked_until ? new Date(row.locked_until).getTime() : 0;
    if (!appAccountAvailable(row) || (lockedUntil > Date.now())) return { ok: false as const };
    const matches = await passwordMatches(password, row.password_hash);
    if (!matches) {
      const failures = lockedUntil && lockedUntil <= Date.now() ? 1 : Number(row.failed_login_count ?? 0) + 1;
      await connection.execute(
        `UPDATE players SET failed_login_count=?,
         locked_until=CASE WHEN ? >= ? THEN DATE_ADD(NOW(),INTERVAL ? MINUTE) ELSE NULL END
         WHERE id=?`,
        [failures, failures, LOGIN_FAILURE_LIMIT, LOGIN_LOCK_MINUTES, playerId]
      );
      return { ok: false as const };
    }
    await connection.execute('UPDATE players SET failed_login_count=0,locked_until=NULL,last_login_at=NOW() WHERE id=?', [playerId]);
    const token = await createSession(connection, playerId);
    const [characters] = await connection.execute<RowDataPacket[]>(
      'SELECT game_id FROM characters WHERE player_id=? AND npc_code IS NULL LIMIT 1',
      [playerId]
    );
    const gameUserId = characters[0]?.game_id ? String(characters[0].game_id) : '';
    const qqUserId = String(row.qq_user_id ?? '');
    return { ok: true as const, loginId: String(row.app_login_id ?? ''), gameUserId, token, qqUserId };
  });
  if (!result.ok) throw new Error(failureMessage);
  return result;
};

// 设置密码：QQ 玩家随时可设置（通过 qq_user_id 定位），桌宠端通过 session 定位
export const setAppPassword = async (gameUserIdValue: string, passwordValue: unknown): Promise<{ token: string }> => {
  const gameId = parseGameId(gameUserIdValue);
  const password = assertPassword(passwordValue, '新密码');
  return withTransaction(async connection => {
    const playerId = await playerIdByGameId(connection, gameId);
    if (!playerId) throw new Error('账号不可用。');
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT password_hash,status FROM players WHERE id=? LIMIT 1 FOR UPDATE',
      [playerId]
    );
    const row = rows[0];
    if (!row || String(row.status) !== 'active') throw new Error('账号不可用。');
    if (row.password_hash) throw new Error('账号已设置密码，请使用修改密码。');
    const hash = await passwordHash(password);
    await connection.execute('UPDATE players SET password_hash=?,password_updated_at=NOW(),failed_login_count=0,locked_until=NULL WHERE id=?', [hash, playerId]);
    await revokePlayerSessions(connection, playerId);
    const token = await createSession(connection, playerId);
    return { token };
  });
};

// 修改密码
export const changeAppPassword = async (gameUserIdValue: string, currentPasswordValue: unknown, passwordValue: unknown): Promise<{ token: string }> => {
  const gameId = parseGameId(gameUserIdValue);
  const currentPassword = String(currentPasswordValue ?? '');
  const password = assertPassword(passwordValue, '新密码');
  if (!validPassword(currentPassword)) throw new Error('当前密码错误。');
  return withTransaction(async connection => {
    const playerId = await playerIdByGameId(connection, gameId);
    if (!playerId) throw new Error('当前密码错误。');
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT password_hash,status FROM players WHERE id=? LIMIT 1 FOR UPDATE',
      [playerId]
    );
    const row = rows[0];
    if (!row || String(row.status) !== 'active' || !await passwordMatches(currentPassword, row.password_hash)) throw new Error('当前密码错误。');
    const hash = await passwordHash(password);
    await connection.execute('UPDATE players SET password_hash=?,password_updated_at=NOW(),failed_login_count=0,locked_until=NULL WHERE id=?', [hash, playerId]);
    await revokePlayerSessions(connection, playerId);
    const token = await createSession(connection, playerId);
    return { token };
  });
};

// QQ 玩家通过 qq_user_id 设置密码（未设置时）
export const setAppPasswordByQqUser = async (qqUserId: string, passwordValue: unknown): Promise<{ gameUserId: string }> => {
  const password = assertPassword(passwordValue, '新密码');
  return withTransaction(async connection => {
    const [players] = await connection.execute<RowDataPacket[]>(
      'SELECT id,password_hash,status FROM players WHERE qq_user_id=? LIMIT 1 FOR UPDATE',
      [qqUserId]
    );
    const player = players[0];
    if (!player || String(player.status) !== 'active') throw new Error('账号不可用。');
    if (player.password_hash) throw new Error('已设置密码，请使用“修改密码”。');
    const [characters] = await connection.execute<RowDataPacket[]>(
      'SELECT game_id FROM characters WHERE player_id=? AND npc_code IS NULL LIMIT 1',
      [Number(player.id)]
    );
    if (!characters[0]?.game_id) throw new Error('尚未完成角色创建，无法设置跨平台密码。');
    const hash = await passwordHash(password);
    await connection.execute('UPDATE players SET password_hash=?,password_updated_at=NOW(),failed_login_count=0,locked_until=NULL WHERE id=?', [hash, Number(player.id)]);
    await revokePlayerSessions(connection, Number(player.id));
    return { gameUserId: String(characters[0].game_id) };
  });
};

// 已登录会话按 playerId 设置密码（角色可能尚未创建，Game ID 可能为空）
export const setAppPasswordByPlayerId = async (playerId: number, passwordValue: unknown): Promise<{ token: string }> => {
  const password = assertPassword(passwordValue, '新密码');
  return withTransaction(async connection => {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT qq_user_id,password_hash,status FROM players WHERE id=? LIMIT 1 FOR UPDATE',
      [playerId]
    );
    const row = rows[0];
    if (!appAccountAvailable(row)) throw new Error('账号不可用。');
    if (row.password_hash) throw new Error('账号已设置密码，请使用修改密码。');
    const hash = await passwordHash(password);
    await connection.execute('UPDATE players SET password_hash=?,password_updated_at=NOW(),failed_login_count=0,locked_until=NULL WHERE id=?', [hash, playerId]);
    await revokePlayerSessions(connection, playerId);
    return { token: await createSession(connection, playerId) };
  });
};

// QQ 玩家修改密码
export const changeAppPasswordByQqUser = async (qqUserId: string, currentPasswordValue: unknown, passwordValue: unknown): Promise<{ gameUserId: string }> => {
  const currentPassword = String(currentPasswordValue ?? '');
  const password = assertPassword(passwordValue, '新密码');
  if (!validPassword(currentPassword)) throw new Error('当前密码错误。');
  return withTransaction(async connection => {
    const [players] = await connection.execute<RowDataPacket[]>(
      'SELECT id,password_hash,status FROM players WHERE qq_user_id=? LIMIT 1 FOR UPDATE',
      [qqUserId]
    );
    const player = players[0];
    if (!player || String(player.status) !== 'active' || !await passwordMatches(currentPassword, player.password_hash)) throw new Error('当前密码错误。');
    const [characters] = await connection.execute<RowDataPacket[]>(
      'SELECT game_id FROM characters WHERE player_id=? AND npc_code IS NULL LIMIT 1',
      [Number(player.id)]
    );
    if (!characters[0]?.game_id) throw new Error('尚未完成角色创建，无法修改跨平台密码。');
    const hash = await passwordHash(password);
    await connection.execute('UPDATE players SET password_hash=?,password_updated_at=NOW(),failed_login_count=0,locked_until=NULL WHERE id=?', [hash, Number(player.id)]);
    await revokePlayerSessions(connection, Number(player.id));
    return { gameUserId: String(characters[0].game_id) };
  });
};

// 已登录会话按 playerId 修改密码
export const changeAppPasswordByPlayerId = async (playerId: number, currentPasswordValue: unknown, passwordValue: unknown): Promise<{ token: string }> => {
  const currentPassword = String(currentPasswordValue ?? '');
  const password = assertPassword(passwordValue, '新密码');
  if (!validPassword(currentPassword)) throw new Error('当前密码错误。');
  return withTransaction(async connection => {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT qq_user_id,password_hash,status FROM players WHERE id=? LIMIT 1 FOR UPDATE',
      [playerId]
    );
    const row = rows[0];
    if (!appAccountAvailable(row) || !await passwordMatches(currentPassword, row.password_hash)) throw new Error('当前密码错误。');
    const hash = await passwordHash(password);
    await connection.execute('UPDATE players SET password_hash=?,password_updated_at=NOW(),failed_login_count=0,locked_until=NULL WHERE id=?', [hash, playerId]);
    await revokePlayerSessions(connection, playerId);
    return { token: await createSession(connection, playerId) };
  });
};

export const logoutAppSession = async (token: string) => {
  const normalized = String(token ?? '').trim();
  if (!normalized) return;
  const pool = await getPool();
  await pool.execute('DELETE FROM app_sessions WHERE token_hash=?', [tokenHash(normalized)]);
};

export const issueBindingCode = async (qqUserId: string): Promise<string> => {
  const code = bindingCode();
  await withTransaction(async connection => {
    await connection.execute(
      `INSERT INTO app_binding_codes (qq_user_id,code,expires_at) VALUES (?,?,DATE_ADD(NOW(),INTERVAL ? MINUTE))`,
      [qqUserId, code, BINDING_CODE_TTL_MINUTES]
    );
  });
  return code;
};

export const bindAppUser = async (gameUserIdValue: string, code: string): Promise<{ qqUserId: string; characterId: number | null }> => {
  const normalized = String(code ?? '').trim();
  if (!/^\d{6}$/.test(normalized)) throw new Error('绑定码必须是 6 位数字。');
  return withTransaction(async connection => {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id,qq_user_id,expires_at,used_by_app_user FROM app_binding_codes WHERE code=? LIMIT 1 FOR UPDATE`,
      [normalized]
    );
    const binding = rows[0];
    if (!binding || new Date(binding.expires_at).getTime() < Date.now()) throw new Error('绑定码不存在或已过期。');
    if (binding.used_by_app_user) throw new Error('绑定码已使用。');
    const [players] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM players WHERE qq_user_id=? LIMIT 1 FOR UPDATE',
      [binding.qq_user_id]
    );
    if (!players[0]) throw new Error('绑定的玩家不存在。');
    await connection.execute(
      `UPDATE app_binding_codes SET used_by_app_user=?,used_at=NOW() WHERE id=?`,
      [gameUserIdValue, binding.id]
    );
    const [characters] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM characters WHERE player_id=? LIMIT 1',
      [players[0].id]
    );
    return { qqUserId: String(binding.qq_user_id), characterId: characters[0] ? Number(characters[0].id) : null };
  });
};

export const sessionForApp = async (token: string): Promise<AppSession | null> => {
  const pool = await getPool();
  const hash = tokenHash(String(token ?? '').trim());
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT s.player_id,p.qq_nickname,p.app_login_id,p.password_hash,p.id AS player_id,c.id AS character_id,c.game_id AS game_id
     FROM app_sessions s
     JOIN players p ON p.id=s.player_id
     LEFT JOIN characters c ON c.player_id=p.id AND c.npc_code IS NULL
     WHERE s.token_hash=? AND s.expires_at>NOW()
       AND (p.status='active' OR (p.status='registering' AND LEFT(p.qq_user_id,4)='app_')) LIMIT 1`,
    [hash]
  );
  let row = rows[0];
  if (!row) {
    // 只兼容旧版的有效会话：绑定过 QQ 的账号沿用绑定玩家，否则使用原 app_ 玩家。
    const [legacyRows] = await pool.execute<RowDataPacket[]>(
      `SELECT p.id AS player_id,p.qq_nickname,p.app_login_id,p.password_hash,c.id AS character_id,c.game_id AS game_id
       FROM app_sessions s
       JOIN app_users au ON au.app_user_id=s.app_user_id AND au.status='active'
       LEFT JOIN player_app_bindings b ON b.app_user_id=au.app_user_id
       LEFT JOIN players own_player ON own_player.qq_user_id=au.app_user_id
       JOIN players p ON p.id=COALESCE(b.player_id,own_player.id)
       LEFT JOIN characters c ON c.player_id=p.id AND c.npc_code IS NULL
       WHERE s.token_hash=? AND s.expires_at>NOW() AND s.player_id IS NULL
         AND LEFT(au.app_user_id,4)='app_'
         AND (p.status='active' OR (p.status='registering' AND LEFT(p.qq_user_id,4)='app_'))
       LIMIT 1`,
      [hash]
    );
    row = legacyRows[0];
  }
  if (!row) return null;
  return {
    loginId: String(row.app_login_id ?? ''),
    gameUserId: row.game_id ? String(row.game_id) : '',
    displayName: String(row.qq_nickname ?? ''),
    passwordLoginEnabled: Boolean(row.password_hash),
    playerId: Number(row.player_id ?? 0),
    characterId: row.character_id ? Number(row.character_id) : null
  };
};

// 获取 session 对应玩家的 qq_user_id（QQ 平台标识，用于游戏内命令）
export const appSessionQqUser = async (session: AppSession, pool?: Pool): Promise<string> => {
  const connection = pool ?? await getPool();
  return qqUserIdForPlayer(connection, session.playerId);
};

export const appUserIdentity = async (gameUserIdValue: string): Promise<{ qqUserId: string; playerId: number | null; characterId: number | null }> => {
  const pool = await getPool();
  const gameId = parseGameId(gameUserIdValue);
  const playerId = await playerIdByGameId(pool, gameId);
  if (!playerId) return { qqUserId: '', playerId: null, characterId: null };
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT p.id AS player_id,p.qq_user_id,c.id AS character_id
     FROM players p LEFT JOIN characters c ON c.player_id=p.id AND c.npc_code IS NULL
     WHERE p.id=? LIMIT 1`,
    [playerId]
  );
  const row = rows[0];
  return {
    qqUserId: String(row?.qq_user_id ?? ''),
    playerId: row?.player_id ? Number(row.player_id) : null,
    characterId: row?.character_id ? Number(row.character_id) : null
  };
};

export const revokeAppBinding = async (gameUserIdValue: string) => {
  const gameId = parseGameId(gameUserIdValue);
  await withTransaction(async connection => {
    const playerId = await playerIdByGameId(connection, gameId);
    if (!playerId) return;
    await revokePlayerSessions(connection, playerId);
  });
};

export const appCommandContext = async (gameUserIdValue: string): Promise<{ qqUserId: string }> => {
  const gameId = parseGameId(gameUserIdValue);
  const pool = await getPool();
  const playerId = await playerIdByGameId(pool, gameId);
  if (!playerId) throw new Error('玩家不存在。');
  const qqUserId = await qqUserIdForPlayer(pool, playerId);
  return { qqUserId };
};
