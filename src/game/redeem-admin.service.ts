import { createHash, randomInt } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { WebSession } from './admin-web.service';
import { getPool, withTransaction } from '../database/pool';
import { recordWebOperation } from './operation-journal.service';
import { configuredRewards, normalizeRedeemCode, resolveRedeemRewards } from '../app-api/redeem-code.service';

type Db = Pick<Pool | PoolConnection, 'execute'>;
type Row = RowDataPacket & Record<string, any>;
export class RedeemAdminError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const canManage = (actor: WebSession) => actor.role === 'owner' || actor.role === 'admin';
const readable = (actor: WebSession) => { if (!['owner', 'admin', 'viewer'].includes(actor.role)) throw new RedeemAdminError('无权查看兑换管理。', 403); };
const writable = (actor: WebSession) => { if (!canManage(actor)) throw new RedeemAdminError('只读账号不能管理或导出兑换码。', 403); };
const text = (value: unknown, label: string, max: number, empty = false) => {
  if (typeof value !== 'string' || value.trim().length > max || (!empty && !value.trim())) throw new RedeemAdminError(`${label}不能为空且不能超过 ${max} 字。`);
  return value.trim();
};
const integer = (value: unknown, label: string, min = 1, max = 1_000_000_000) => {
  const number = typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new RedeemAdminError(`${label}必须是 ${min}～${max} 的整数。`);
  return number;
};
const nullableInteger = (value: unknown, label: string) => value == null || value === '' ? null : integer(value, label);
const timestamp = (value: unknown, label: string) => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 40 || !/(Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new RedeemAdminError(`${label}需要包含明确时区。`);
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || ms < 0) throw new RedeemAdminError(`${label}无效。`);
  return ms;
};
const requestKey = (value: unknown) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new RedeemAdminError('缺少有效的操作编号，请刷新后重试。');
  return value.toLowerCase();
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const reasonFor = (body: Record<string, unknown>) => text(body.reason, '操作原因', 500);
const iso = (value: unknown) => value == null ? null : new Date(Number(value)).toISOString();
const rewardsForView = (value: unknown) => configuredRewards(typeof value === 'string' ? JSON.parse(value) : value);
export const campaignView = (row: Row) => {
  const remainingClaims = row.total_claim_limit == null ? null : Math.max(0, Number(row.total_claim_limit) - Number(row.claims_count));
  const now = Date.now();
  const availability = row.status !== 'active' ? row.status : row.start_at_ms != null && now < Number(row.start_at_ms) ? 'scheduled'
    : row.end_at_ms != null && now >= Number(row.end_at_ms) ? 'expired' : remainingClaims === 0 ? 'depleted' : 'active';
  return { id: Number(row.id), name: row.name, mailTitle: row.mail_title, mailContent: row.mail_content,
    rewards: rewardsForView(row.rewards_json), status: row.status, availability,
    startAt: iso(row.start_at_ms), endAt: iso(row.end_at_ms), minLevel: Number(row.min_level), maxLevel: row.max_level == null ? null : Number(row.max_level),
    totalClaimLimit: row.total_claim_limit == null ? null : Number(row.total_claim_limit), perPlayerLimit: Number(row.per_player_limit),
    claimsCount: Number(row.claims_count), remainingClaims, codeCount: Number(row.code_count ?? 0), createdAt: row.created_at };
};
const enrichCampaignNames = async (db: Db, campaigns: ReturnType<typeof campaignView>[]) => {
  // One bounded query: a detail has <=20 rewards, a list page has <=20 campaigns.
  const codes = [...new Set(campaigns.flatMap(campaign => campaign.rewards.map(reward => reward.itemCode)))];
  if (!codes.length) return campaigns;
  const [items] = await db.execute<(RowDataPacket & { code: string; name: string })[]>(
    `SELECT code,name FROM item_definitions WHERE code IN (${codes.map(() => '?').join(',')})`, codes
  );
  const names = new Map(items.map(item => [item.code, item.name]));
  return campaigns.map(campaign => ({ ...campaign, rewards: campaign.rewards.map(reward => ({ ...reward, itemName: names.get(reward.itemCode) ?? reward.itemCode })) }));
};
const codeView = (row: Row, actor: WebSession) => ({ id: Number(row.id), campaignId: row.campaign_id == null ? null : Number(row.campaign_id),
  code: canManage(actor) ? row.code_text ?? null : null, codeMasked: !canManage(actor), maxUses: row.max_uses == null ? null : Number(row.max_uses),
  usesCount: Number(row.uses_count), enabled: Boolean(Number(row.enabled)), issuedAt: row.issued_at, createdAt: row.created_at, deletedAt: row.deleted_at });
