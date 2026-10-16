import { createHash } from 'node:crypto';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { withTransaction } from '../database/pool';

export class RedeemCodeError extends Error {}
class RedeemConfigurationError extends Error {}
type Reward = { itemCode: string; quantity: number };
type CodeRow = RowDataPacket & {
  id: number; title: string; content: string; rewards_json: unknown; enabled: number;
  expired: number; max_uses: number | null; uses_count: number;
  campaign_id: number | null; deleted_at: Date | null;
};
type RewardItemRow = RowDataPacket & { id: number; code: string; item_type: string };
type CampaignRow = RowDataPacket & {
  id: number; status: string; mail_title: string; mail_content: string; rewards_json: unknown;
  start_at_ms: number | null; end_at_ms: number | null; min_level: number; max_level: number | null;
  total_claim_limit: number | null; per_player_limit: number; claims_count: number;
};

export const normalizeRedeemCode = (value: unknown) => {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9-]{4,64}$/.test(value.trim())) {
    throw new RedeemCodeError('请输入 4～64 位字母、数字或短横线组成的兑换码。');
  }
  return value.trim().toUpperCase();
};

export const configuredRewards = (value: unknown): Reward[] => {
  let parsed: unknown;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw new RedeemConfigurationError('Invalid redemption reward JSON.'); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 20) {
    throw new RedeemConfigurationError('Invalid redemption reward count.');
  }
  const seen = new Set<string>();
  return parsed.map((reward: unknown) => {
    if (!reward || typeof reward !== 'object' || Array.isArray(reward)) throw new RedeemConfigurationError('Invalid redemption reward.');
    const { itemCode, quantity } = reward as Record<string, unknown>;
    if (typeof itemCode !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(itemCode) || seen.has(itemCode) ||
      typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999999) {
      throw new RedeemConfigurationError('Invalid redemption reward item or quantity.');
    }
    seen.add(itemCode);
    return { itemCode, quantity };
  });
};

export const resolveRedeemRewards = async (connection: Pick<PoolConnection, 'execute'>, value: unknown) => {
  const rewards = configuredRewards(value);
  const attachments: { itemId: number; quantity: number }[] = [];
  const canonical: Reward[] = [];
  const itemIds = new Set<number>();
  let instanceCount = 0;
  for (const reward of rewards) {
    const numericId = /^\d+$/.test(reward.itemCode) ? Number(reward.itemCode) : 0;
    const [items] = await connection.execute<RewardItemRow[]>(
      'SELECT id,code,item_type FROM item_definitions WHERE code=? OR id=? LIMIT 1', [reward.itemCode, numericId]
    );
    const item = items[0];
    if (!item || !['consumable', 'material', 'equipment', 'device'].includes(item.item_type) ||
      !Number.isSafeInteger(Number(item.id)) || Number(item.id) < 1 || itemIds.has(Number(item.id))) {
      throw new RedeemConfigurationError('奖励物品不存在或重复，请检查奖励配置。');
    }
    itemIds.add(Number(item.id));
    if (item.item_type === 'equipment' || item.item_type === 'device') instanceCount += reward.quantity;
    if (instanceCount > 20) throw new RedeemConfigurationError('每次兑换的装备和异械总数不能超过 20。');
    attachments.push({ itemId: Number(item.id), quantity: reward.quantity });
    canonical.push({ itemCode: item.code, quantity: reward.quantity });
  }
  return { rewards: canonical, attachments };
};

