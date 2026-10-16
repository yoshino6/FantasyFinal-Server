import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { getPool, withTransaction } from '../database/pool';
import { appSessionQqUser, type AppSession } from '../game/app-channel.service';
import { joinParty } from '../game/adventure.service';
import { acceptFriendRequest, sendFriendRequest } from '../game/social.service';
import { forestStoryPartyCondition } from '../game/story-party';
import { enqueueWebNotification, ensureWebNotificationInbox } from './notification.service';
import { socialIdentityFromCharacter } from './social-presentation';

type Db = Pick<Pool, 'execute'>;
type PublicCharacterRow = RowDataPacket & {
  id: number; player_id: number; game_id: number; name: string; gender: string; level: number;
  profession_code: string | null; profession_name: string | null; advanced_profession_code: string | null;
  secondary_profession_code: string | null; secondary_level: number | null; adventurer_rank: string;
  avatar_data_url: string | null; region_name: string | null; current_region_id: number;
  region_code: string | null; pos_x: number; pos_y: number; pos_z: number; activity_status: string;
};
type PartyRow = RowDataPacket & {
  character_id: number; party_id: string; name: string; leader_character_id: number; member_count: number; story_party: number;
};
type InvitationPayload = {
  status: 'pending' | 'accepted' | 'rejected'; partyId: string; partyName: string;
  inviterGameId: number; inviterName: string; targetGameId: number; expiresAt: string;
};
type InvitationRow = RowDataPacket & { id: number; payload: string | InvitationPayload };

export class PlayerCardError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export const requirePublicPlayerId = (value: unknown): number => {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d*$/.test(String(value))) {
    throw new PlayerCardError('玩家 ID 无效。');
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new PlayerCardError('玩家 ID 无效。');
  return id;
};

const characterPair = async (db: Db, session: AppSession, gameId: number, lock = false) => {
  const [rows] = await db.execute<PublicCharacterRow[]>(`SELECT c.id,c.player_id,c.game_id,c.name,c.gender,c.level,
    c.profession_code,pd.name AS profession_name,ap.profession_code AS advanced_profession_code,
    c.secondary_profession_code,sp.level AS secondary_level,c.adventurer_rank,p.avatar_data_url,
    c.current_region_id,c.pos_x,c.pos_y,c.pos_z,c.activity_status,m.code AS region_code,
    CASE WHEN m.is_owner_only=0 AND m.is_enabled=1 THEN m.name ELSE NULL END AS region_name
    FROM characters c JOIN players p ON p.id=c.player_id
    LEFT JOIN profession_definitions pd ON pd.code=c.profession_code
    LEFT JOIN player_advanced_professions ap ON ap.character_id=c.id
    LEFT JOIN player_secondary_professions sp ON sp.character_id=c.id AND sp.profession_code=c.secondary_profession_code
    LEFT JOIN map_regions m ON m.id=c.current_region_id
    WHERE (c.player_id=? OR c.game_id=?) AND c.npc_code IS NULL AND p.status='active'
    ORDER BY c.id${lock ? ' FOR UPDATE' : ''}`, [session.playerId, gameId]);
  const actor = rows.find(row => Number(row.player_id) === Number(session.playerId));
  if (!actor) throw new PlayerCardError('请先完成角色注册。');
  const target = rows.find(row => Number(row.game_id) === gameId);
  if (!target) throw new PlayerCardError('未找到这位玩家。', 404);
  return { actor, target };
};

const partiesForPair = async (db: Db, actorId: number, targetId: number, lock = false) => {
  const [rows] = await db.execute<PartyRow[]>(`SELECT pm.character_id,pm.party_id,p.name,p.leader_character_id,
    (SELECT COUNT(*) FROM party_members members WHERE members.party_id=p.id) AS member_count,
    ${forestStoryPartyCondition} AS story_party
    FROM party_members pm JOIN parties p ON p.id=pm.party_id
    WHERE pm.character_id IN (?,?) ORDER BY pm.character_id${lock ? ' FOR UPDATE' : ''}`, [actorId, targetId]);
  return { actorParty: rows.find(row => Number(row.character_id) === actorId), targetParty: rows.find(row => Number(row.character_id) === targetId) };
};