const campaignRow = async (db: Db, id: number, lock = false): Promise<Row> => {
  const projection = lock ? 'c.*' : 'c.*,(SELECT COUNT(*) FROM web_redeem_codes x WHERE x.campaign_id=c.id AND x.deleted_at IS NULL) AS code_count';
  const [rows] = await db.execute<Row[]>(`SELECT ${projection}
    FROM web_redeem_campaigns c WHERE c.id=?${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw new RedeemAdminError('兑换活动不存在。', 404);
  if (lock) {
    const [codes] = await db.execute<Row[]>('SELECT id FROM web_redeem_codes WHERE campaign_id=? AND deleted_at IS NULL FOR UPDATE', [id]);
    rows[0].code_count = codes.length;
  }
  return rows[0];
};
const normalizeCampaign = (body: Record<string, unknown>) => {
  const minLevel = integer(body.minLevel ?? 1, '最低等级', 1, 1_000_000);
  const maxLevel = nullableInteger(body.maxLevel, '最高等级');
  const startAt = timestamp(body.startAt, '开始时间'), endAt = timestamp(body.endAt, '结束时间');
  if (maxLevel != null && maxLevel < minLevel) throw new RedeemAdminError('最高等级不能低于最低等级。');
  if (startAt != null && endAt != null && endAt <= startAt) throw new RedeemAdminError('结束时间必须晚于开始时间。');
  return { name: text(body.name, '活动名称', 96), mailTitle: text(body.mailTitle, '邮件标题', 96),
    mailContent: text(body.mailContent ?? '', '邮件正文', 4000, true), startAt, endAt, minLevel, maxLevel,
    totalClaimLimit: nullableInteger(body.totalClaimLimit, '总奖励份数'), perPlayerLimit: integer(body.perPlayerLimit ?? 1, '每账号领取上限', 1, 1000) };
};
const resolved = async (db: Db, value: unknown) => {
  try { return await resolveRedeemRewards(db as Pick<PoolConnection, 'execute'>, value); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error) throw error;
    throw new RedeemAdminError(error instanceof Error && /[\u4e00-\u9fff]/.test(error.message) ? error.message : '奖励配置无效，请检查物品与数量。'); }
};
const audit = (actor: WebSession, action: string, id: number, reason: string, request: Record<string, unknown>, result: Record<string, unknown>, db: Db) =>
  recordWebOperation({ actorRef: actor.username, actionType: `redeem.${action}`, risk: 'high', reason, target: { kind: 'redeem_campaign', id }, request, result }, db as PoolConnection);
const replayMatches = (row: Row, actor: WebSession, fingerprint: string) => {
  if (row.created_by !== actor.username || row.request_hash !== fingerprint) throw new RedeemAdminError('此操作编号已用于其他内容，请恢复原操作或新建操作。', 409);
};

export const createRedeemCampaign = async (actor: WebSession, body: Record<string, unknown>) => {
  writable(actor); const reason = reasonFor(body), config = normalizeCampaign(body), key = requestKey(body.requestKey);
  return withTransaction(async db => {
    const { rewards } = await resolved(db, body.rewards);
    const fingerprint = hash(JSON.stringify({ ...config, rewards }));
    const [existing] = await db.execute<Row[]>('SELECT * FROM web_redeem_campaigns WHERE request_key=? FOR UPDATE', [key]);
    if (existing[0]) { replayMatches(existing[0], actor, fingerprint); return { ok: true, campaign: campaignView(await campaignRow(db, Number(existing[0].id), true)) }; }
    let id: number;
    try {
      const [result] = await db.execute<ResultSetHeader>(`INSERT INTO web_redeem_campaigns
        (name,mail_title,mail_content,rewards_json,start_at_ms,end_at_ms,min_level,max_level,total_claim_limit,per_player_limit,request_key,request_hash,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [config.name, config.mailTitle, config.mailContent, JSON.stringify(rewards), config.startAt, config.endAt,
        config.minLevel, config.maxLevel, config.totalClaimLimit, config.perPlayerLimit, key, fingerprint, actor.username]);
      id = Number(result.insertId);
    } catch (error: any) {
      if (error?.code !== 'ER_DUP_ENTRY') throw error;
      const [duplicate] = await db.execute<Row[]>('SELECT * FROM web_redeem_campaigns WHERE request_key=? FOR UPDATE', [key]);
      if (!duplicate[0]) throw error;
      replayMatches(duplicate[0], actor, fingerprint); id = Number(duplicate[0].id);
      return { ok: true, campaign: campaignView(await campaignRow(db, id, true)) };
    }
    await audit(actor, 'campaign.create', id, reason, { ...config, rewards }, { campaignId: id }, db);
    return { ok: true, campaign: campaignView(await campaignRow(db, id, true)) };
  });
};