/** Code lock + durable per-player claim make a retry return the same mail instead of another reward. */
export const redeemWebCode = async (playerId: number, codeValue: unknown) => {
  if (!Number.isSafeInteger(playerId) || playerId < 1) throw new RedeemCodeError('账号不可用，请重新登录。');
  const code = normalizeRedeemCode(codeValue);
  const codeHash = createHash('sha256').update(code).digest('hex');
  return withTransaction(async connection => {
    const [references] = await connection.execute<(RowDataPacket & { id: number; campaign_id: number | null })[]>(
      'SELECT id,campaign_id FROM web_redeem_codes WHERE code_hash=? LIMIT 1', [codeHash]
    );
    const reference = references[0];
    if (!reference) throw new RedeemCodeError('兑换码无效，请检查后重试。');
    let campaign: CampaignRow | undefined;
    if (reference.campaign_id != null) {
      const [campaigns] = await connection.execute<CampaignRow[]>('SELECT * FROM web_redeem_campaigns WHERE id=? FOR UPDATE', [reference.campaign_id]);
      campaign = campaigns[0];
      if (!campaign) throw new RedeemCodeError('此兑换活动不可用。');
    }
    const [codes] = await connection.execute<CodeRow[]>(
      `SELECT id,campaign_id,deleted_at,title,content,rewards_json,enabled,max_uses,uses_count,
       (expires_at IS NOT NULL AND expires_at<=NOW()) AS expired
       FROM web_redeem_codes WHERE code_hash=? LIMIT 1 FOR UPDATE`, [codeHash]
    );
    const row = codes[0];
    if (!row) throw new RedeemCodeError('兑换码无效，请检查后重试。');
    if (row.campaign_id !== reference.campaign_id) throw new RedeemCodeError('兑换活动已变更，请重试。');
    const [claims] = await connection.execute<(RowDataPacket & { mail_id: number })[]>(
      'SELECT mail_id FROM web_redeem_code_claims WHERE code_id=? AND player_id=? LIMIT 1 FOR UPDATE', [row.id, playerId]
    );
    if (claims[0]) return { alreadyRedeemed: true, mailId: Number(claims[0].mail_id), message: '此兑换码已兑换，奖励已发至邮件。' };
    if (row.deleted_at) throw new RedeemCodeError('此兑换码已停用。');
    if (Number(row.enabled) !== 1) throw new RedeemCodeError('此兑换码已停用。');
    if (Number(row.expired)) throw new RedeemCodeError('此兑换码已过期。');
    if (row.max_uses !== null && Number(row.uses_count) >= Number(row.max_uses)) throw new RedeemCodeError('此兑换码已领完。');
    if (campaign) {
      const now = Date.now();
      if (campaign.status !== 'active') throw new RedeemCodeError('此兑换活动尚未开放或已暂停。');
      if (campaign.start_at_ms != null && now < Number(campaign.start_at_ms)) throw new RedeemCodeError('此兑换活动尚未开始。');
      if (campaign.end_at_ms != null && now >= Number(campaign.end_at_ms)) throw new RedeemCodeError('此兑换活动已结束。');
      if (campaign.total_claim_limit != null && Number(campaign.claims_count) >= Number(campaign.total_claim_limit)) throw new RedeemCodeError('此兑换活动奖励已领完。');
      // The initial code lookup may establish an old RR snapshot before waiting for the campaign lock.
      // Locking reads must observe claims committed by the preceding holder of that lock.
      const [ownClaims] = await connection.execute<RowDataPacket[]>(
        'SELECT code_id FROM web_redeem_code_claims WHERE campaign_id=? AND player_id=? FOR UPDATE', [campaign.id, playerId]
      );
      if (ownClaims.length >= Number(campaign.per_player_limit)) throw new RedeemCodeError('本账号已达到此活动的兑换上限。');
    }
    const [characters] = await connection.execute<(RowDataPacket & { id: number; level: number })[]>(
      `SELECT c.id,c.level FROM characters c JOIN players p ON p.id=c.player_id
       WHERE p.id=? AND p.status='active' AND c.npc_code IS NULL LIMIT 1 FOR UPDATE`, [playerId]
    );
    if (!characters[0]) throw new RedeemCodeError('请先创建角色，再兑换奖励。');
    if (campaign && (Number(characters[0].level) < Number(campaign.min_level) ||
      (campaign.max_level != null && Number(characters[0].level) > Number(campaign.max_level)))) {
      throw new RedeemCodeError('角色等级不符合此兑换活动的条件。');
    }
    const mailTitle = campaign?.mail_title ?? row.title, mailContent = campaign?.mail_content ?? row.content;
    const { attachments } = await resolveRedeemRewards(connection, campaign?.rewards_json ?? row.rewards_json);
    if (typeof mailTitle !== 'string' || !mailTitle.trim() || mailTitle.length > 96 ||
      typeof mailContent !== 'string' || mailContent.length > 4000) throw new RedeemConfigurationError('Invalid redemption mail text.');
    const [mail] = await connection.execute<ResultSetHeader>(
      'INSERT INTO player_mails (character_id,title,content) VALUES (?,?,?)',
      [characters[0].id, mailTitle.trim(), mailContent.trim() || '兑换码奖励已发放，请领取附件。']
    );
    const mailId = Number(mail.insertId);
    for (const attachment of attachments) await connection.execute(
      'INSERT INTO player_mail_attachments (mail_id,item_id,quantity) VALUES (?,?,?)', [mailId, attachment.itemId, attachment.quantity]
    );
    await connection.execute('INSERT INTO web_redeem_code_claims (code_id,player_id,mail_id,campaign_id) VALUES (?,?,?,?)', [row.id, playerId, mailId, campaign?.id ?? null]);
    await connection.execute('UPDATE web_redeem_codes SET uses_count=uses_count+1 WHERE id=?', [row.id]);
    if (campaign) await connection.execute('UPDATE web_redeem_campaigns SET claims_count=claims_count+1 WHERE id=?', [campaign.id]);
    return { alreadyRedeemed: false, mailId, message: '兑换成功，奖励已发至邮件。' };
  });
};