const invitationDisabledReason = (actor: PublicCharacterRow, target: PublicCharacterRow, actorParty?: PartyRow, targetParty?: PartyRow) => {
  if (Number(actor.id) === Number(target.id)) return '不能邀请自己入队。';
  if (actorParty && targetParty?.party_id === actorParty.party_id) return '你们已在同一队伍。';
  if (targetParty) return '对方已经在一个队伍中。';
  if (!actorParty) return '请先在组队中创建队伍。';
  if (Number(actorParty.leader_character_id) !== Number(actor.id)) return '只有队长可以邀请玩家。';
  if (Number(actorParty.story_party)) return '主线剧情队伍暂不能邀请玩家。';
  if (Number(actorParty.member_count) >= 4) return '队伍已满（最多 4 人）。';
  if (actor.activity_status !== 'active') return '请先恢复行动状态。';
  if (target.activity_status !== 'active') return '对方当前无法加入队伍。';
  if (Number(actor.current_region_id) !== Number(target.current_region_id)) return '需在同一片区域才能组队。';
  if (Number(actor.pos_z) !== Number(target.pos_z)) return '需处于同一高度层才能组队。';
  if (actor.region_code === 'dark_forest_dungeon' && Math.abs(Number(actor.pos_x) - Number(target.pos_x)) + Math.abs(Number(actor.pos_y) - Number(target.pos_y)) > 1) {
    return '地下迷宫中需相距不超过 1 格。';
  }
  return '';
};

const invitationPayload = (row: InvitationRow | undefined): InvitationPayload | null => {
  if (!row) return null;
  try {
    const value = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (!value || !['pending', 'accepted', 'rejected'].includes(value.status) ||
      typeof value.partyId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value.partyId) ||
      !Number.isSafeInteger(value.inviterGameId) || value.inviterGameId <= 0 ||
      !Number.isSafeInteger(value.targetGameId) || value.targetGameId <= 0 ||
      !Number.isFinite(new Date(value.expiresAt).getTime())) return null;
    return value as InvitationPayload;
  } catch { return null; }
};

const pendingInvitations = async (db: Db, playerId: number, inviterGameId?: number) => {
  const [rows] = await db.execute<InvitationRow[]>(`SELECT id,payload FROM player_events
    WHERE player_id=? AND event_type='party.invitation'
    AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.status'))='pending'
    AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.expiresAt'))>?
    ${inviterGameId === undefined ? '' : "AND JSON_EXTRACT(payload,'$.inviterGameId')=?"}
    ORDER BY id DESC LIMIT 50`, [playerId, new Date().toISOString(), ...(inviterGameId === undefined ? [] : [inviterGameId])]);
  return rows.map(row => ({ row, payload: invitationPayload(row) })).filter((value): value is { row: InvitationRow; payload: InvitationPayload } => Boolean(value.payload && value.payload.status === 'pending' && new Date(value.payload.expiresAt).getTime() > Date.now()));
};