export const editRedeemCampaign = async (actor: WebSession, idValue: unknown, body: Record<string, unknown>) => {
  writable(actor); const reason = reasonFor(body), id = integer(idValue, '活动编号'), config = normalizeCampaign(body);
  return withTransaction(async db => {
    const row = await campaignRow(db, id, true), { rewards } = await resolved(db, body.rewards);
    const stableRewards = (value: unknown) => JSON.stringify([...rewardsForView(value)].sort((a, b) => a.itemCode.localeCompare(b.itemCode)));
    if (Number(row.claims_count) > 0 && stableRewards(row.rewards_json) !== stableRewards(rewards)) throw new RedeemAdminError('已有领取记录，不能修改奖励内容。');
    if (config.totalClaimLimit != null && config.totalClaimLimit < Number(row.claims_count)) throw new RedeemAdminError('总奖励份数不能低于已领取次数。');
    const [claims] = await db.execute<Row[]>('SELECT player_id FROM web_redeem_code_claims WHERE campaign_id=? FOR UPDATE', [id]);
    const playerCounts = new Map<number, number>();
    for (const claim of claims) playerCounts.set(Number(claim.player_id), (playerCounts.get(Number(claim.player_id)) ?? 0) + 1);
    if ([...playerCounts.values()].some(count => config.perPlayerLimit < count)) throw new RedeemAdminError('每账号上限不能低于已有账号的领取次数。');
    await db.execute(`UPDATE web_redeem_campaigns SET name=?,mail_title=?,mail_content=?,rewards_json=?,start_at_ms=?,end_at_ms=?,min_level=?,max_level=?,total_claim_limit=?,per_player_limit=? WHERE id=?`,
      [config.name, config.mailTitle, config.mailContent, JSON.stringify(rewards), config.startAt, config.endAt, config.minLevel, config.maxLevel, config.totalClaimLimit, config.perPlayerLimit, id]);
    await audit(actor, 'campaign.edit', id, reason, { ...config, rewards }, { claimsCount: Number(row.claims_count) }, db);
    return { ok: true, campaign: campaignView(await campaignRow(db, id, true)) };
  });
};

export const setRedeemCampaignStatus = async (actor: WebSession, idValue: unknown, body: Record<string, unknown>) => {
  writable(actor); const reason = reasonFor(body), id = integer(idValue, '活动编号');
  if (!['active', 'paused'].includes(String(body.status))) throw new RedeemAdminError('活动状态无效。');
  return withTransaction(async db => {
    const row = await campaignRow(db, id, true);
    if (body.status === 'active') await resolved(db, row.rewards_json);
    await db.execute('UPDATE web_redeem_campaigns SET status=? WHERE id=?', [String(body.status), id]);
    await audit(actor, 'campaign.status', id, reason, { status: body.status }, { previousStatus: row.status }, db);
    return { ok: true, campaign: campaignView(await campaignRow(db, id, true)) };
  });
};

