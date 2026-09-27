import { getPool } from "../database/pool.js";
import { createParty, joinParty, partyInfo } from "../game/adventure.service.js";
import { appSessionQqUser } from "../game/app-channel.service.js";
import { randomBytes } from "node:crypto";

//#region src/app-api/social.service.ts
let schemaPromise = null;
const realtimeTickets = /* @__PURE__ */ new Map();
const chatRateWindows = /* @__PURE__ */ new Map();
const issueRealtimeTicket = (session) => {
	const now = Date.now();
	for (const [ticket, value] of realtimeTickets) if (value.expiresAt <= now) realtimeTickets.delete(ticket);
	const ticket = randomBytes(24).toString("base64url");
	realtimeTickets.set(ticket, {
		session,
		expiresAt: now + 6e4
	});
	return ticket;
};
const consumeRealtimeTicket = (ticketValue) => {
	const ticket = text(ticketValue, 128);
	const value = realtimeTickets.get(ticket);
	if (!value || value.expiresAt <= Date.now()) {
		realtimeTickets.delete(ticket);
		return null;
	}
	realtimeTickets.delete(ticket);
	return value.session;
};
/** H5 社交表按需创建，避免旧服必须额外跑一次迁移。 */
const ensureSchema = async () => {
	if (!schemaPromise) schemaPromise = (async () => {
		const pool = await getPool();
		await pool.query(`CREATE TABLE IF NOT EXISTS web_chat_messages (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        channel_key VARCHAR(128) NOT NULL,
        channel_type ENUM('world','friend','party') NOT NULL DEFAULT 'world',
        sender_player_id BIGINT UNSIGNED NOT NULL,
        sender_character_id BIGINT UNSIGNED NULL,
        sender_name VARCHAR(64) NOT NULL,
        content VARCHAR(500) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id), KEY idx_web_chat_channel (channel_key,id), KEY idx_web_chat_sender (sender_player_id,id)
      ) ENGINE=InnoDB`);
		await pool.query(`CREATE TABLE IF NOT EXISTS web_party_recruitments (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        party_id CHAR(36) NOT NULL,
        creator_character_id BIGINT UNSIGNED NOT NULL,
        title VARCHAR(80) NOT NULL,
        description VARCHAR(300) NOT NULL DEFAULT '',
        target_count TINYINT UNSIGNED NOT NULL DEFAULT 4,
        status ENUM('open','closed') NOT NULL DEFAULT 'open',
        expires_at DATETIME NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id), UNIQUE KEY uk_web_party_open (party_id,status), KEY idx_web_party_status (status,expires_at,created_at)
      ) ENGINE=InnoDB`);
		const [recruitmentColumns] = await pool.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='web_party_recruitments' AND COLUMN_NAME='open_party_id' LIMIT 1");
		if (!recruitmentColumns.length) try {
			await pool.query("ALTER TABLE web_party_recruitments ADD COLUMN open_party_id CHAR(36) GENERATED ALWAYS AS (IF(status='open',party_id,NULL)) STORED AFTER party_id");
		} catch (error) {
			if (error?.code !== "ER_DUP_FIELDNAME") throw error;
		}
		const [recruitmentIndexColumns] = await pool.query("SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='web_party_recruitments' AND INDEX_NAME='uk_web_party_open' ORDER BY SEQ_IN_INDEX");
		const usesOpenPartyColumn = recruitmentIndexColumns.length === 1 && recruitmentIndexColumns[0]?.COLUMN_NAME === "open_party_id";
		if (!usesOpenPartyColumn && recruitmentIndexColumns.length) try {
			await pool.query("ALTER TABLE web_party_recruitments DROP INDEX uk_web_party_open");
		} catch (error) {
			if (error?.code !== "ER_CANT_DROP_FIELD_OR_KEY") throw error;
		}
		if (!usesOpenPartyColumn) try {
			await pool.query("ALTER TABLE web_party_recruitments ADD UNIQUE KEY uk_web_party_open (open_party_id)");
		} catch (error) {
			if (error?.code !== "ER_DUP_KEYNAME") throw error;
		}
		await pool.query(`CREATE TABLE IF NOT EXISTS web_party_applications (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        recruitment_id BIGINT UNSIGNED NOT NULL,
        applicant_character_id BIGINT UNSIGNED NOT NULL,
        message VARCHAR(300) NOT NULL DEFAULT '',
        status ENUM('pending','accepted','rejected','cancelled') NOT NULL DEFAULT 'pending',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        responded_at DATETIME NULL,
        PRIMARY KEY (id), UNIQUE KEY uk_web_party_application (recruitment_id,applicant_character_id),
        KEY idx_web_party_application_status (recruitment_id,status,created_at)
      ) ENGINE=InnoDB`);
	})().catch((error) => {
		schemaPromise = null;
		throw error;
	});
	await schemaPromise;
};
const text = (value, max) => String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
const currentCharacter = (session) => {
	if (!session.characterId) throw new Error("请先完成角色注册。");
	return Number(session.characterId);
};
const channelParts = (channelId) => {
	const value = text(channelId, 128);
	if (value === "world") return {
		type: "world",
		key: value
	};
	const party = /^party:([0-9a-f]{8}-[0-9a-f-]{27})$/i.exec(value);
	if (party) return {
		type: "party",
		key: value,
		partyId: party[1]
	};
	const friend = /^friend:(\d+)$/.exec(value);
	if (friend) return {
		type: "friend",
		key: value,
		gameId: Number(friend[1])
	};
	throw new Error("聊天频道不存在。");
};
const assertChannelAccess = async (session, channelId, db) => {
	const channel = channelParts(channelId);
	if (channel.type === "world") return channel;
	const characterId = currentCharacter(session);
	const pool = db ?? await getPool();
	if (channel.type === "party") {
		const [rows] = await pool.execute("SELECT 1 FROM party_members WHERE party_id=? AND character_id=? LIMIT 1", [channel.partyId, characterId]);
		if (!rows[0]) throw new Error("你不在这个队伍中。");
		return channel;
	}
	const [rows] = await pool.execute(`SELECT 1 FROM player_relationships r JOIN characters c ON c.id=CASE WHEN r.character_low_id=? THEN r.character_high_id ELSE r.character_low_id END
    WHERE (r.character_low_id=? OR r.character_high_id=?) AND c.game_id=? AND r.status IN ('friend','oath') LIMIT 1`, [
		characterId,
		characterId,
		characterId,
		channel.gameId
	]);
	if (!rows[0]) throw new Error("只能向游戏内好友发送私聊。");
	return channel;
};
const sender = async (session, db) => {
	const characterId = session.characterId ? Number(session.characterId) : null;
	if (!characterId) return {
		characterId: null,
		name: text(session.displayName, 64) || "旅人"
	};
	const [rows] = await db.execute("SELECT name,player_id FROM characters WHERE id=? LIMIT 1", [characterId]);
	return {
		characterId,
		name: text(rows[0]?.name, 64) || text(session.displayName, 64) || "旅人",
		playerId: Number(rows[0]?.player_id ?? session.playerId)
	};
};
const listChatChannels = async (session) => {
	await ensureSchema();
	const pool = await getPool();
	const channels = [{
		id: "world",
		type: "world",
		name: "世界频道",
		unreadCount: 0
	}];
	if (!session.characterId) return channels;
	const characterId = Number(session.characterId);
	const [friends] = await pool.execute(`SELECT c.game_id,c.name FROM player_relationships r JOIN characters c ON c.id=CASE WHEN r.character_low_id=? THEN r.character_high_id ELSE r.character_low_id END
    WHERE (r.character_low_id=? OR r.character_high_id=?) AND r.status IN ('friend','oath') ORDER BY c.name LIMIT 50`, [
		characterId,
		characterId,
		characterId
	]);
	for (const friend of friends) channels.push({
		id: `friend:${Number(friend.game_id)}`,
		type: "friend",
		name: `好友·${text(friend.name, 32)}`,
		gameId: Number(friend.game_id),
		unreadCount: 0
	});
	const qqUserId = await appSessionQqUser(session, pool);
	const party = await partyInfo(qqUserId);
	if (party) channels.push({
		id: `party:${party.id}`,
		type: "party",
		name: `队伍·${text(party.name, 32)}`,
		partyId: party.id,
		unreadCount: 0
	});
	return channels;
};
const listChatMessages = async (session, channelId, limitValue = 50, beforeIdValue) => {
	await ensureSchema();
	const pool = await getPool();
	const channel = await assertChannelAccess(session, channelId, pool);
	const limit = Math.max(1, Math.min(100, Math.floor(Number(limitValue) || 50)));
	const beforeId = Number(beforeIdValue);
	const args = [channel.key];
	let clause = "channel_key=?";
	if (Number.isSafeInteger(beforeId) && beforeId > 0) {
		clause += " AND id<?";
		args.push(beforeId);
	}
	args.push(limit);
	const [rows] = await pool.execute(`SELECT id,sender_player_id,sender_name,content,created_at FROM web_chat_messages WHERE ${clause} ORDER BY id DESC LIMIT ?`, args);
	return rows.reverse().map((row) => ({
		id: Number(row.id),
		channelId: channel.key,
		senderId: Number(row.sender_player_id),
		senderName: text(row.sender_name, 64),
		content: String(row.content),
		createdAt: new Date(row.created_at).toISOString(),
		own: Number(row.sender_player_id) === Number(session.playerId)
	}));
};
const sendChatMessage = async (session, channelId, contentValue) => {
	await ensureSchema();
	const content = text(contentValue, 500);
	if (!content) throw new Error("消息不能为空。");
	const now = Date.now();
	const rate = chatRateWindows.get(Number(session.playerId));
	if (!rate || now - rate.startedAt >= 1e4) chatRateWindows.set(Number(session.playerId), {
		startedAt: now,
		count: 1
	});
	else {
		if (rate.count >= 5) throw new Error("消息发送过于频繁，请稍后再试。");
		rate.count += 1;
	}
	const pool = await getPool();
	const channel = await assertChannelAccess(session, channelId, pool);
	const senderInfo = await sender(session, pool);
	const [result] = await pool.execute("INSERT INTO web_chat_messages (channel_key,channel_type,sender_player_id,sender_character_id,sender_name,content) VALUES (?,?,?,?,?,?)", [
		channel.key,
		channel.type,
		Number(session.playerId),
		senderInfo.characterId,
		senderInfo.name,
		content
	]);
	return {
		id: Number(result.insertId),
		channelId: channel.key,
		senderId: Number(session.playerId),
		senderName: senderInfo.name,
		content,
		createdAt: (/* @__PURE__ */ new Date()).toISOString(),
		own: true
	};
};
const listPartyRecruitments = async (session) => {
	await ensureSchema();
	const pool = await getPool();
	await pool.execute("UPDATE web_party_recruitments SET status='closed' WHERE status='open' AND expires_at<=NOW()");
	const [rows] = await pool.execute(`SELECT r.id,r.party_id,p.name AS party_name,r.title,r.description,r.target_count,
    (SELECT COUNT(*) FROM party_members pm WHERE pm.party_id=r.party_id) AS member_count,c.name AS creator_name,r.created_at,r.expires_at
    ,r.creator_character_id
    FROM web_party_recruitments r JOIN parties p ON p.id=r.party_id JOIN characters c ON c.id=r.creator_character_id
    WHERE r.status='open' AND r.expires_at>NOW() ORDER BY r.created_at DESC LIMIT 50`);
	return rows.map((row) => ({
		id: Number(row.id),
		partyId: row.party_id,
		partyName: text(row.party_name, 32),
		title: text(row.title, 80),
		description: text(row.description, 300),
		targetCount: Number(row.target_count),
		memberCount: Number(row.member_count),
		creatorName: text(row.creator_name, 32),
		createdAt: new Date(row.created_at).toISOString(),
		expiresAt: new Date(row.expires_at).toISOString(),
		own: Boolean(session.characterId && Number(row.creator_character_id) === Number(session.characterId))
	}));
};
const createPartyRecruitment = async (session, input) => {
	await ensureSchema();
	const characterId = currentCharacter(session);
	const qqUserId = await appSessionQqUser(session);
	let party = await partyInfo(qqUserId);
	if (!party) {
		const partyId = await createParty(qqUserId, text(input.title, 32) || void 0);
		party = await partyInfo(qqUserId);
		if (!party || party.id !== partyId) throw new Error("队伍创建失败。");
	}
	if (Number(party.leaderId) !== characterId) throw new Error("只有队长可以发布招募。");
	const title = text(input.title, 80) || text(party.name, 80) || "冒险队伍招募";
	const description = text(input.description, 300);
	const targetCount = Math.max(2, Math.min(4, Math.floor(Number(input.targetCount) || 4)));
	const expiresMinutes = Math.max(5, Math.min(1440, Math.floor(Number(input.expiresMinutes) || 60)));
	const [result] = await (await getPool()).execute(`INSERT INTO web_party_recruitments
    (party_id,creator_character_id,title,description,target_count,expires_at)
    VALUES (?,?,?,?,?,DATE_ADD(NOW(),INTERVAL ? MINUTE))
    ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id),title=VALUES(title),description=VALUES(description),target_count=VALUES(target_count),expires_at=VALUES(expires_at)`, [
		party.id,
		characterId,
		title,
		description,
		targetCount,
		expiresMinutes
	]);
	const recruitmentId = Number(result.insertId);
	if (!recruitmentId) throw new Error("招募发布失败，请稍后重试。");
	return {
		id: recruitmentId,
		partyId: party.id,
		title,
		description,
		targetCount,
		status: "open"
	};
};
const applyPartyRecruitment = async (session, recruitmentIdValue, messageValue) => {
	await ensureSchema();
	const characterId = currentCharacter(session);
	const recruitmentId = Number(recruitmentIdValue);
	if (!Number.isSafeInteger(recruitmentId) || recruitmentId <= 0) throw new Error("招募信息不存在。");
	const pool = await getPool();
	const [rows] = await pool.execute(`SELECT party_id,status,expires_at FROM web_party_recruitments WHERE id=? LIMIT 1`, [recruitmentId]);
	const recruitment = rows[0];
	if (!recruitment || recruitment.status !== "open" || new Date(recruitment.expires_at).getTime() <= Date.now()) throw new Error("该招募已结束。");
	const note = text(messageValue, 300);
	const [result] = await pool.execute(`INSERT INTO web_party_applications (recruitment_id,applicant_character_id,message,status,responded_at) VALUES (?,?,?,'pending',NULL)
    ON DUPLICATE KEY UPDATE message=VALUES(message),status=IF(status='accepted','accepted','pending'),responded_at=IF(status='accepted',responded_at,NULL)`, [
		recruitmentId,
		characterId,
		note
	]);
	const [applicationRows] = await pool.execute("SELECT id,status FROM web_party_applications WHERE recruitment_id=? AND applicant_character_id=? LIMIT 1", [recruitmentId, characterId]);
	return {
		applicationId: Number(applicationRows[0]?.id ?? result.insertId),
		recruitmentId,
		partyId: recruitment.party_id,
		status: applicationRows[0]?.status ?? "pending"
	};
};
/** 队长审批申请；真正入队仍复用游戏内 joinParty 的位置、人数和战斗状态校验。 */
const acceptPartyApplication = async (session, applicationIdValue) => {
	await ensureSchema();
	const leaderCharacterId = currentCharacter(session);
	const applicationId = Number(applicationIdValue);
	if (!Number.isSafeInteger(applicationId) || applicationId <= 0) throw new Error("入队申请不存在。");
	const pool = await getPool();
	const [rows] = await pool.execute(`SELECT a.recruitment_id,a.applicant_character_id,a.status,r.party_id,r.creator_character_id,p.leader_character_id,r.target_count
    FROM web_party_applications a JOIN web_party_recruitments r ON r.id=a.recruitment_id JOIN parties p ON p.id=r.party_id WHERE a.id=? LIMIT 1`, [applicationId]);
	const application = rows[0];
	if (!application || application.status !== "pending") throw new Error("该申请已处理或不存在。");
	if (Number(application.leader_character_id) !== leaderCharacterId) throw new Error("只有当前队长可以审批申请。");
	const [applicant] = await pool.execute("SELECT p.qq_user_id FROM characters c JOIN players p ON p.id=c.player_id WHERE c.id=? AND c.npc_code IS NULL LIMIT 1", [application.applicant_character_id]);
	if (!applicant[0]?.qq_user_id) throw new Error("申请玩家不存在。");
	await joinParty(String(applicant[0].qq_user_id), String(application.party_id));
	await pool.execute("UPDATE web_party_applications SET status='accepted',responded_at=NOW() WHERE id=? AND status='pending'", [applicationId]);
	await pool.execute(`UPDATE web_party_recruitments r SET status='closed' WHERE r.id=? AND (SELECT COUNT(*) FROM party_members pm WHERE pm.party_id=r.party_id)>=r.target_count`, [application.recruitment_id]);
	return {
		applicationId,
		recruitmentId: Number(application.recruitment_id),
		partyId: application.party_id,
		status: "accepted"
	};
};
const rejectPartyApplication = async (session, applicationIdValue) => {
	await ensureSchema();
	const leaderCharacterId = currentCharacter(session);
	const applicationId = Number(applicationIdValue);
	if (!Number.isSafeInteger(applicationId) || applicationId <= 0) throw new Error("入队申请不存在。");
	const pool = await getPool();
	const [rows] = await pool.execute(`SELECT r.creator_character_id,p.leader_character_id,r.id AS recruitment_id,r.party_id,a.status FROM web_party_applications a JOIN web_party_recruitments r ON r.id=a.recruitment_id JOIN parties p ON p.id=r.party_id WHERE a.id=? LIMIT 1`, [applicationId]);
	const application = rows[0];
	if (!application || application.status !== "pending") throw new Error("该申请已处理或不存在。");
	if (Number(application.leader_character_id) !== leaderCharacterId) throw new Error("只有当前队长可以审批申请。");
	await pool.execute("UPDATE web_party_applications SET status='rejected',responded_at=NOW() WHERE id=? AND status='pending'", [applicationId]);
	return {
		applicationId,
		recruitmentId: Number(application.recruitment_id),
		partyId: application.party_id,
		status: "rejected"
	};
};
const listPartyApplications = async (session, recruitmentIdValue) => {
	await ensureSchema();
	const leaderCharacterId = currentCharacter(session);
	const recruitmentId = Number(recruitmentIdValue);
	if (!Number.isSafeInteger(recruitmentId) || recruitmentId <= 0) throw new Error("招募信息不存在。");
	const pool = await getPool();
	const [owners] = await pool.execute("SELECT r.creator_character_id,p.leader_character_id FROM web_party_recruitments r JOIN parties p ON p.id=r.party_id WHERE r.id=? LIMIT 1", [recruitmentId]);
	if (!owners[0]) throw new Error("招募信息不存在。");
	if (Number(owners[0].leader_character_id) !== leaderCharacterId) throw new Error("只有当前队长可以查看申请。");
	const [rows] = await pool.execute(`SELECT a.id,a.applicant_character_id,c.game_id,c.name,a.message,a.status,a.created_at,a.responded_at
    FROM web_party_applications a JOIN characters c ON c.id=a.applicant_character_id WHERE a.recruitment_id=? ORDER BY a.created_at DESC LIMIT 50`, [recruitmentId]);
	return rows.map((row) => ({
		id: Number(row.id),
		applicantCharacterId: Number(row.applicant_character_id),
		gameId: Number(row.game_id),
		name: text(row.name, 32),
		message: text(row.message, 300),
		status: row.status,
		createdAt: new Date(row.created_at).toISOString(),
		respondedAt: row.responded_at ? new Date(row.responded_at).toISOString() : null
	}));
};

//#endregion
export { acceptPartyApplication, applyPartyRecruitment, consumeRealtimeTicket, createPartyRecruitment, issueRealtimeTicket, listChatChannels, listChatMessages, listPartyApplications, listPartyRecruitments, rejectPartyApplication, sendChatMessage };