import type { RowDataPacket } from 'mysql2/promise';
import { getPool } from '../database/pool';
import { appSessionQqUser, type AppSession } from '../game/app-channel.service';
import { achievementCategories } from '../game/achievement.config';
import { achievementDetail, achievementList, achievementRewardsInDatabase, openAchievementBox } from '../game/achievement.service';
import { achievementBoxes, type AchievementBoxKey } from '../game/achievement-rewards.config';
import { itemCodex } from '../game/adventure.service';
import { codexCategories, codexKinds, codexList, monsterCodexDetail, skillCodexDetail, type CodexKind } from '../game/codex.service';
import { addWarrantReward, townWarrantsFor } from '../game/pvp.service';

const characterIdFor = (session: AppSession) => {
  if (!session.characterId) throw new Error('请先完成角色注册。');
  return Number(session.characterId);
};

const positiveInteger = (value: unknown, label: string, max = Number.MAX_SAFE_INTEGER) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new Error(`${label}无效。`);
  return number;
};

const pageFrom = (value: unknown) => value === undefined ? 1 : positiveInteger(value, '页码', 100_000);
const textFrom = (value: unknown, label: string, max: number) => {
  const text = String(value ?? '').trim();
  if (text.length > max) throw new Error(`${label}过长。`);
  return text;
};

export const handbookAchievements = async (session: AppSession, query: { category?: unknown; page?: unknown }) => {
  characterIdFor(session);
  const category = textFrom(query.category ?? '全部', '分类', 24) || '全部';
  if (!achievementCategories.includes(category as typeof achievementCategories[number])) throw new Error('未知成就分类。');
  const data = await achievementList(await appSessionQqUser(session), category, pageFrom(query.page));
  return { ...data, categories: achievementCategories, scope: 'completed_only' as const,
    entries: data.entries.map(entry => ({ ...entry, status: 'completed' as const, actions: [] })) };
};

export const handbookAchievementDetail = async (session: AppSession, idValue: unknown) => {
  characterIdFor(session);
  const id = textFrom(idValue, '成就编号', 64);
  if (!id) throw new Error('成就编号无效。');
  const entry = await achievementDetail(await appSessionQqUser(session), id);
  return { ...entry, status: 'completed' as const, actions: [] };
};

export const handbookAchievementRewards = async (session: AppSession) => {
  characterIdFor(session);
  const rewards = await achievementRewardsInDatabase(await getPool(), await appSessionQqUser(session));
  return { boxes: rewards.boxes, items: rewards.items,
    actions: (Object.keys(achievementBoxes) as AchievementBoxKey[])
      .filter(key => rewards.boxes[key] > 0)
      .map(key => ({ id: 'open_box' as const, boxKey: key, name: achievementBoxes[key].name, available: rewards.boxes[key] })) };
};

export const openHandbookAchievementBox = async (session: AppSession, boxKeyValue: unknown, body: { requestId?: unknown; quantity?: unknown }) => {
  characterIdFor(session);
  const boxKey = textFrom(boxKeyValue, '道具匣', 32) as AchievementBoxKey;
  if (!Object.prototype.hasOwnProperty.call(achievementBoxes, boxKey)) throw new Error('未知的成就道具匣。');
  const requestId = textFrom(body.requestId, '打开凭据', 64);
  const quantity = body.quantity === undefined ? 1 : positiveInteger(body.quantity, '数量', 100);
  const result = await openAchievementBox(await appSessionQqUser(session), boxKey, requestId, quantity);
  return result;
};

const codexKindFrom = (value: unknown): CodexKind => {
  const kind = textFrom(value, '图鉴分类', 8);
  if (!codexKinds.includes(kind as CodexKind)) throw new Error('未知图鉴分类。');
  return kind as CodexKind;
};

export const handbookCodex = async (session: AppSession, query: { kind?: unknown; category?: unknown; page?: unknown; keyword?: unknown }) => {
  characterIdFor(session);
  const kind = codexKindFrom(query.kind ?? '装备');
  const category = textFrom(query.category ?? '全部', '子分类', 24) || '全部';
  const categories = codexCategories(kind);
  if (!categories.some(item => item.value === category)) throw new Error('未知图鉴子分类。');
  const keyword = textFrom(query.keyword, '关键词', 80);
  const data = await codexList(await appSessionQqUser(session), kind, category, pageFrom(query.page), keyword);
  return { ...data, kinds: codexKinds, categories, pageSize: 5, scope: 'discovered_only' as const };
};