const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const randomRedeemCode = (length = 8, prefix = '') => prefix + Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');
export const generateRedeemCodes = async (actor: WebSession, idValue: unknown, body: Record<string, unknown>) => {
  writable(actor); const reason = reasonFor(body), campaignId = integer(idValue, '活动编号'), key = requestKey(body.requestKey);
  if (body.mode !== 'custom' && body.mode !== 'batch') throw new RedeemAdminError('请选择自定义码或批量生成。');
  const count = body.mode === 'custom' ? 1 : integer(body.count ?? 50, '生成数量', 1, 1000);
  const length = body.mode === 'custom' ? 8 : integer(body.length ?? 8, '随机长度', 6, 16);
  const prefix = body.mode === 'custom' ? '' : typeof body.prefix === 'string' ? body.prefix.trim().toUpperCase() : '';
  if (!/^[A-Z2-9]{0,4}$/.test(prefix)) throw new RedeemAdminError('前缀最多 4 位英文字母或数字 2～9。');
  let custom: string | null = null;
  try { if (body.mode === 'custom') custom = normalizeRedeemCode(body.code); }
  catch { throw new RedeemAdminError('自定义兑换码需要 4～64 位字母、数字或短横线。'); }
  const maxUses = body.mode === 'batch' && body.maxUses === undefined ? 1 : nullableInteger(body.maxUses, '单码总次数');
  const fingerprint = hash(JSON.stringify({ mode: body.mode, count, length, prefix, custom, maxUses }));
  return withTransaction(async db => {
    const campaign = await campaignRow(db, campaignId, true);
    const [batches] = await db.execute<Row[]>('SELECT * FROM web_redeem_batches WHERE campaign_id=? AND request_key=? FOR UPDATE', [campaignId, key]);
    if (batches[0]) {
      replayMatches(batches[0], actor, fingerprint);
      const [rows] = await db.execute<Row[]>('SELECT * FROM web_redeem_codes WHERE batch_id=? ORDER BY id FOR UPDATE', [batches[0].id]);
      return { ok: true, codes: rows.map(row => codeView(row, actor)), replayed: true };
    }
    const [batch] = await db.execute<ResultSetHeader>('INSERT INTO web_redeem_batches (campaign_id,request_key,request_hash,created_by) VALUES (?,?,?,?)', [campaignId, key, fingerprint, actor.username]);
    const ids: number[] = [];
    const seen = new Set<string>();
    let attempts = 0;
    while (ids.length < count && attempts < count * 10 + 20) {
      attempts++;
      const code = custom ?? randomRedeemCode(length, prefix);
      if (seen.has(code)) continue;
      seen.add(code);
      try {
        const [result] = await db.execute<ResultSetHeader>(`INSERT INTO web_redeem_codes
          (campaign_id,batch_id,code_hash,code_text,title,content,rewards_json,max_uses,issued_at)
          VALUES (?,?,?,?,?,?,?,?,NOW())`, [campaignId, batch.insertId, hash(code), code, campaign.mail_title, campaign.mail_content, JSON.stringify(rewardsForView(campaign.rewards_json)), maxUses]);
        ids.push(Number(result.insertId));
      } catch (error: any) {
        if (error?.code !== 'ER_DUP_ENTRY') throw error;
        if (custom) throw new RedeemAdminError('此兑换码已存在，请使用其他代码。');
      }
    }
    if (ids.length !== count) throw new RedeemAdminError('未能生成足够的不重复兑换码，请重试。', 503);
    await audit(actor, 'codes.generate', campaignId, reason, { mode: body.mode, count, length, maxUses }, { count: ids.length, batchId: Number(batch.insertId) }, db);
    const [rows] = await db.execute<Row[]>('SELECT * FROM web_redeem_codes WHERE batch_id=? ORDER BY id FOR UPDATE', [batch.insertId]);
    return { ok: true, codes: rows.map(row => codeView(row, actor)), replayed: false };
  });
};