/** Public character projection only: no state refresh, relationship rollover or row locks. */
export const readPublicPlayerCard = async (session: AppSession, rawGameId: unknown, db?: Db) => {
  const gameId = requirePublicPlayerId(rawGameId);
  const connection = db ?? await getPool();
  const { actor, target } = await characterPair(connection, session, gameId);
  const low = Math.min(Number(actor.id), Number(target.id));
  const high = Math.max(Number(actor.id), Number(target.id));
  const [relationships] = await connection.execute<(RowDataPacket & { status: string })[]>(
    'SELECT status FROM player_relationships WHERE character_low_id=? AND character_high_id=? LIMIT 1', [low, high]
  );
  const isSelf = Number(actor.id) === Number(target.id);
  const isFriend = ['friend', 'oath'].includes(relationships[0]?.status ?? '');
  const skillsVisible = isSelf || isFriend;
  const [requests] = await connection.execute<(RowDataPacket & { id: number; requester_character_id: number })[]>(`SELECT id,requester_character_id
    FROM player_friend_requests WHERE status='pending' AND expires_at>NOW()
    AND ((requester_character_id=? AND target_character_id=?) OR (requester_character_id=? AND target_character_id=?))
    ORDER BY id DESC LIMIT 1`, [actor.id, target.id, target.id, actor.id]);
  const { actorParty, targetParty } = await partiesForPair(connection, Number(actor.id), Number(target.id));
  const [skills] = skillsVisible ? await connection.execute<(RowDataPacket & { name: string; level: number; category: string })[]>(`SELECT s.name,ps.level,s.category
    FROM player_skills ps JOIN skill_definitions s ON s.id=ps.skill_id WHERE ps.character_id=?
    ORDER BY ps.quick_slot IS NULL,ps.quick_slot,ps.learned_at,s.id LIMIT 8`, [target.id]) : [[]];
  const incoming = (await pendingInvitations(connection, Number(actor.player_id), gameId))[0];
  const outgoing = (await pendingInvitations(connection, Number(target.player_id), Number(actor.game_id)))[0];
  const identity = socialIdentityFromCharacter(target);
  const secondaryNames: Record<string, string> = { blacksmith: '锻造师', alchemist: '炼金师', deconstructor: '解构师', omniscient: '全知者' };
  const secondaryCode = target.secondary_profession_code;
  const friendRequestStatus = !isSelf && !isFriend && requests[0]
    ? Number(requests[0].requester_character_id) === Number(actor.id) ? 'outgoing' as const : 'incoming' as const
    : 'none' as const;
  const reason = invitationDisabledReason(actor, target, actorParty, targetParty) || (outgoing ? '已发送组队邀请，等待对方回应。' : '');
  return {
    player: {
      gameId, name: String(target.name), level: Number(target.level), gender: String(target.gender),
      profession: identity.profession ?? '未选择', rank: String(target.adventurer_rank),
      secondaryProfession: secondaryCode ? (secondaryNames[secondaryCode] ?? '未选择') : '未选择',
      secondaryLevel: secondaryCode ? Math.max(1, Number(target.secondary_level) || 1) : null,
      portrait: identity.portrait, avatarUrl: identity.avatarUrl,
      regionName: target.region_name ?? '私密区域',
      skillsVisible,
      skills: skills.slice(0, 8).map(skill => ({ name: String(skill.name), level: Number(skill.level), category: String(skill.category) }))
    },
    viewer: {
      isSelf, isFriend, friendRequestStatus,
      ...(friendRequestStatus === 'incoming' ? { incomingFriendRequestId: Number(requests[0]!.id) } : {}),
      sameParty: Boolean(actorParty && targetParty?.party_id === actorParty.party_id),
      canInviteParty: !reason, inviteDisabledReason: reason,
      partyInvitationStatus: isSelf ? 'none' as const : incoming ? 'incoming' as const : outgoing ? 'outgoing' as const : 'none' as const,
      ...(incoming && !isSelf ? { incomingPartyInvitationId: Number(incoming.row.id) } : {})
    }
  };
};

export const requestPlayerFriend = async (session: AppSession, rawGameId: unknown) => {
  const gameId = requirePublicPlayerId(rawGameId);
  await characterPair(await getPool(), session, gameId);
  const result = await sendFriendRequest(await appSessionQqUser(session), gameId);
  return { message: `已向${result.targetName}发送好友申请。` };
};

export const acceptPlayerFriendRequest = async (session: AppSession, rawRequestId: unknown) => {
  const requestId = requirePublicPlayerId(rawRequestId);
  const result = await acceptFriendRequest(await appSessionQqUser(session), requestId);
  return { message: `已与${result.name}成为好友。` };
};

export const invitePlayerToParty = async (session: AppSession, rawGameId: unknown) => {
  const gameId = requirePublicPlayerId(rawGameId);
  await ensureWebNotificationInbox();
  return withTransaction(async connection => {
    const { actor, target } = await characterPair(connection, session, gameId, true);
    const { actorParty, targetParty } = await partiesForPair(connection, Number(actor.id), Number(target.id), true);
    const reason = invitationDisabledReason(actor, target, actorParty, targetParty);
    if (reason) throw new PlayerCardError(reason);
    if ((await pendingInvitations(connection, Number(target.player_id), Number(actor.game_id))).length) {
      throw new PlayerCardError('已发送组队邀请，等待对方回应。');
    }
    const payload: InvitationPayload = {
      status: 'pending', partyId: actorParty!.party_id, partyName: actorParty!.name,
      inviterGameId: Number(actor.game_id), inviterName: actor.name, targetGameId: gameId,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
    };
    const [event] = await connection.execute<ResultSetHeader>(
      "INSERT INTO player_events (player_id,event_type,payload) VALUES (?,'party.invitation',?)", [target.player_id, JSON.stringify(payload)]
    );
    const invitationId = Number(event.insertId);
    await enqueueWebNotification({ playerId: Number(target.player_id), dedupeKey: `party-invitation:${invitationId}`,
      category: 'party', title: '组队邀请', messages: [{ text: `${actor.name}邀请你加入「${actorParty!.name}」。请在频道的组队邀请中接受或拒绝，10 分钟内有效。`, buttons: [] }] }, connection);
    return { invitationId, message: `已向${target.name}发送组队邀请。` };
  });
};