export const handbookCodexDetail = async (session: AppSession, kindValue: unknown, idValue: unknown) => {
  characterIdFor(session);
  const kind = codexKindFrom(kindValue);
  const qqUserId = await appSessionQqUser(session);
  if (kind === '怪物') {
    const id = positiveInteger(idValue, '怪物编号');
    return { kind, detailId: String(id), detail: await monsterCodexDetail(qqUserId, id), actions: [] };
  }
  if (kind === '技能') {
    const id = positiveInteger(idValue, '技能编号');
    const skill = await skillCodexDetail(qqUserId, id);
    return { kind, detailId: String(id), detail: {
      id: Number(skill.id), code: String(skill.code), codexId: String(skill.codex_id), name: String(skill.name),
      category: String(skill.category), skillKind: String(skill.skill_kind), element: String(skill.element),
      rangeType: String(skill.range_type), targetScope: String(skill.target_scope), power: Number(skill.power),
      manaCost: Number(skill.mana_cost), cooldownTurns: Number(skill.cooldown_turns), chantTurns: Number(skill.chant_turns),
      description: String(skill.description), effects: String(skill.effects ?? '')
    }, actions: [] };
  }
  const id = textFrom(idValue, '图鉴编号', 100);
  if (!id) throw new Error('图鉴编号无效。');
  const item = await itemCodex(qqUserId, id);
  const expectedType = kind === '装备' ? 'equipment' : kind === '道具' ? 'consumable' : 'material';
  if (String(item.item_type) !== expectedType) throw new Error('图鉴条目与分类不符。');
  return { kind, detailId: id, detail: {
    id: Number(item.id), code: String(item.code), codexId: String(item.codex_id), name: String(item.name),
    category: String(item.item_category), type: String(item.item_type), requiredLevel: Number(item.required_level),
    description: String(item.description), obtainSource: String(item.obtain_source), weight: Number(item.weight)
  }, actions: [] };
};

export type WarrantFilter = '全部' | '已暴露' | '近期露面' | '无行踪';
const warrantFilterFrom = (value: unknown): WarrantFilter => {
  const filter = textFrom(value ?? '全部', '通缉筛选', 12) || '全部';
  if (!['全部', '已暴露', '近期露面', '无行踪'].includes(filter)) throw new Error('通缉筛选无效。');
  return filter as WarrantFilter;
};

const warrantView = (warrant: Awaited<ReturnType<typeof townWarrantsFor>>['warrants'][number]) => ({
  id: warrant.id, name: warrant.name, regionName: warrant.regionName,
  stars: warrant.stars, skulls: warrant.skulls, rewardCopper: warrant.copper, rewardItems: warrant.items,
  trace: warrant.exposed ? 'exposed' as const : warrant.recent ? 'recent' as const : 'unknown' as const,
  position: warrant.exposed || warrant.recent ? { x: warrant.x, y: warrant.y, z: warrant.z } : null
});

export const handbookWarrants = async (session: AppSession, query: { filter?: unknown; page?: unknown }) => {
  characterIdFor(session);
  const filter = warrantFilterFrom(query.filter);
  const data = await townWarrantsFor(await appSessionQqUser(session), filter);
  const pageSize = 10;
  const total = data.warrants.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pageFrom(query.page), totalPages);
  return { regionName: data.regionName, filter, page, pageSize, total, totalPages,
    entries: data.warrants.slice((page - 1) * pageSize, page * pageSize).map(warrantView) };
};

export const handbookWarrantDetail = async (session: AppSession, idValue: unknown) => {
  const id = positiveInteger(idValue, '通缉编号');
  const data = await townWarrantsFor(await appSessionQqUser(session));
  const warrant = data.warrants.find(item => item.id === id);
  if (!warrant) throw new Error('当地没有生效中的这张通缉令。');
  const characterId = characterIdFor(session);
  const pool = await getPool();
  const [eligible] = await pool.execute<RowDataPacket[]>(`SELECT 1 FROM player_warrants w JOIN pvp_stolen_loot sl
    ON sl.holder_character_id=w.wanted_character_id AND sl.original_owner_character_id=? AND sl.returned_at IS NULL
    WHERE w.id=? AND w.status='active' LIMIT 1`, [characterId, id]);
  return { ...warrantView(warrant), actions: eligible[0] ? [{ id: 'add_reward' as const, requiresPreview: true }] : [] };
};

type WarrantPostRow = RowDataPacket & {
  id: number; warrant_id: number; wanted_name: string; region_name: string; warrant_status: string;
  item_name: string | null; reward_item_id: number | null; quantity: number; copper_amount: number;
  created_at: Date | string; claimed_at: Date | string | null; claimant_name: string | null;
};

