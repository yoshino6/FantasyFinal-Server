import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { getPool, withTransaction } from '../database/pool';
import { grantInventory } from './inventory-binding';
import { mapHiddenMentorLocations } from './map-hidden-mentor.locations';
import {
  environmentDistance, environmentDrops, environmentObjectCells, environmentProtectedCell,
  generateEnvironmentForCells, parseEnvironmentObjectId, type EnvironmentArea, type EnvironmentCell, type EnvironmentProtection, type GeneratedEnvironmentObject
} from './map-environment.config';

type Db = Pool | PoolConnection;
type EnvironmentCharacter = RowDataPacket & { id: number; current_region_id: number; pos_x: number; pos_y: number; pos_z: number; activity_status: string; current_hp: number; adventurer_registered: number };
type StateRow = RowDataPacket & { object_id: string; state: 'cleared' | 'suppressed'; revision: number };
type JobRow = RowDataPacket & { character_id: number; object_id: string; job_id: string; region_id: number; origin_x: number; origin_y: number; origin_z: number; object_json: unknown; finishes_at: Date; remaining_seconds: number };
export type EnvironmentObjectView = GeneratedEnvironmentObject & { state: 'intact' | 'clearing'; revision: number; canClear: boolean; clearReason?: string; remainingSeconds?: number; ownedJob?: boolean };
export type EnvironmentJobView = { id: string; objectId: string; objectName: string; finishesAt: string; remainingSeconds: number; ready: boolean };
export type EnvironmentRewardView = { code: string; name: string; quantity: number };
const parseObject = (value: unknown): GeneratedEnvironmentObject => (typeof value === 'string' ? JSON.parse(value) : value) as GeneratedEnvironmentObject;
const characterPoint = (character: EnvironmentCharacter): EnvironmentCell => ({ x: Number(character.pos_x), y: Number(character.pos_y), z: Number(character.pos_z), regionId: Number(character.current_region_id) });
const jobView = (job: JobRow): EnvironmentJobView => ({ id: job.job_id, objectId: job.object_id, objectName: parseObject(job.object_json).name, finishesAt: new Date(job.finishes_at).toISOString(), remainingSeconds: Math.max(0, Number(job.remaining_seconds)), ready: Number(job.remaining_seconds) <= 0 });
const characterFor = async (db: Db, user: string, lock = false) => {
  const [rows] = await db.execute<EnvironmentCharacter[]>(`SELECT c.id,c.current_region_id,c.pos_x,c.pos_y,c.pos_z,c.activity_status,c.current_hp,c.adventurer_registered
    FROM characters c JOIN players p ON p.id=c.player_id WHERE p.qq_user_id=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [user]);
  if (!rows[0]) throw new Error('请先发送“注册”创建角色。');
  return rows[0];
};
const areaRows = async (db: Db): Promise<EnvironmentArea[]> => {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT r.id AS region_id,r.code,r.danger_level,r.is_enabled,
    COALESCE(p.generation_version,1) AS generation_version,p.generation_seed,
    COALESCE(a.min_x,r.min_x) AS min_x,COALESCE(a.max_x,r.max_x) AS max_x,COALESCE(a.min_y,r.min_y) AS min_y,COALESCE(a.max_y,r.max_y) AS max_y,
    COALESCE(a.min_z,r.min_z) AS min_z,COALESCE(a.max_z,r.max_z) AS max_z FROM map_regions r LEFT JOIN map_region_areas a ON a.region_id=r.id
    LEFT JOIN map_environment_region_profiles p ON p.region_id=r.id`);
  return rows.map(row => {
    const version = Number(row.generation_version ?? 1);
    if (version !== 1 && version !== 2) throw new Error('区域环境生成版本不受支持，请联系管理员。');
    return { regionId: Number(row.region_id), code: String(row.code), danger: Number(row.danger_level), enabled: Boolean(Number(row.is_enabled)), minX: Number(row.min_x), maxX: Number(row.max_x), minY: Number(row.min_y), maxY: Number(row.max_y), minZ: Number(row.min_z), maxZ: Number(row.max_z), generationVersion: version, generationSeed: row.generation_seed == null ? undefined : String(row.generation_seed) };
  });
};
/** 查询完整对象范围内的保护点；真实坐标不进入客户端返回值。 */
const protectionsFor = async (db: Db, cells: readonly EnvironmentCell[]): Promise<EnvironmentProtection[]> => {
  if (!cells.length) return [];
  const minX = Math.min(...cells.map(cell => cell.x)) - 8, maxX = Math.max(...cells.map(cell => cell.x)) + 8;
  const minY = Math.min(...cells.map(cell => cell.y)) - 8, maxY = Math.max(...cells.map(cell => cell.y)) + 8;
  const minZ = Math.min(...cells.map(cell => cell.z)), maxZ = Math.max(...cells.map(cell => cell.z));
  const bounds = [minX, maxX, minY, maxY, minZ, maxZ];
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT pos_x AS x,pos_y AS y,pos_z AS z,2 AS radius FROM map_npcs WHERE pos_x BETWEEN ? AND ? AND pos_y BETWEEN ? AND ? AND pos_z BETWEEN ? AND ?
    UNION ALL SELECT pos_x,pos_y,pos_z,2 FROM map_special_objects WHERE pos_x BETWEEN ? AND ? AND pos_y BETWEEN ? AND ? AND pos_z BETWEEN ? AND ?
    UNION ALL SELECT pos_x,pos_y,0,2 FROM dungeon_entrances WHERE pos_x BETWEEN ? AND ? AND pos_y BETWEEN ? AND ? AND 0 BETWEEN ? AND ?
    UNION ALL SELECT plot_x,plot_y,plot_z,2 FROM player_homes WHERE status='active' AND plot_x BETWEEN ? AND ? AND plot_y BETWEEN ? AND ? AND plot_z BETWEEN ? AND ?
    `, Array.from({ length: 4 }, () => bounds).flat());
  const hidden = mapHiddenMentorLocations.filter(point => point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY && point.z >= minZ && point.z <= maxZ).map(point => ({ x: point.x, y: point.y, z: point.z, radius: 2 }));
  return [...rows.map(row => ({ x: Number(row.x), y: Number(row.y), z: Number(row.z), radius: Number(row.radius) })), ...hidden];
};
const jobRows = async (db: Db, characterId: number, lock = false) => {
  const [jobs] = await db.execute<JobRow[]>(`SELECT j.*,GREATEST(0,CEIL(TIMESTAMPDIFF(MICROSECOND,NOW(3),j.finishes_at)/1000000)) AS remaining_seconds
    FROM player_environment_jobs j WHERE j.character_id=?${lock ? ' FOR UPDATE' : ''}`, [characterId]);
  return jobs;
};
export const environmentClearStatus = async (db: Db, characterId: number): Promise<EnvironmentJobView | null> => {
  const job = (await jobRows(db, characterId))[0];
  return job ? jobView(job) : null;
};
/** 由移动、前往、战斗、开采、休息等写入口在角色行锁之后调用。 */
export const assertEnvironmentIdle = async (db: Db, characterId: number) => {
  // 与开始/取消/结算统一采用角色 -> 作业的锁顺序；旧入口可能尚未锁住角色。
  await db.execute('SELECT id FROM characters WHERE id=? FOR UPDATE', [characterId]);
  // 当前读：调用方可能在等待角色行锁前已建立 REPEATABLE READ 快照。
  const job = (await jobRows(db, characterId, true))[0];
  if (job) throw new Error(Number(job.remaining_seconds) > 0 ? `正在清理${parseObject(job.object_json).name}，请等待或取消清理后再行动。` : '清理已完成，请先结算清理或取消清理。');
};
/** 视觉、普通移动、长途路径与刷新候选点共用同一生成与持久状态查询。 */
export const environmentForCells = async (db: Db, cells: readonly EnvironmentCell[], characterId?: number): Promise<EnvironmentObjectView[]> => {
  if (!cells.length) return [];
  const areas = await areaRows(db);
  const objects = generateEnvironmentForCells(areas, cells);
  if (!objects.length) return [];
  const ids = objects.map(object => object.id), placeholders = ids.map(() => '?').join(',');
  const [states] = await db.execute<StateRow[]>(`SELECT object_id,state,revision FROM map_environment_states WHERE object_id IN (${placeholders})`, ids);
  const state = new Map(states.map(row => [row.object_id, row]));
  const protections = await protectionsFor(db, objects.flatMap(environmentObjectCells));
  // GET/面板读取不改写存档；已有角色/资源的兼容抑制由初始化迁移完成。
  const visible = objects.filter(object => !state.has(object.id) && !environmentObjectCells(object).some(cell => environmentProtectedCell(cell, protections)));
  if (!visible.length) return [];
  const [jobs] = await db.execute<JobRow[]>(`SELECT j.*,GREATEST(0,CEIL(TIMESTAMPDIFF(MICROSECOND,NOW(3),j.finishes_at)/1000000)) AS remaining_seconds FROM player_environment_jobs j WHERE j.object_id IN (${visible.map(() => '?').join(',')})`, visible.map(object => object.id));
  const byObject = new Map(jobs.map(job => [job.object_id, job]));
  const [characters] = characterId ? await db.execute<EnvironmentCharacter[]>('SELECT id,current_region_id,pos_x,pos_y,pos_z,activity_status,current_hp,adventurer_registered FROM characters WHERE id=?', [characterId]) : [[] as EnvironmentCharacter[]];
  const character = characters[0];
  return visible.map(object => {
    const job = byObject.get(object.id), ownedJob = job && Number(job.character_id) === characterId;
    const clearReason = !object.blocking ? '这是不影响通行的风景。' : !object.destructible ? '固定障碍无法清理，请绕行。' : job ? ownedJob ? '正在清理中。' : '其他冒险者正在清理。' : !character ? '靠近后可清理。' : environmentDistance(object, characterPoint(character)) !== 1 ? '请先移动到障碍物相邻的整格。' : character.activity_status !== 'active' || Number(character.current_hp) <= 0 ? '请先恢复行动状态。' : undefined;
    return { ...object, state: job ? 'clearing' : 'intact', revision: 1, canClear: !clearReason, ...(clearReason ? { clearReason } : {}), ...(job ? { remainingSeconds: Math.max(0, Number(job.remaining_seconds)), ownedJob: Boolean(ownedJob) } : {}) };
  });
};
export const environmentBlockerAt = async (db: Db, cell: EnvironmentCell, characterId?: number) => (await environmentForCells(db, [cell], characterId)).find(object => object.blocking && environmentObjectCells(object).some(point => point.x === cell.x && point.y === cell.y && point.z === cell.z && (cell.regionId === undefined || object.regionId === cell.regionId))) ?? null;

/** 只在显式出生/传送/关键物件迁入写事务中使用；普通移动必须做碰撞检查。 */
export const suppressEnvironmentForCells = async (db: Db, cells: readonly EnvironmentCell[], radius = 0) => {
  if (!cells.length) return 0;
  if (!Number.isInteger(radius) || radius < 0 || radius > 8) throw new Error('环境保护范围无效。');
  const protections = cells.map(cell => ({ ...cell, radius }));
  const expanded = new Map<string, EnvironmentCell>();
  const add = (x: number, y: number, z: number) => expanded.set(`${x}:${y}:${z}`, { x, y, z });
  for (const cell of cells) {
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) add(cell.x + dx, cell.y + dy, cell.z);
    if (radius > 0) {
      const laneX = Math.round(cell.x / 6) * 6;
      for (let x = Math.min(cell.x, laneX); x <= Math.max(cell.x, laneX); x++) for (let dy = -1; dy <= 1; dy++) add(x, cell.y + dy, cell.z);
    }
  }
  const objects = generateEnvironmentForCells(await areaRows(db), [...expanded.values()]).filter(object => environmentObjectCells(object).some(cell => environmentProtectedCell(cell, protections)));
  let count = 0;
  for (const object of objects) {
    const [result] = await db.execute<ResultSetHeader>("INSERT IGNORE INTO map_environment_states (object_id,region_id,state) VALUES (?,?,'suppressed')", [object.id, object.regionId]);
    count += Number(result.affectedRows);
  }
  return count;
};
export const environmentStatus = async (user: string) => {
  const db = await getPool(), character = await characterFor(db, user);
  return { job: await environmentClearStatus(db, Number(character.id)) };
};
export const environmentInspect = async (user: string, objectId?: string) => {
  // 感知菱形、地图权限、地下层规则与 Web 地图使用完全相同的权威快照。
  const map = await (await import('./adventure.service')).localExplorationMap(user);
  const objects = map.environment;
  const selected = objectId ? objects.find(object => object.id === objectId) : undefined;
  if (objectId && !selected) throw new Error('附近没有该环境物件，或它已被清理。');
  return { objects: selected ? [selected] : objects, job: map.environmentJob };
};
const assertCanWork = async (connection: PoolConnection, character: EnvironmentCharacter) => {
  if (character.activity_status !== 'active' || Number(character.current_hp) <= 0) throw new Error('请先恢复行动状态，再清理障碍物。');
  if (!Number(character.adventurer_registered)) throw new Error('请先完成冒险者登记。');
  // 队伍行程只记在队长名下，队员也必须等待抵达，不能借个人空闲状态开工。
  const [partyTravels] = await connection.execute<RowDataPacket[]>(`SELECT t.character_id FROM party_members own
    JOIN party_members fellow ON fellow.party_id=own.party_id JOIN player_travels t ON t.character_id=fellow.character_id
    WHERE own.character_id=? LIMIT 1`, [character.id]);
  if (partyTravels.length) throw new Error('队伍正在前往或寻怪，请等待抵达或取消行程，再清理障碍物。');
  await (await import('./lamplight.service')).assertLamplightIdle(connection, Number(character.id));
  await (await import('./adventure.service')).ensureForestGuideFreeAction(connection, Number(character.id));
  const talent = await (await import('./talent-data')).readTalentData(connection, Number(character.id));
  if (talent.jobs.some(job => job.payload.working)) throw new Error('请先暂停复盘或结束调查。');
};
export const environmentStartClearIn = async (connection: PoolConnection, user: string, objectId: string) => {
  if (!parseEnvironmentObjectId(objectId)) throw new Error('环境物件编号无效。');
  const character = await characterFor(connection, user, true), characterId = Number(character.id);
  const current = (await jobRows(connection, characterId, true))[0];
  if (current) {
    if (current.object_id === objectId) return { kind: 'clearing' as const, job: jobView(current), message: '已经在清理该障碍物，进度保持不变。' };
    throw new Error('请先结算或取消当前清理，再清理其他障碍物。');
  }
  await assertCanWork(connection, character);
  const map = await (await import('./adventure.service')).localExplorationMap(user, connection);
  const object = map.environment.find(candidate => candidate.id === objectId);
  if (!object || !object.canClear) throw new Error(object?.clearReason ?? '目标已被清理、位置已改变，或距离过远。');
  try {
    await connection.execute(`INSERT INTO player_environment_jobs (character_id,object_id,job_id,region_id,origin_x,origin_y,origin_z,object_json,finishes_at)
      VALUES (?,?,?,?,?,?,?,?,DATE_ADD(NOW(),INTERVAL ? SECOND))`, [characterId, object.id, randomUUID(), object.regionId, character.pos_x, character.pos_y, character.pos_z, JSON.stringify(object), object.workSeconds]);
  } catch (error: any) {
    if (error?.code === 'ER_DUP_ENTRY') throw new Error('该障碍物已有人清理，请刷新附近面板。');
    throw error;
  }
  // 清除例外状态与作业插入的并发竞争：状态若已出现则回滚此次作业。
  const [states] = await connection.execute<StateRow[]>('SELECT object_id,state,revision FROM map_environment_states WHERE object_id=? FOR UPDATE', [object.id]);
  if (states.length) throw new Error('该障碍物的状态已改变，请刷新附近面板。');
  const job = (await jobRows(connection, characterId))[0]!;
  return { kind: 'clearing' as const, job: jobView(job), message: `开始清理${object.name}，需要${object.workSeconds}秒；到时自动结算，也可刷新清理进度。` };
};
export const environmentCancelClearIn = async (connection: PoolConnection, user: string) => {
  const character = await characterFor(connection, user, true), current = (await jobRows(connection, Number(character.id), true))[0];
  if (!current) return { kind: 'idle' as const, message: '当前没有正在进行的清理。' };
  await connection.execute('DELETE FROM player_environment_jobs WHERE character_id=? AND job_id=?', [character.id, current.job_id]);
  return { kind: 'cancelled' as const, objectId: current.object_id, message: `已取消清理${parseObject(current.object_json).name}，障碍保留，本次不发放物品。` };
};
const settledResult = async (connection: PoolConnection, characterId: number, objectId?: string) => {
  if (!objectId) return { kind: 'idle' as const, message: '当前没有可结算的清理。', rewards: [] as EnvironmentRewardView[] };
  const [rows] = await connection.execute<RowDataPacket[]>('SELECT rewards_json FROM map_environment_rewards WHERE object_id=? AND character_id=?', [objectId, characterId]);
  if (!rows[0]) return { kind: 'idle' as const, message: '当前没有可结算的清理。', rewards: [] as EnvironmentRewardView[] };
  return { kind: 'settled' as const, objectId, alreadySettled: true, message: '该障碍物已经结算，物品不会重复发放。', rewards: (typeof rows[0].rewards_json === 'string' ? JSON.parse(rows[0].rewards_json) : rows[0].rewards_json) as EnvironmentRewardView[] };
};
export const environmentFinishClearIn = async (connection: PoolConnection, user: string, objectId?: string) => {
  const character = await characterFor(connection, user, true), characterId = Number(character.id);
  const current = (await jobRows(connection, characterId, true))[0];
  if (!current) return settledResult(connection, characterId, objectId);
  if (objectId && current.object_id !== objectId) throw new Error('清理目标已改变，请刷新清理进度。');
  if (Number(current.remaining_seconds) > 0) return { kind: 'clearing' as const, job: jobView(current), message: `还需${current.remaining_seconds}秒，清理尚未完成。` };
  const saved = parseObject(current.object_json), parsed = parseEnvironmentObjectId(current.object_id);
  if (!parsed || saved.id !== current.object_id) throw new Error('清理目标数据无效，请取消清理并刷新地图。');
  const areas = await areaRows(connection);
  // 当前读，不依赖事务较早的普通查询快照；profile 登记后不可更改。
  const [profiles] = await connection.execute<RowDataPacket[]>('SELECT generation_version,generation_seed FROM map_environment_region_profiles WHERE region_id=? FOR UPDATE', [current.region_id]);
  const version = Number(profiles[0]?.generation_version ?? 1);
  if (version !== parsed.version) throw new Error('清理目标与区域生成版本不符，请取消清理并刷新地图。');
  const generationAreas = areas.map(area => area.regionId === Number(current.region_id) ? { ...area, generationVersion: version as 1 | 2, generationSeed: profiles[0]?.generation_seed == null ? area.generationSeed : String(profiles[0].generation_seed) } : area);
  const object = generateEnvironmentForCells(generationAreas, [{ x: parsed.x, y: parsed.y, z: parsed.z }]).find(candidate => candidate.id === current.object_id);
  if (!object || object.regionId !== Number(current.region_id) || !object.destructible
    || ['templateId', 'x', 'y', 'z', 'width', 'height'].some(key => saved[key as keyof GeneratedEnvironmentObject] !== object[key as keyof GeneratedEnvironmentObject])
    || JSON.stringify(saved.footprint) !== JSON.stringify(object.footprint)) throw new Error('清理目标已失效，请取消清理并刷新地图。');
  const protections = await protectionsFor(connection, environmentObjectCells(object));
  if (environmentObjectCells(object).some(cell => environmentProtectedCell(cell, protections))) throw new Error('清理目标位于受保护地点，请取消清理并刷新地图。');
  if (Number(character.current_region_id) !== Number(current.region_id) || Number(character.pos_x) !== Number(current.origin_x) || Number(character.pos_y) !== Number(current.origin_y) || Number(character.pos_z) !== Number(current.origin_z) || environmentDistance(object, characterPoint(character)) !== 1) throw new Error('你已离开清理位置，请取消清理并返回障碍旁重新开始。');
  if (character.activity_status !== 'active' || Number(character.current_hp) <= 0) throw new Error('当前无法结算清理，请恢复行动或取消清理。');
  const [conflicts] = await connection.execute<RowDataPacket[]>(`SELECT '移动' AS reason FROM player_travels WHERE character_id=?
    UNION ALL SELECT '开采' FROM player_resource_mining WHERE character_id=?
    UNION ALL SELECT '战斗' FROM combat_members cm JOIN combat_sessions cs ON cs.id=cm.session_id WHERE cm.character_id=? AND cs.state='active'
    UNION ALL SELECT '玩家对战' FROM player_pvp_battle_sessions WHERE state='active' AND (attacker_character_id=? OR defender_character_id=?)
    UNION ALL SELECT '交涉' FROM negotiation_participants np JOIN negotiation_sessions ns ON ns.id=np.session_id WHERE np.character_id=? AND ns.state='active' LIMIT 1`, Array(6).fill(characterId));
  if (conflicts.length) throw new Error(`请先结束${conflicts[0].reason}，再结算清理。`);
  // 全局 object_id 主键是唯一销毁与奖励凭据；作业锁与发奖同一事务提交。
  const [cleared] = await connection.execute<ResultSetHeader>("INSERT IGNORE INTO map_environment_states (object_id,region_id,state,cleared_by) VALUES (?,?,'cleared',?)", [object.id, object.regionId, characterId]);
  if (Number(cleared.affectedRows) !== 1) {
    await connection.execute('DELETE FROM player_environment_jobs WHERE character_id=? AND job_id=?', [characterId, current.job_id]);
    return settledResult(connection, characterId, object.id);
  }
  const rewards: EnvironmentRewardView[] = [];
  for (const drop of environmentDrops(object)) {
    const [items] = await connection.execute<RowDataPacket[]>('SELECT id,code,name FROM item_definitions WHERE code=? AND stackable=1 LIMIT 1', [drop.code]);
    if (!items[0]) throw new Error(`清理产物${drop.code}尚未配置，请联系管理员；本次作业与奖励未结算。`);
    await grantInventory(connection, characterId, Number(items[0].id), { unbound: drop.quantity, trade: 0, personal: 0 });
    await connection.execute('INSERT IGNORE INTO player_item_codex (character_id,item_id) VALUES (?,?)', [characterId, items[0].id]);
    rewards.push({ code: drop.code, name: String(items[0].name), quantity: drop.quantity });
  }
  await connection.execute('INSERT INTO map_environment_rewards (object_id,job_id,character_id,rewards_json) VALUES (?,?,?,?)', [object.id, current.job_id, characterId, JSON.stringify(rewards)]);
  await connection.execute('DELETE FROM player_environment_jobs WHERE character_id=? AND job_id=?', [characterId, current.job_id]);
  return { kind: 'settled' as const, objectId: object.id, alreadySettled: false, rewards, message: `${object.name}已清理，占用整格全部开放。${rewards.map(reward => `获得${reward.name}×${reward.quantity}`).join('、')}` };
};
export const environmentStartClear = (user: string, objectId: string) => withTransaction(connection => environmentStartClearIn(connection, user, objectId));
export const environmentCancelClear = (user: string) => withTransaction(connection => environmentCancelClearIn(connection, user));
export const environmentFinishClear = (user: string, objectId?: string) => withTransaction(connection => environmentFinishClearIn(connection, user, objectId));
/** 到期结算复用同一角色/作业行锁与奖励账本，Web/QQ 同时重试也仅发奖一次。 */
export const settleDueEnvironmentClearings = async () => {
  const db = await getPool();
  const [jobs] = await db.execute<RowDataPacket[]>(`SELECT p.qq_user_id,j.object_id FROM player_environment_jobs j
    JOIN characters c ON c.id=j.character_id JOIN players p ON p.id=c.player_id WHERE j.finishes_at<=NOW() ORDER BY j.finishes_at LIMIT 100`);
  let settled = 0, failed = 0;
  for (const job of jobs) {
    try {
      const result = await environmentFinishClear(String(job.qq_user_id), String(job.object_id));
      if (result.kind === 'settled' && !result.alreadySettled) settled++;
    } catch { failed++; } // 单个异常作业保留供玩家取消/管理员排查，不阻塞其他作业。
  }
  return { settled, failed };
};