const pageFor = (query: Record<string, unknown>) => Math.max(1, Math.min(100000, Math.floor(Number(query.page) || 1)));
const keywordFor = (value: unknown) => String(value ?? '').trim().slice(0, 64);
const codeFilter = (campaignId: number, query: Record<string, unknown>) => {
  let where = 'campaign_id=? AND deleted_at IS NULL'; const values: Array<number | string> = [campaignId];
  const keyword = keywordFor(query.keyword).toUpperCase();
  if (keyword) { where += ' AND (code_text LIKE ? OR code_hash=?)'; values.push(`%${keyword}%`, hash(keyword.toUpperCase())); }
  if (query.enabled != null && query.enabled !== '') { if (!['0', '1'].includes(String(query.enabled))) throw new RedeemAdminError('兑换码状态筛选无效。'); where += ' AND enabled=?'; values.push(Number(query.enabled)); }
  return { where, values };
};
export const listRedeemCampaigns = async (actor: WebSession, query: Record<string, unknown>) => {
  readable(actor); const db = await getPool(), page = pageFor(query), values: Array<string | number> = [];
  let where = 'WHERE 1=1'; const keyword = keywordFor(query.keyword);
  if (keyword) { where += ' AND c.name LIKE ?'; values.push(`%${keyword}%`); }
  if (query.status) { if (!['draft', 'active', 'paused'].includes(String(query.status))) throw new RedeemAdminError('活动状态筛选无效。'); where += ' AND c.status=?'; values.push(String(query.status)); }
  const [totals] = await db.execute<Row[]>(`SELECT COUNT(*) AS total FROM web_redeem_campaigns c ${where}`, values);
  const [rows] = await db.execute<Row[]>(`SELECT c.*,(SELECT COUNT(*) FROM web_redeem_codes x WHERE x.campaign_id=c.id AND x.deleted_at IS NULL) AS code_count
    FROM web_redeem_campaigns c ${where} ORDER BY c.id DESC LIMIT 20 OFFSET ?`, [...values, String((page - 1) * 20)]);
  const [summary] = await db.execute<Row[]>(`SELECT (SELECT COUNT(*) FROM web_redeem_campaigns) AS campaigns,
    (SELECT COUNT(*) FROM web_redeem_codes WHERE deleted_at IS NULL) AS codes,(SELECT COUNT(*) FROM web_redeem_code_claims) AS claims`);
  return { items: await enrichCampaignNames(db, rows.map(campaignView)), total: Number(totals[0]?.total ?? 0), page, pageSize: 20,
    summary: { campaigns: Number(summary[0]?.campaigns ?? 0), codes: Number(summary[0]?.codes ?? 0), claims: Number(summary[0]?.claims ?? 0) } };
};
export const getRedeemCampaign = async (actor: WebSession, idValue: unknown) => {
  readable(actor); const db = await getPool();
  const campaign = campaignView(await campaignRow(db, integer(idValue, '活动编号')));
  return { ok: true, campaign: (await enrichCampaignNames(db, [campaign]))[0] };
};
export const listRedeemCodes = async (actor: WebSession, idValue: unknown, query: Record<string, unknown>) => {
  readable(actor);
  if (!canManage(actor) && keywordFor(query.keyword)) throw new RedeemAdminError('只读账号不能按兑换码搜索。', 403);
  const db = await getPool(), campaignId = integer(idValue, '活动编号'), page = pageFor(query), filter = codeFilter(campaignId, query);
  await campaignRow(db, campaignId);
  const [totals] = await db.execute<Row[]>(`SELECT COUNT(*) AS total FROM web_redeem_codes WHERE ${filter.where}`, filter.values);
  const [rows] = await db.execute<Row[]>(`SELECT * FROM web_redeem_codes WHERE ${filter.where} ORDER BY id DESC LIMIT 20 OFFSET ?`, [...filter.values, String((page - 1) * 20)]);
  return { items: rows.map(row => codeView(row, actor)), total: Number(totals[0]?.total ?? 0), page, pageSize: 20 };
};
export const exportRedeemCodes = async (actor: WebSession, idValue: unknown, body: Record<string, unknown>) => {
  writable(actor); const reason = reasonFor(body), campaignId = integer(idValue, '活动编号'), filter = codeFilter(campaignId, body);
  return withTransaction(async db => {
    await campaignRow(db, campaignId, true);
    const [rows] = await db.execute<Row[]>(`SELECT * FROM web_redeem_codes WHERE ${filter.where} ORDER BY id LIMIT 10001 FOR UPDATE`, filter.values);
    const count = rows.length;
    if (count > 10000) throw new RedeemAdminError('一次最多导出 10000 条，请先按兑换码或状态筛选。');
    await audit(actor, 'codes.export', campaignId, reason, { hasKeyword: Boolean(keywordFor(body.keyword)), enabled: body.enabled ?? null }, { count }, db);
    return { codes: rows.map(row => codeView(row, actor)) };
  });
};
export const updateRedeemCode = async (actor: WebSession, idValue: unknown, body: Record<string, unknown>, remove = false) => {
  writable(actor); const reason = reasonFor(body), id = integer(idValue, '兑换码编号');
  return withTransaction(async db => {
    const [references] = await db.execute<Row[]>('SELECT campaign_id FROM web_redeem_codes WHERE id=?', [id]);
    if (!references[0]) throw new RedeemAdminError('兑换码不存在。', 404);
    const campaignId = references[0].campaign_id;
    if (campaignId != null) await campaignRow(db, Number(campaignId), true);
    const [rows] = await db.execute<Row[]>('SELECT * FROM web_redeem_codes WHERE id=? FOR UPDATE', [id]);
    const row = rows[0]; if (!row || row.deleted_at) throw new RedeemAdminError('兑换码已删除或不存在。', 404);
    let change: Record<string, unknown> = { codeId: id, enabled: false };
    if (remove) {
      if (Number(row.uses_count)) throw new RedeemAdminError('已有领取记录的兑换码不能删除，请停用。');
      await db.execute('UPDATE web_redeem_codes SET enabled=0,deleted_at=NOW() WHERE id=?', [id]);
    } else {
      const maxUses = Object.hasOwn(body, 'maxUses') ? nullableInteger(body.maxUses, '单码总次数') : row.max_uses;
      if (maxUses != null && Number(maxUses) < Number(row.uses_count)) throw new RedeemAdminError('单码总次数不能低于已有领取次数。');
      if (Object.hasOwn(body, 'enabled') && typeof body.enabled !== 'boolean') throw new RedeemAdminError('兑换码启用状态无效。');
      const enabled = Object.hasOwn(body, 'enabled') ? body.enabled ? 1 : 0 : Number(row.enabled);
      await db.execute('UPDATE web_redeem_codes SET enabled=?,max_uses=? WHERE id=?', [enabled, maxUses, id]);
      change = { codeId: id, enabled: Boolean(enabled), maxUses: maxUses == null ? null : Number(maxUses) };
    }
    await audit(actor, remove ? 'code.delete' : 'code.update', Number(campaignId ?? 0), reason, change, { removed: remove }, db);
    return { ok: true };
  });
};
export const listRedeemClaims = async (actor: WebSession, idValue: unknown, query: Record<string, unknown>) => {
  readable(actor); const db = await getPool(), id = integer(idValue, '活动编号'), page = pageFor(query);
  await campaignRow(db, id);
  const [totals] = await db.execute<Row[]>('SELECT COUNT(*) AS total FROM web_redeem_code_claims WHERE campaign_id=?', [id]);
  const [rows] = await db.execute<Row[]>(`SELECT r.*,x.code_text,c.game_id,c.name FROM web_redeem_code_claims r
    JOIN web_redeem_codes x ON x.id=r.code_id LEFT JOIN characters c ON c.player_id=r.player_id AND c.npc_code IS NULL
    WHERE r.campaign_id=? ORDER BY r.claimed_at DESC,r.code_id DESC,r.player_id DESC LIMIT 20 OFFSET ?`, [id, String((page - 1) * 20)]);
  return { items: rows.map(row => ({ playerId: Number(row.player_id), gameId: row.game_id == null ? null : String(row.game_id), playerName: row.name ?? null,
    code: canManage(actor) ? row.code_text ?? null : null, codeMasked: !canManage(actor), codeId: Number(row.code_id), mailId: Number(row.mail_id), claimedAt: row.claimed_at })),
    total: Number(totals[0]?.total ?? 0), page, pageSize: 20 };
};
