import { getPool, withTransaction } from "../database/pool.js";
import { promisify } from "node:util";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

//#region src/game/app-channel.service.ts
const GAME_ID_BASE = 1e7;
const BINDING_CODE_TTL_MINUTES = 10;
const SESSION_TTL_DAYS = 30;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_LOCK_MINUTES = 15;
const scrypt$1 = promisify(scrypt);
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
const passwordHash = async (password) => {
	const salt = randomBytes(16).toString("hex");
	return `scrypt$${salt}$${(await scrypt$1(password, salt, 64)).toString("hex")}`;
};
const passwordMatches = async (password, encoded) => {
	const [algorithm, salt, expected] = String(encoded ?? "").split("$");
	if (algorithm !== "scrypt" || !salt || !expected) return false;
	const actual = await scrypt$1(password, salt, 64);
	const target = Buffer.from(expected, "hex");
	return target.length === actual.length && timingSafeEqual(target, actual);
};
const validPassword = (password) => password.length >= 8 && password.length <= 64 && password.trim().length > 0;
const playerIdByGameId = async (connection, gameId) => {
	const [rows] = await connection.execute("SELECT player_id FROM characters WHERE game_id=? AND npc_code IS NULL LIMIT 1", [gameId]);
	return rows[0] ? Number(rows[0].player_id) : null;
};
const parseGameId = (v) => {
	const n = Number(String(v ?? "").trim());
	if (!Number.isFinite(n) || n < GAME_ID_BASE) throw new Error("Game ID 格式错误。");
	return n;
};
const assertPassword = (password, field = "密码") => {
	const value = String(password ?? "");
	if (!validPassword(value)) throw new Error(`${field}长度必须为 8～64 位，且不能是空白。`);
	return value;
};
const bindingCode = () => String(randomBytes(4).readUInt32BE(0) % 1e6).padStart(6, "0");
const qqUserIdForPlayer = async (connection, playerId) => {
	const [rows] = await connection.execute("SELECT qq_user_id FROM players WHERE id=? LIMIT 1", [playerId]);
	return String(rows[0]?.qq_user_id ?? "");
};
const createAppUser = async (displayName) => {
	const safeName = String(displayName ?? "").trim().slice(0, 32) || "旅人";
	const qqUserId = `app_${randomBytes(8).toString("hex")}`;
	const token = randomBytes(32).toString("base64url");
	return withTransaction(async (connection) => {
		const [result] = await connection.execute("INSERT INTO players (qq_user_id,qq_nickname) VALUES (?,?)", [qqUserId, safeName]);
		const playerId = Number(result.insertId);
		await connection.execute(`INSERT INTO app_sessions (player_id,token_hash,expires_at) VALUES (?,?,DATE_ADD(NOW(),INTERVAL ? DAY))`, [
			playerId,
			tokenHash(token),
			SESSION_TTL_DAYS
		]);
		return {
			gameUserId: "",
			token,
			qqUserId
		};
	});
};
const createSession = async (connection, playerId) => {
	const token = randomBytes(32).toString("base64url");
	await connection.execute(`INSERT INTO app_sessions (player_id,token_hash,expires_at) VALUES (?,?,DATE_ADD(NOW(),INTERVAL ? DAY))`, [
		playerId,
		tokenHash(token),
		SESSION_TTL_DAYS
	]);
	return token;
};
const loginAppUser = async (gameUserIdValue, passwordValue) => {
	const password = String(passwordValue ?? "");
	const gameId = parseGameId(gameUserIdValue);
	if (!validPassword(password)) throw new Error("Game ID 或密码错误。");
	return withTransaction(async (connection) => {
		const playerId = await playerIdByGameId(connection, gameId);
		if (!playerId) throw new Error("Game ID 或密码错误。");
		const [rows] = await connection.execute(`SELECT id,password_hash,status,failed_login_count,locked_until,qq_user_id
       FROM players WHERE id=? LIMIT 1 FOR UPDATE`, [playerId]);
		const row = rows[0];
		const lockedUntil = row?.locked_until ? new Date(row.locked_until).getTime() : 0;
		if (!row || String(row.status) !== "active" || lockedUntil > Date.now()) throw new Error("Game ID 或密码错误。");
		if (!await passwordMatches(password, row.password_hash)) {
			await connection.execute(`UPDATE players SET failed_login_count=failed_login_count+1,
         locked_until=CASE WHEN failed_login_count+1>=? THEN DATE_ADD(NOW(),INTERVAL ? MINUTE) ELSE locked_until END
         WHERE id=?`, [
				LOGIN_FAILURE_LIMIT,
				LOGIN_LOCK_MINUTES,
				playerId
			]);
			throw new Error("Game ID 或密码错误。");
		}
		await connection.execute("UPDATE players SET failed_login_count=0,locked_until=NULL,last_login_at=NOW() WHERE id=?", [playerId]);
		const token = await createSession(connection, playerId);
		return {
			gameUserId: String(gameId),
			token,
			qqUserId: String(row.qq_user_id ?? "")
		};
	});
};
const setAppPassword = async (gameUserIdValue, passwordValue) => {
	const gameId = parseGameId(gameUserIdValue);
	const password = assertPassword(passwordValue, "新密码");
	return withTransaction(async (connection) => {
		const playerId = await playerIdByGameId(connection, gameId);
		if (!playerId) throw new Error("账号不可用。");
		const [rows] = await connection.execute("SELECT password_hash,status FROM players WHERE id=? LIMIT 1 FOR UPDATE", [playerId]);
		const row = rows[0];
		if (!row || String(row.status) !== "active") throw new Error("账号不可用。");
		if (row.password_hash) throw new Error("账号已设置密码，请使用修改密码。");
		const hash = await passwordHash(password);
		await connection.execute("UPDATE players SET password_hash=?,password_updated_at=NOW(),failed_login_count=0,locked_until=NULL WHERE id=?", [hash, playerId]);
		await connection.execute("DELETE FROM app_sessions WHERE player_id=?", [playerId]);
		return { token: await createSession(connection, playerId) };
	});
};
const changeAppPassword = async (gameUserIdValue, currentPasswordValue, passwordValue) => {
	const gameId = parseGameId(gameUserIdValue);
	const currentPassword = String(currentPasswordValue ?? "");
	const password = assertPassword(passwordValue, "新密码");
	if (!validPassword(currentPassword)) throw new Error("当前密码错误。");
	return withTransaction(async (connection) => {
		const playerId = await playerIdByGameId(connection, gameId);
		if (!playerId) throw new Error("当前密码错误。");
		const [rows] = await connection.execute("SELECT password_hash,status FROM players WHERE id=? LIMIT 1 FOR UPDATE", [playerId]);
		const row = rows[0];
		if (!row || String(row.status) !== "active" || !await passwordMatches(currentPassword, row.password_hash)) throw new Error("当前密码错误。");
		const hash = await passwordHash(password);
		await connection.execute("UPDATE players SET password_hash=?,password_updated_at=NOW(),failed_login_count=0,locked_until=NULL WHERE id=?", [hash, playerId]);
		await connection.execute("DELETE FROM app_sessions WHERE player_id=?", [playerId]);
		return { token: await createSession(connection, playerId) };
	});
};
const setAppPasswordByQqUser = async (qqUserId, passwordValue) => {
	const password = assertPassword(passwordValue, "新密码");
	return withTransaction(async (connection) => {
		const [players] = await connection.execute("SELECT id,password_hash,status FROM players WHERE qq_user_id=? LIMIT 1 FOR UPDATE", [qqUserId]);
		const player = players[0];
		if (!player || String(player.status) !== "active") throw new Error("账号不可用。");
		if (player.password_hash) throw new Error("已设置密码，请使用“修改密码”。");
		const [characters] = await connection.execute("SELECT game_id FROM characters WHERE player_id=? AND npc_code IS NULL LIMIT 1", [Number(player.id)]);
		if (!characters[0]?.game_id) throw new Error("尚未完成角色创建，无法设置跨平台密码。");
		const hash = await passwordHash(password);
		await connection.execute("UPDATE players SET password_hash=?,password_updated_at=NOW(),failed_login_count=0,locked_until=NULL WHERE id=?", [hash, Number(player.id)]);
		return { gameUserId: String(characters[0].game_id) };
	});
};
const setAppPasswordByPlayerId = async (playerId, passwordValue) => {
	const password = assertPassword(passwordValue, "新密码");
	return withTransaction(async (connection) => {
		const [rows] = await connection.execute("SELECT password_hash,status FROM players WHERE id=? LIMIT 1 FOR UPDATE", [playerId]);
		const row = rows[0];
		if (!row || String(row.status) !== "active") throw new Error("账号不可用。");
		if (row.password_hash) throw new Error("账号已设置密码，请使用修改密码。");
		const hash = await passwordHash(password);
		await connection.execute("UPDATE players SET password_hash=?,password_updated_at=NOW(),failed_login_count=0,locked_until=NULL WHERE id=?", [hash, playerId]);
		await connection.execute("DELETE FROM app_sessions WHERE player_id=?", [playerId]);
		return { token: await createSession(connection, playerId) };
	});
};
const changeAppPasswordByQqUser = async (qqUserId, currentPasswordValue, passwordValue) => {
	const currentPassword = String(currentPasswordValue ?? "");
	const password = assertPassword(passwordValue, "新密码");
	if (!validPassword(currentPassword)) throw new Error("当前密码错误。");
	return withTransaction(async (connection) => {
		const [players] = await connection.execute("SELECT id,password_hash,status FROM players WHERE qq_user_id=? LIMIT 1 FOR UPDATE", [qqUserId]);
		const player = players[0];
		if (!player || String(player.status) !== "active" || !await passwordMatches(currentPassword, player.password_hash)) throw new Error("当前密码错误。");
		const [characters] = await connection.execute("SELECT game_id FROM characters WHERE player_id=? AND npc_code IS NULL LIMIT 1", [Number(player.id)]);
		if (!characters[0]?.game_id) throw new Error("尚未完成角色创建，无法修改跨平台密码。");
		const hash = await passwordHash(password);
		await connection.execute("UPDATE players SET password_hash=?,password_updated_at=NOW(),failed_login_count=0,locked_until=NULL WHERE id=?", [hash, Number(player.id)]);
		return { gameUserId: String(characters[0].game_id) };
	});
};
const changeAppPasswordByPlayerId = async (playerId, currentPasswordValue, passwordValue) => {
	const currentPassword = String(currentPasswordValue ?? "");
	const password = assertPassword(passwordValue, "新密码");
	if (!validPassword(currentPassword)) throw new Error("当前密码错误。");
	return withTransaction(async (connection) => {
		const [rows] = await connection.execute("SELECT password_hash,status FROM players WHERE id=? LIMIT 1 FOR UPDATE", [playerId]);
		const row = rows[0];
		if (!row || String(row.status) !== "active" || !await passwordMatches(currentPassword, row.password_hash)) throw new Error("当前密码错误。");
		const hash = await passwordHash(password);
		await connection.execute("UPDATE players SET password_hash=?,password_updated_at=NOW(),failed_login_count=0,locked_until=NULL WHERE id=?", [hash, playerId]);
		await connection.execute("DELETE FROM app_sessions WHERE player_id=?", [playerId]);
		return { token: await createSession(connection, playerId) };
	});
};
const logoutAppSession = async (token) => {
	const normalized = String(token ?? "").trim();
	if (!normalized) return;
	await (await getPool()).execute("DELETE FROM app_sessions WHERE token_hash=?", [tokenHash(normalized)]);
};
const issueBindingCode = async (qqUserId) => {
	const code = bindingCode();
	await withTransaction(async (connection) => {
		await connection.execute(`INSERT INTO app_binding_codes (qq_user_id,code,expires_at) VALUES (?,?,DATE_ADD(NOW(),INTERVAL ? MINUTE))`, [
			qqUserId,
			code,
			BINDING_CODE_TTL_MINUTES
		]);
	});
	return code;
};
const bindAppUser = async (gameUserIdValue, code) => {
	const normalized = String(code ?? "").trim();
	if (!/^\d{6}$/.test(normalized)) throw new Error("绑定码必须是 6 位数字。");
	return withTransaction(async (connection) => {
		const [rows] = await connection.execute(`SELECT id,qq_user_id,expires_at,used_by_app_user FROM app_binding_codes WHERE code=? LIMIT 1 FOR UPDATE`, [normalized]);
		const binding = rows[0];
		if (!binding || new Date(binding.expires_at).getTime() < Date.now()) throw new Error("绑定码不存在或已过期。");
		if (binding.used_by_app_user) throw new Error("绑定码已使用。");
		const [players] = await connection.execute("SELECT id FROM players WHERE qq_user_id=? LIMIT 1 FOR UPDATE", [binding.qq_user_id]);
		if (!players[0]) throw new Error("绑定的玩家不存在。");
		await connection.execute(`UPDATE app_binding_codes SET used_by_app_user=?,used_at=NOW() WHERE id=?`, [gameUserIdValue, binding.id]);
		const [characters] = await connection.execute("SELECT id FROM characters WHERE player_id=? LIMIT 1", [players[0].id]);
		return {
			qqUserId: String(binding.qq_user_id),
			characterId: characters[0] ? Number(characters[0].id) : null
		};
	});
};
const sessionForApp = async (token) => {
	const pool = await getPool();
	const hash = tokenHash(String(token ?? "").trim());
	const [rows] = await pool.execute(`SELECT s.player_id,p.qq_nickname,p.password_hash,p.id AS player_id,c.id AS character_id,c.game_id AS game_id
     FROM app_sessions s
     JOIN players p ON p.id=s.player_id
     LEFT JOIN characters c ON c.player_id=p.id AND c.npc_code IS NULL
     WHERE s.token_hash=? AND s.expires_at>NOW() AND p.status='active' LIMIT 1`, [hash]);
	const row = rows[0];
	if (!row) return null;
	return {
		gameUserId: row.game_id ? String(row.game_id) : "",
		displayName: String(row.qq_nickname ?? ""),
		passwordLoginEnabled: Boolean(row.password_hash),
		playerId: Number(row.player_id ?? 0),
		characterId: row.character_id ? Number(row.character_id) : null
	};
};
const appSessionQqUser = async (session, pool) => {
	const connection = pool ?? await getPool();
	return qqUserIdForPlayer(connection, session.playerId);
};
const appUserIdentity = async (gameUserIdValue) => {
	const pool = await getPool();
	const gameId = parseGameId(gameUserIdValue);
	const playerId = await playerIdByGameId(pool, gameId);
	if (!playerId) return {
		qqUserId: "",
		playerId: null,
		characterId: null
	};
	const [rows] = await pool.execute(`SELECT p.id AS player_id,p.qq_user_id,c.id AS character_id
     FROM players p LEFT JOIN characters c ON c.player_id=p.id AND c.npc_code IS NULL
     WHERE p.id=? LIMIT 1`, [playerId]);
	const row = rows[0];
	return {
		qqUserId: String(row?.qq_user_id ?? ""),
		playerId: row?.player_id ? Number(row.player_id) : null,
		characterId: row?.character_id ? Number(row.character_id) : null
	};
};
const revokeAppBinding = async (gameUserIdValue) => {
	const gameId = parseGameId(gameUserIdValue);
	await withTransaction(async (connection) => {
		const playerId = await playerIdByGameId(connection, gameId);
		if (!playerId) return;
		await connection.execute("DELETE FROM app_sessions WHERE player_id=?", [playerId]);
	});
};
const appCommandContext = async (gameUserIdValue) => {
	const gameId = parseGameId(gameUserIdValue);
	const pool = await getPool();
	const playerId = await playerIdByGameId(pool, gameId);
	if (!playerId) throw new Error("玩家不存在。");
	return { qqUserId: await qqUserIdForPlayer(pool, playerId) };
};

//#endregion
export { appCommandContext, appSessionQqUser, appUserIdentity, bindAppUser, changeAppPassword, changeAppPasswordByPlayerId, changeAppPasswordByQqUser, createAppUser, issueBindingCode, loginAppUser, logoutAppSession, revokeAppBinding, sessionForApp, setAppPassword, setAppPasswordByPlayerId, setAppPasswordByQqUser };