export const handbookWarrantPosts = async (session: AppSession, pageValue?: unknown) => {
  const characterId = characterIdFor(session);
  const pageSize = 10;
  const pool = await getPool();
  const [counts] = await pool.execute<(RowDataPacket & { total: number })[]>(
    'SELECT COUNT(*) AS total FROM player_warrant_rewards WHERE issuer_character_id=?', [characterId]);
  const total = Number(counts[0]?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pageFrom(pageValue), totalPages);
  const [rows] = await pool.execute<WarrantPostRow[]>(`SELECT wr.id,wr.warrant_id,wanted.name AS wanted_name,region.name AS region_name,
    w.status AS warrant_status,item.name AS item_name,wr.reward_item_id,wr.quantity,wr.copper_amount,wr.created_at,wr.claimed_at,claimant.name AS claimant_name
    FROM player_warrant_rewards wr JOIN player_warrants w ON w.id=wr.warrant_id
    JOIN characters wanted ON wanted.id=w.wanted_character_id JOIN map_regions region ON region.id=w.city_region_id
    LEFT JOIN item_definitions item ON item.id=wr.reward_item_id LEFT JOIN characters claimant ON claimant.id=wr.claimed_by_character_id
    WHERE wr.issuer_character_id=? ORDER BY wr.created_at DESC,wr.id DESC LIMIT ? OFFSET ?`,
  [characterId, pageSize, (page - 1) * pageSize]);
  return { page, pageSize, total, totalPages, entries: rows.map(row => ({
    id: Number(row.id), warrantId: Number(row.warrant_id), wantedName: row.wanted_name, regionName: row.region_name,
    warrantStatus: row.warrant_status, itemId: row.reward_item_id === null ? null : Number(row.reward_item_id),
    itemName: row.item_name, quantity: Number(row.quantity), copper: Number(row.copper_amount),
    postedAt: new Date(row.created_at).toISOString(), claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    claimedBy: row.claimant_name
  })) };
};

export const handbookWarrantRewardItems = async (session: AppSession, pageValue?: unknown) => {
  const characterId = characterIdFor(session);
  const requestedPage = pageFrom(pageValue);
  const pool = await getPool();
  const where = `FROM player_inventory inventory JOIN item_definitions item ON item.id=inventory.item_id
    WHERE inventory.character_id=? AND item.is_tradeable=1
      AND inventory.quantity-inventory.trade_bound_quantity-inventory.personal_bound_quantity>0`;
  const [counts] = await pool.execute<(RowDataPacket & { total: number })[]>(`SELECT COUNT(*) AS total ${where}`, [characterId]);
  const total = Number(counts[0]?.total ?? 0);
  const pageSize = 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const [rows] = await pool.execute<(RowDataPacket & { id: number; name: string; codex_id: string; available: number })[]>(
    `SELECT item.id,item.name,item.codex_id,
      inventory.quantity-inventory.trade_bound_quantity-inventory.personal_bound_quantity AS available
      ${where} ORDER BY item.name,item.id LIMIT ? OFFSET ?`, [characterId, pageSize, (page - 1) * pageSize]);
  return { page, pageSize, total, totalPages, entries: rows.map(row => ({
    itemId: Number(row.id), name: row.name, codexId: row.codex_id, available: Number(row.available)
  })) };
};

export const handbookPursuitRecords = async (session: AppSession, pageValue?: unknown) => {
  const characterId = characterIdFor(session);
  const requestedPage = pageFrom(pageValue);
  const pool = await getPool();
  const [counts] = await pool.execute<(RowDataPacket & { total: number })[]>(`SELECT COUNT(*) AS total FROM player_warrants w
    WHERE w.captured_by_character_id=? OR EXISTS (SELECT 1 FROM player_warrant_rewards wr
      WHERE wr.warrant_id=w.id AND wr.claimed_by_character_id=?)`, [characterId, characterId]);
  const total = Number(counts[0]?.total ?? 0);
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const [rows] = await pool.execute<(RowDataPacket & {
    id: number; wanted_name: string; region_name: string; status: string; captured_at: Date | string | null;
    captured_by_character_id: number | null;
    reward_copper: number; reward_items: number; claimed_at: Date | string | null;
  })[]>(`SELECT w.id,wanted.name AS wanted_name,region.name AS region_name,w.status,w.captured_at,w.captured_by_character_id,
    COALESCE(rewards.reward_copper,0) AS reward_copper,COALESCE(rewards.reward_items,0) AS reward_items,rewards.claimed_at
    FROM player_warrants w JOIN characters wanted ON wanted.id=w.wanted_character_id JOIN map_regions region ON region.id=w.city_region_id
    LEFT JOIN (SELECT warrant_id,SUM(copper_amount) AS reward_copper,SUM(quantity) AS reward_items,MAX(claimed_at) AS claimed_at
      FROM player_warrant_rewards WHERE claimed_by_character_id=? GROUP BY warrant_id) rewards ON rewards.warrant_id=w.id
    WHERE w.captured_by_character_id=? OR rewards.warrant_id IS NOT NULL
    ORDER BY COALESCE(rewards.claimed_at,w.captured_at) DESC,w.id DESC LIMIT ? OFFSET ?`,
  [characterId, characterId, pageSize, (page - 1) * pageSize]);
  return { page, pageSize, total, totalPages, entries: rows.map(row => ({
    warrantId: Number(row.id), wantedName: row.wanted_name, regionName: row.region_name,
    capturedBySelf: Number(row.captured_by_character_id) === characterId,
    recordType: Number(row.captured_by_character_id) === characterId ? 'capture' as const : 'reward_claim' as const,
    capturedAt: Number(row.captured_by_character_id) === characterId && row.captured_at ? new Date(row.captured_at).toISOString() : null,
    rewardCopper: Number(row.reward_copper), rewardItems: Number(row.reward_items),
    rewardClaimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null
  })) };
};

