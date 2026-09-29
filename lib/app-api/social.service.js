import { getPool, withTransaction } from "../database/pool.js";
import { forestStoryPartyCondition, isForestStoryParty } from "../game/story-party.js";
import { createParty, joinParty, leaveParty, partyInfo, renameParty } from "../game/adventure.service.js";
import { appSessionQqUser } from "../game/app-channel.service.js";
import { logger } from "alemonjs";
import { randomBytes } from "node:crypto";

//#region src/app-api/social.service.ts
let schemaPromise = null;
const realtimeTickets = /* @__PURE__ */ new Map();
const chatRateWindows = /* @__PURE__ */ new Map();
const recruitmentListeners = /* @__PURE__ */ new Set();
const subscribePartyRecruitmentChanges = (listener) => {
	recruitmentListeners.add(listener);
	return () => {
		recruitmentListeners.delete(listener);
	};
};
const notifyRecruitmentChange = (messageId, recruitmentId) => {
	for (const listener of recruitmentListeners) try {
		listener({
			channelId: "party:lobby",
			messageId,
			recruitmentId
		});
	} catch (error) {
		logger.warn({ err: error }, "组队招募实时提示失败");
	}
};
const notifyRecruitmentById = async (recruitmentId) => {
	try {
		const [rows] = await (await getPool()).execute("SELECT id FROM web_chat_messages WHERE recruitment_id=? ORDER BY id DESC LIMIT 1", [recruitmentId]);
		if (rows[0]) notifyRecruitmentChange(Number(rows[0].id), recruitmentId);
	} catch (error) {
		logger.warn({ err: error }, "组队招募实时提示失败");
	}
};
const issueRealtimeTicket = (session, token) => {
	const now = Date.now();
	for (const [ticket, value] of realtimeTickets) if (value.expiresAt <= now) realtimeTickets.delete(ticket);
	const ticket = randomBytes(24).toString("base64url");
	realtimeTickets.set(ticket, {
		session,
		token,
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
	return {
		session: value.session,
		token: value.token
	};
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
        recruitment_id BIGINT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id), KEY idx_web_chat_channel (channel_key,id), KEY idx_web_chat_sender (sender_player_id,id),
        KEY idx_web_chat_recruitment (recruitment_id,id)
      ) ENGINE=InnoDB`);
		const [chatColumns] = await pool.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='web_chat_messages' AND COLUMN_NAME='recruitment_id' LIMIT 1");
		if (!chatColumns.length) try {
			await pool.query("ALTER TABLE web_chat_messages ADD COLUMN recruitment_id BIGINT UNSIGNED NULL AFTER content");
		} catch (error) {
			if (error?.code !== "ER_DUP_FIELDNAME") throw error;
		}
		const [chatIndexes] = await pool.query("SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='web_chat_messages' AND INDEX_NAME='idx_web_chat_recruitment' LIMIT 1");
		if (!chatIndexes.length) try {
			await pool.query("ALTER TABLE web_chat_messages ADD KEY idx_web_chat_recruitment (recruitment_id,id)");
		} catch (error) {
			if (error?.code !== "ER_DUP_KEYNAME") throw error;
		}
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
	if (value === "party:lobby") return {
		type: "party",
		key: value,
		lobby: true
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
		if ("lobby" in channel) return channel;
		const [rows] = await pool.execute("SELECT 1 FROM party_members WHERE party_id=? AND character_id=? LIMIT 1", [channel.partyId, characterId]);
		if (!rows[0]) throw new Error("你不在这个队伍中。");
		return channel;
	}
	const [rows] = await pool.execute(`SELECT c.id AS friend_id,me.game_id AS own_game_id
    FROM player_relationships r JOIN characters c ON c.id=CASE WHEN r.character_low_id=? THEN r.character_high_id ELSE r.character_low_id END
    JOIN characters me ON me.id=?
    WHERE (r.character_low_id=? OR r.character_high_id=?) AND c.game_id=? AND r.status IN ('friend','oath') LIMIT 1`, [
		characterId,
		characterId,
		characterId,
		characterId,
		channel.gameId
	]);
	if (!rows[0]) throw new Error("只能向游戏内好友发送私聊。");
	const friendId = Number(rows[0].friend_id);
	return {
		...channel,
		key: `friend:${Math.min(characterId, friendId)}:${Math.max(characterId, friendId)}`,
		characterId,
		friendId,
		legacyOutgoingKey: channel.key,
		legacyIncomingKey: `friend:${Number(rows[0].own_game_id)}`
	};
};
const chatChannelKey = async (session, channelId) => (await assertChannelAccess(session, channelId)).key;
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
const recruitmentSelect = `SELECT r.id,r.party_id,p.name AS party_name,r.title,r.description,r.target_count,r.status,r.created_at,r.expires_at,
  p.leader_character_id,c.game_id AS leader_game_id,c.name AS leader_name,m.code AS region_code,m.name AS region_name,
  (SELECT COUNT(*) FROM party_members pm WHERE pm.party_id=r.party_id) AS member_count,a.status AS application_status`;
const recruitmentFrom = `FROM web_party_recruitments r JOIN parties p ON p.id=r.party_id
  JOIN characters c ON c.id=p.leader_character_id JOIN map_regions m ON m.id=c.current_region_id
  LEFT JOIN web_party_applications a ON a.recruitment_id=r.id AND a.applicant_character_id=?`;
const recruitmentView = (row, session) => {
	const memberCount = Number(row.member_count);
	const targetCount = Number(row.target_count);
	const open = row.status === "open" && new Date(row.expires_at).getTime() > Date.now() && memberCount < targetCount;
	return {
		id: Number(row.id),
		partyId: row.party_id,
		partyName: text(row.party_name, 32),
		title: text(row.title, 80),
		description: text(row.description, 300),
		targetCount,
		memberCount,
		openSlots: Math.max(0, targetCount - memberCount),
		leaderGameId: Number(row.leader_game_id),
		creatorName: text(row.leader_name, 32),
		regionCode: String(row.region_code),
		regionName: String(row.region_name),
		createdAt: new Date(row.created_at).toISOString(),
		expiresAt: new Date(row.expires_at).toISOString(),
		own: Boolean(session.characterId && Number(row.leader_character_id) === Number(session.characterId)),
		status: open ? "open" : "closed",
		applicationStatus: row.application_status === "pending" && !open ? "expired" : row.application_status ?? null
	};
};
const recruitmentsByIds = async (session, db, ids) => {
	if (!ids.length) return /* @__PURE__ */ new Map();
	const [rows] = await db.execute(`${recruitmentSelect} ${recruitmentFrom} WHERE r.id IN (${ids.map(() => "?").join(",")})`, [Number(session.characterId ?? 0), ...ids]);
	return new Map(rows.map((row) => [Number(row.id), recruitmentView(row, session)]));
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
	channels.push({
		id: "party:lobby",
		type: "party",
		name: "组队频道",
		unreadCount: 0
	});
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
	if (channel.type === "friend") {
		clause = "(channel_key=? OR (channel_key=? AND sender_character_id=?) OR (channel_key=? AND sender_character_id=?))";
		args.push(channel.legacyOutgoingKey, channel.characterId, channel.legacyIncomingKey, channel.friendId);
	}
	if (Number.isSafeInteger(beforeId) && beforeId > 0) {
		clause += " AND id<?";
		args.push(beforeId);
	}
	args.push(limit);
	const [rows] = await pool.execute(`SELECT id,sender_player_id,sender_name,content,recruitment_id,created_at FROM web_chat_messages WHERE ${clause} ORDER BY id DESC LIMIT ?`, args);
	const cards = await recruitmentsByIds(session, pool, [...new Set(rows.map((row) => Number(row.recruitment_id)).filter((id) => Number.isSafeInteger(id) && id > 0))]);
	return rows.reverse().map((row) => ({
		id: Number(row.id),
		channelId,
		senderId: Number(row.sender_player_id),
		senderName: text(row.sender_name, 64),
		content: String(row.content),
		createdAt: new Date(row.created_at).toISOString(),
		own: Number(row.sender_player_id) === Number(session.playerId),
		...row.recruitment_id && cards.has(Number(row.recruitment_id)) ? {
			recruitmentId: Number(row.recruitment_id),
			recruitment: cards.get(Number(row.recruitment_id))
		} : {}
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
		channelId,
		senderId: Number(session.playerId),
		senderName: senderInfo.name,
		content,
		createdAt: (/* @__PURE__ */ new Date()).toISOString(),
		own: true
	};
};
const closeEndedRecruitments = async (db) => {
	await db.execute(`UPDATE web_party_recruitments r SET r.status='closed' WHERE r.status='open'
    AND (r.expires_at<=NOW() OR (SELECT COUNT(*) FROM party_members pm WHERE pm.party_id=r.party_id)>=r.target_count)`);
};
const currentWebParty = async (session) => {
	if (!session.characterId) return null;
	await ensureSchema();
	const qqUserId = await appSessionQqUser(session);
	const party = await partyInfo(qqUserId);
	if (!party) return null;
	const pool = await getPool();
	const [memberRows] = await pool.execute(`SELECT c.id,c.game_id,c.name,c.level,m.code AS region_code,m.name AS region_name,c.pos_x,c.pos_y,c.pos_z
    FROM party_members pm JOIN characters c ON c.id=pm.character_id JOIN map_regions m ON m.id=c.current_region_id
    WHERE pm.party_id=? ORDER BY pm.joined_at,c.id`, [party.id]);
	const members = memberRows.map((row) => ({
		id: Number(row.id),
		gameId: Number(row.game_id),
		name: String(row.name),
		level: Number(row.level),
		isLeader: Number(row.id) === Number(party.leaderId),
		isSelf: Number(row.id) === Number(party.ownId),
		regionCode: String(row.region_code),
		regionName: String(row.region_name),
		x: Number(row.pos_x),
		y: Number(row.pos_y),
		z: Number(row.pos_z),
		position: {
			x: Number(row.pos_x),
			y: Number(row.pos_y),
			z: Number(row.pos_z)
		}
	}));
	const leader = members.find((member) => member.isLeader);
	await closeEndedRecruitments(pool);
	const [recruitmentRows] = await pool.execute(`${recruitmentSelect} ${recruitmentFrom}
    WHERE r.party_id=? AND r.status='open' AND r.expires_at>NOW() LIMIT 1`, [Number(session.characterId), party.id]);
	const recruitment = recruitmentRows[0] ? recruitmentView(recruitmentRows[0], session) : null;
	const [applicationRows] = recruitment ? await pool.execute("SELECT COUNT(*) AS total FROM web_party_applications WHERE recruitment_id=? AND status='pending'", [recruitment.id]) : [[]];
	return {
		id: party.id,
		name: party.name,
		story: party.story,
		leaderId: party.leaderId,
		leaderGameId: leader?.gameId ?? null,
		ownId: party.ownId,
		isLeader: Number(party.ownId) === Number(party.leaderId),
		leader: leader ?? null,
		members,
		memberCount: members.length,
		maxMembers: 4,
		regionCode: leader?.regionCode ?? "",
		regionName: leader?.regionName ?? "",
		position: leader?.position ?? null,
		canLeave: !party.story,
		canRename: !party.story && Number(party.ownId) === Number(party.leaderId),
		canRecruit: !party.story && Number(party.ownId) === Number(party.leaderId) && members.length < 4,
		canPublishRecruitment: !party.story && Number(party.ownId) === Number(party.leaderId) && members.length < 4,
		recruitment,
		pendingApplicationCount: Number(applicationRows[0]?.total ?? 0)
	};
};
const createWebParty = async (session, input) => {
	currentCharacter(session);
	const name = text(input.name, 32);
	if (!name) throw new Error("请填写队伍名。");
	if (input.targetCount !== void 0 && Number(input.targetCount) !== 4) throw new Error("队伍人数上限固定为 4 人；可在发布招募时设置 2 至 4 人的招募目标。");
	await createParty(await appSessionQqUser(session), name);
	return currentWebParty(session);
};
const leaveWebParty = async (session) => {
	currentCharacter(session);
	const before = await currentWebParty(session);
	await leaveParty(await appSessionQqUser(session));
	if (before?.recruitment) await notifyRecruitmentById(before.recruitment.id);
	return currentWebParty(session);
};
const renameWebParty = async (session, nameValue) => {
	currentCharacter(session);
	const name = text(nameValue, 32);
	if (!name) throw new Error("请填写队伍名。");
	await renameParty(await appSessionQqUser(session), name);
	const party = await currentWebParty(session);
	if (party?.recruitment) await notifyRecruitmentById(party.recruitment.id);
	return party;
};
const searchPartyRecruitments = async (session, filters = {}) => {
	await ensureSchema();
	const pool = await getPool();
	await closeEndedRecruitments(pool);
	const region = text(filters.region, 64);
	const keyword = text(filters.keyword, 80);
	const minOpenSlots = filters.minOpenSlots === void 0 ? 1 : Number(filters.minOpenSlots);
	if (!Number.isSafeInteger(minOpenSlots) || minOpenSlots < 1 || minOpenSlots > 4) throw new Error("空位筛选无效。");
	const targetCount = filters.targetCount === void 0 ? null : Number(filters.targetCount);
	if (targetCount !== null && (!Number.isSafeInteger(targetCount) || targetCount < 2 || targetCount > 4)) throw new Error("人数筛选无效。");
	const cursor = filters.cursor === void 0 ? null : Number(filters.cursor);
	if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor <= 0)) throw new Error("分页游标无效。");
	const limit = filters.limit === void 0 ? 20 : Number(filters.limit);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("每页数量须在 1 至 50 之间。");
	const where = [
		`r.status='open'`,
		"r.expires_at>NOW()",
		"r.target_count-(SELECT COUNT(*) FROM party_members pm WHERE pm.party_id=r.party_id)>=?",
		`NOT ${forestStoryPartyCondition}`
	];
	const args = [Number(session.characterId ?? 0), minOpenSlots];
	if (region) {
		where.push("(m.code=? OR m.name=?)");
		args.push(region, region);
	}
	if (keyword) {
		where.push("(p.name LIKE ? ESCAPE '!' OR r.title LIKE ? ESCAPE '!' OR r.description LIKE ? ESCAPE '!' OR c.name LIKE ? ESCAPE '!')");
		const pattern = `%${keyword.replace(/[!%_]/g, (value) => `!${value}`)}%`;
		args.push(pattern, pattern, pattern, pattern);
	}
	if (targetCount !== null) {
		where.push("r.target_count=?");
		args.push(targetCount);
	}
	if (cursor !== null) {
		where.push("r.id<?");
		args.push(cursor);
	}
	const [rows] = await pool.execute(`${recruitmentSelect} ${recruitmentFrom}
    WHERE ${where.join(" AND ")} ORDER BY r.id DESC LIMIT ?`, [...args, limit + 1]);
	const hasMore = rows.length > limit;
	const items = rows.slice(0, limit).map((row) => recruitmentView(row, session));
	return {
		recruitments: items,
		hasMore,
		nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null
	};
};
const listPartyRecruitments = async (session) => (await searchPartyRecruitments(session, { limit: 50 })).recruitments;
const createPartyRecruitment = async (session, input) => {
	await ensureSchema();
	const characterId = currentCharacter(session);
	const targetCount = input.targetCount === void 0 ? 4 : Number(input.targetCount);
	if (!Number.isSafeInteger(targetCount) || targetCount < 2 || targetCount > 4) throw new Error("招募目标人数须在 2 至 4 人之间。");
	const expiresMinutes = input.expiresMinutes === void 0 ? 60 : Number(input.expiresMinutes);
	if (!Number.isSafeInteger(expiresMinutes) || expiresMinutes < 5 || expiresMinutes > 1440) throw new Error("招募有效期须在 5 分钟至 24 小时之间。");
	const qqUserId = await appSessionQqUser(session);
	const party = await partyInfo(qqUserId);
	if (!party) throw new Error("请先创建队伍，再发布招募。");
	if (Number(party.leaderId) !== characterId) throw new Error("只有队长可以发布招募。");
	if (party.story) throw new Error("主线剧情队伍不能发布招募。");
	const title = text(input.title, 80) || text(party.name, 80) || "冒险队伍招募";
	const description = text(input.description, 300);
	const pool = await getPool();
	await closeEndedRecruitments(pool);
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		const [partyRows] = await connection.execute("SELECT name,leader_character_id FROM parties WHERE id=? FOR UPDATE", [party.id]);
		if (!partyRows[0] || Number(partyRows[0].leader_character_id) !== characterId) throw new Error("只有当前队长可以发布招募。");
		if (await isForestStoryParty(connection, party.id)) throw new Error("主线剧情队伍不能发布招募。");
		const [counts] = await connection.execute("SELECT COUNT(*) AS total FROM party_members WHERE party_id=?", [party.id]);
		const memberCount = Number(counts[0]?.total ?? 0);
		if (memberCount >= 4) throw new Error("队伍已满，不能发布招募。");
		if (memberCount >= targetCount) throw new Error("当前成员数已达到招募目标，请提高目标人数。");
		const [openRows] = await connection.execute("SELECT id,title,description,target_count,expires_at FROM web_party_recruitments WHERE party_id=? AND status='open' FOR UPDATE", [party.id]);
		let openRow = openRows[0];
		if (openRow && (new Date(openRow.expires_at).getTime() <= Date.now() || memberCount >= Number(openRow.target_count))) {
			await connection.execute("UPDATE web_party_recruitments SET status='closed' WHERE id=?", [openRow.id]);
			openRow = void 0;
		}
		let recruitmentId;
		let updated = false;
		if (openRow) {
			recruitmentId = Number(openRow.id);
			updated = openRow.title !== title || openRow.description !== description || Number(openRow.target_count) !== targetCount;
			if (updated || input.expiresMinutes !== void 0) {
				await connection.execute(`UPDATE web_party_recruitments SET title=?,description=?,target_count=?,
          expires_at=DATE_ADD(NOW(),INTERVAL ? MINUTE) WHERE id=?`, [
					title,
					description,
					targetCount,
					expiresMinutes,
					recruitmentId
				]);
				updated = true;
			}
		} else {
			const [latest] = await connection.execute("SELECT TIMESTAMPDIFF(SECOND,created_at,NOW()) AS seconds_since FROM web_party_recruitments WHERE party_id=? ORDER BY id DESC LIMIT 1", [party.id]);
			if (latest[0] && Number(latest[0].seconds_since) < 60) throw new Error("招募发布过于频繁，请稍后再试。");
			const [result] = await connection.execute(`INSERT INTO web_party_recruitments
        (party_id,creator_character_id,title,description,target_count,expires_at)
        VALUES (?,?,?,?,?,DATE_ADD(NOW(),INTERVAL ? MINUTE))`, [
				party.id,
				characterId,
				title,
				description,
				targetCount,
				expiresMinutes
			]);
			recruitmentId = Number(result.insertId);
			updated = true;
		}
		const [messages] = await connection.execute("SELECT id FROM web_chat_messages WHERE recruitment_id=? ORDER BY id DESC LIMIT 1", [recruitmentId]);
		let messageId = Number(messages[0]?.id ?? 0);
		if (!messageId) {
			const senderInfo = await sender(session, connection);
			const [result] = await connection.execute(`INSERT INTO web_chat_messages
        (channel_key,channel_type,sender_player_id,sender_character_id,sender_name,content,recruitment_id)
        VALUES ('party:lobby','party',?,?,?,?,?)`, [
				Number(session.playerId),
				senderInfo.characterId,
				senderInfo.name,
				"发布了一条队伍招募。",
				recruitmentId
			]);
			messageId = Number(result.insertId);
			updated = true;
		}
		await connection.commit();
		if (updated) notifyRecruitmentChange(messageId, recruitmentId);
		return {
			id: recruitmentId,
			partyId: party.id,
			title,
			description,
			targetCount,
			status: "open",
			channelId: "party:lobby",
			messageId,
			updated
		};
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};
const applyPartyRecruitment = async (session, recruitmentIdValue, messageValue) => {
	await ensureSchema();
	const characterId = currentCharacter(session);
	const recruitmentId = Number(recruitmentIdValue);
	if (!Number.isSafeInteger(recruitmentId) || recruitmentId <= 0) throw new Error("招募信息不存在。");
	const note = text(messageValue, 300);
	const response = await withTransaction(async (connection) => {
		const [membership] = await connection.execute("SELECT party_id FROM party_members WHERE character_id=? FOR UPDATE", [characterId]);
		const [rows] = await connection.execute("SELECT party_id,status,expires_at,target_count FROM web_party_recruitments WHERE id=? FOR UPDATE", [recruitmentId]);
		const recruitment = rows[0];
		if (!recruitment || recruitment.status !== "open" || new Date(recruitment.expires_at).getTime() <= Date.now()) throw new Error("该招募已结束。");
		if (membership[0]) throw new Error(membership[0].party_id === recruitment.party_id ? "你已经在这个队伍中。" : "请先退出当前队伍再申请。");
		if (await isForestStoryParty(connection, recruitment.party_id)) throw new Error("主线剧情队伍不能接受申请。");
		const [counts] = await connection.execute("SELECT COUNT(*) AS total FROM party_members WHERE party_id=?", [recruitment.party_id]);
		if (Number(counts[0]?.total ?? 0) >= Number(recruitment.target_count)) throw new Error("招募目标人数已满。");
		const [result] = await connection.execute(`INSERT INTO web_party_applications
      (recruitment_id,applicant_character_id,message,status,responded_at) VALUES (?,?,?,'pending',NULL)
      ON DUPLICATE KEY UPDATE message=VALUES(message),status='pending',responded_at=NULL`, [
			recruitmentId,
			characterId,
			note
		]);
		const [applicationRows] = await connection.execute("SELECT id,status FROM web_party_applications WHERE recruitment_id=? AND applicant_character_id=? LIMIT 1", [recruitmentId, characterId]);
		return {
			applicationId: Number(applicationRows[0]?.id ?? result.insertId),
			recruitmentId,
			partyId: recruitment.party_id,
			status: applicationRows[0]?.status ?? "pending"
		};
	});
	await notifyRecruitmentById(recruitmentId);
	return response;
};
/** 队长审批申请；joinParty 的同一事务内更新申请状态，保留游戏内位置、人数和交涉校验。 */
const acceptPartyApplication = async (session, applicationIdValue) => {
	await ensureSchema();
	const leaderCharacterId = currentCharacter(session);
	const applicationId = Number(applicationIdValue);
	if (!Number.isSafeInteger(applicationId) || applicationId <= 0) throw new Error("入队申请不存在。");
	const pool = await getPool();
	const [rows] = await pool.execute(`SELECT a.recruitment_id,a.applicant_character_id,a.status,r.party_id,p.leader_character_id,r.status AS recruitment_status,r.expires_at,r.target_count
    FROM web_party_applications a JOIN web_party_recruitments r ON r.id=a.recruitment_id JOIN parties p ON p.id=r.party_id WHERE a.id=? LIMIT 1`, [applicationId]);
	const application = rows[0];
	if (!application) throw new Error("该申请不存在。");
	if (Number(application.leader_character_id) !== leaderCharacterId) throw new Error("只有当前队长可以审批申请。");
	if (application.status === "accepted") return {
		applicationId,
		recruitmentId: Number(application.recruitment_id),
		partyId: application.party_id,
		status: "accepted"
	};
	if (application.status !== "pending") throw new Error("该申请已处理。");
	if (application.recruitment_status !== "open" || new Date(application.expires_at).getTime() <= Date.now()) throw new Error("该招募已结束，不能审批。");
	if (await isForestStoryParty(pool, application.party_id)) throw new Error("主线剧情队伍不能接受申请。");
	const [applicant] = await pool.execute("SELECT p.qq_user_id FROM characters c JOIN players p ON p.id=c.player_id WHERE c.id=? AND c.npc_code IS NULL LIMIT 1", [application.applicant_character_id]);
	if (!applicant[0]?.qq_user_id) throw new Error("申请玩家不存在。");
	try {
		await joinParty(String(applicant[0].qq_user_id), String(application.party_id), {
			maxMembers: Number(application.target_count),
			onJoined: async (connection) => {
				const [fresh] = await connection.execute(`SELECT a.status,r.status AS recruitment_status,r.expires_at,p.leader_character_id FROM web_party_applications a
            JOIN web_party_recruitments r ON r.id=a.recruitment_id JOIN parties p ON p.id=r.party_id WHERE a.id=? FOR UPDATE`, [applicationId]);
				if (!fresh[0] || fresh[0].status !== "pending" || fresh[0].recruitment_status !== "open" || new Date(fresh[0].expires_at).getTime() <= Date.now() || Number(fresh[0].leader_character_id) !== leaderCharacterId) throw new Error("该申请或招募已变更，请刷新后重试。");
				await connection.execute("UPDATE web_party_applications SET status='accepted',responded_at=NOW() WHERE id=? AND status='pending'", [applicationId]);
				await connection.execute(`UPDATE web_party_recruitments r SET status='closed' WHERE r.id=?
          AND (SELECT COUNT(*) FROM party_members pm WHERE pm.party_id=r.party_id)>=r.target_count`, [application.recruitment_id]);
			}
		});
	} catch (error) {
		const [completed] = await pool.execute(`SELECT a.status,pm.party_id FROM web_party_applications a LEFT JOIN party_members pm ON pm.character_id=a.applicant_character_id
        WHERE a.id=? LIMIT 1`, [applicationId]);
		if (completed[0]?.status !== "accepted" || completed[0]?.party_id !== application.party_id) throw error;
	}
	await notifyRecruitmentById(Number(application.recruitment_id));
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
	const response = await withTransaction(async (connection) => {
		const [rows] = await connection.execute(`SELECT p.leader_character_id,r.id AS recruitment_id,r.party_id,a.status FROM web_party_applications a
        JOIN web_party_recruitments r ON r.id=a.recruitment_id JOIN parties p ON p.id=r.party_id
        WHERE a.id=? LIMIT 1 FOR UPDATE`, [applicationId]);
		const application = rows[0];
		if (!application) throw new Error("该申请不存在。");
		if (Number(application.leader_character_id) !== leaderCharacterId) throw new Error("只有当前队长可以审批申请。");
		if (application.status === "rejected") return {
			applicationId,
			recruitmentId: Number(application.recruitment_id),
			partyId: application.party_id,
			status: "rejected"
		};
		if (application.status !== "pending") throw new Error("该申请已处理。");
		const [result] = await connection.execute("UPDATE web_party_applications SET status='rejected',responded_at=NOW() WHERE id=? AND status='pending'", [applicationId]);
		if (!result.affectedRows) throw new Error("该申请已处理，请刷新后重试。");
		return {
			applicationId,
			recruitmentId: Number(application.recruitment_id),
			partyId: application.party_id,
			status: "rejected"
		};
	});
	await notifyRecruitmentById(response.recruitmentId);
	return response;
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
export { acceptPartyApplication, applyPartyRecruitment, chatChannelKey, consumeRealtimeTicket, createPartyRecruitment, createWebParty, currentWebParty, issueRealtimeTicket, leaveWebParty, listChatChannels, listChatMessages, listPartyApplications, listPartyRecruitments, rejectPartyApplication, renameWebParty, searchPartyRecruitments, sendChatMessage, subscribePartyRecruitmentChanges };