export const listPlayerPartyInvitations = async (session: AppSession, db?: Db) => {
  const connection = db ?? await getPool();
  const [owners] = await connection.execute<(RowDataPacket & { game_id: number })[]>(
    "SELECT c.game_id FROM characters c JOIN players p ON p.id=c.player_id WHERE c.player_id=? AND c.npc_code IS NULL AND p.status='active' LIMIT 1", [session.playerId]
  );
  if (!owners[0]) throw new PlayerCardError('请先完成角色注册。');
  return (await pendingInvitations(connection, session.playerId))
    .filter(value => value.payload.targetGameId === Number(owners[0]!.game_id))
    .map(({ row, payload }) => ({ id: Number(row.id), inviterGameId: payload.inviterGameId, inviterName: payload.inviterName,
      partyName: payload.partyName, expiresAt: payload.expiresAt }));
};

const readInvitation = async (db: Db, session: AppSession, invitationId: number, lock = false) => {
  const [rows] = await db.execute<InvitationRow[]>(`SELECT id,payload FROM player_events
    WHERE id=? AND player_id=? AND event_type='party.invitation' LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [invitationId, session.playerId]);
  const payload = invitationPayload(rows[0]);
  if (!payload) throw new PlayerCardError('未找到这条组队邀请。', 404);
  if (payload.status !== 'pending') throw new PlayerCardError('这条组队邀请已经处理。');
  if (new Date(payload.expiresAt).getTime() <= Date.now()) throw new PlayerCardError('这条组队邀请已经过期。');
  return payload;
};

const finishInvitation = async (db: Db, session: AppSession, invitationId: number, payload: InvitationPayload, status: 'accepted' | 'rejected') => {
  const [result] = await db.execute<ResultSetHeader>(`UPDATE player_events SET payload=?
    WHERE id=? AND player_id=? AND event_type='party.invitation'
    AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.status'))='pending'`,
  [JSON.stringify({ ...payload, status }), invitationId, session.playerId]);
  if (result.affectedRows !== 1) throw new PlayerCardError('这条组队邀请已经处理。');
};

export const respondPlayerPartyInvitation = async (session: AppSession, rawInvitationId: unknown, action: unknown) => {
  const invitationId = requirePublicPlayerId(rawInvitationId);
  if (action !== 'accept' && action !== 'reject') throw new PlayerCardError('请选择接受或拒绝邀请。');
  if (action === 'reject') return withTransaction(async connection => {
    const payload = await readInvitation(connection, session, invitationId, true);
    await finishInvitation(connection, session, invitationId, payload, 'rejected');
    return { message: '已拒绝组队邀请。' };
  });
  const payload = await readInvitation(await getPool(), session, invitationId);
  const size = await joinParty(await appSessionQqUser(session), payload.partyId, { onJoined: async (connection: PoolConnection) => {
    // This callback belongs to joinParty's transaction: any stale invitation rolls the membership back.
    const current = await readInvitation(connection, session, invitationId, true);
    if (current.partyId !== payload.partyId || current.inviterGameId !== payload.inviterGameId) throw new PlayerCardError('组队邀请已经失效。');
    const { actor, target } = await characterPair(connection, session, current.inviterGameId, true);
    if (Number(actor.game_id) !== current.targetGameId || actor.activity_status !== 'active' || target.activity_status !== 'active') {
      throw new PlayerCardError('当前无法接受这条组队邀请。');
    }
    const { targetParty } = await partiesForPair(connection, Number(actor.id), Number(target.id), true);
    if (!targetParty || targetParty.party_id !== current.partyId || Number(targetParty.leader_character_id) !== Number(target.id)) {
      throw new PlayerCardError('邀请者已不再担任该队伍的队长。');
    }
    await finishInvitation(connection, session, invitationId, current, 'accepted');
  } });
  return { message: `已加入「${payload.partyName}」，当前 ${size} 人。`, partyId: payload.partyId };
};