const rewardInput = (body: { kind?: unknown; amount?: unknown; itemId?: unknown; quantity?: unknown }) => {
  const kind = textFrom(body.kind, '上赏类型', 12);
  if (kind === 'copper') return { kind, copper: positiveInteger(body.amount, '铜币数量'), itemId: null, quantity: 0 };
  if (kind === 'item') return { kind, copper: 0, itemId: positiveInteger(body.itemId, '物品编号'), quantity: positiveInteger(body.quantity, '物品数量') };
  throw new Error('上赏类型只能是铜币或物品。');
};

export const previewHandbookWarrantReward = async (session: AppSession, idValue: unknown, body: { kind?: unknown; amount?: unknown; itemId?: unknown; quantity?: unknown }) => {
  const characterId = characterIdFor(session);
  const warrantId = positiveInteger(idValue, '通缉编号');
  const input = rewardInput(body);
  const pool = await getPool();
  const [eligible] = await pool.execute<RowDataPacket[]>(`SELECT 1 FROM player_warrants w JOIN pvp_stolen_loot sl
    ON sl.holder_character_id=w.wanted_character_id AND sl.original_owner_character_id=? AND sl.returned_at IS NULL
    WHERE w.id=? AND w.status='active' LIMIT 1`, [characterId, warrantId]);
  if (!eligible[0]) throw new Error('只有被该通缉者夺走失物的玩家可以追加赏金，且通缉令须仍生效。');
  if (input.kind === 'copper') {
    const [rows] = await pool.execute<(RowDataPacket & { copper_coins: number })[]>('SELECT copper_coins FROM characters WHERE id=?', [characterId]);
    const available = Number(rows[0]?.copper_coins ?? 0);
    return { warrantId, kind: input.kind, amount: input.copper, available, canSubmit: available >= input.copper,
      reason: available >= input.copper ? null : '铜币不足。' };
  }
  const [rows] = await pool.execute<(RowDataPacket & { name: string; quantity: number; trade_bound_quantity: number; personal_bound_quantity: number })[]>(`SELECT item.name,inventory.quantity,inventory.trade_bound_quantity,inventory.personal_bound_quantity FROM player_inventory inventory
    JOIN item_definitions item ON item.id=inventory.item_id WHERE inventory.character_id=? AND inventory.item_id=? AND item.is_tradeable=1 LIMIT 1`,
  [characterId, input.itemId]);
  const available = Math.max(0, Number(rows[0]?.quantity ?? 0) - Number(rows[0]?.trade_bound_quantity ?? 0) - Number(rows[0]?.personal_bound_quantity ?? 0));
  return { warrantId, kind: input.kind, itemId: input.itemId, itemName: rows[0]?.name ?? null,
    quantity: input.quantity, available, canSubmit: available >= input.quantity,
    reason: available >= input.quantity ? null : '用于悬赏的物品数量不足或不可交易。' };
};

export const addHandbookWarrantReward = async (session: AppSession, idValue: unknown, body: { kind?: unknown; amount?: unknown; itemId?: unknown; quantity?: unknown }) => {
  const warrantId = positiveInteger(idValue, '通缉编号');
  const input = rewardInput(body);
  const result = await addWarrantReward(await appSessionQqUser(session), warrantId, input.itemId, input.quantity, input.copper);
  return { warrantId, kind: input.kind, ...result };
};
