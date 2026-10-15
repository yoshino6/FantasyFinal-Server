import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { environmentHash } from './map-environment.config';
import type { LocalMapCell, LocalMapPosition } from './local-exploration-route';
import type { TravelLeg } from './travel-path';
import { surfaceMarkPaint, surfaceMarkRadius, visibleSurfacePaint, type SurfacePaintFragment } from './map-surface-mark-geometry';

type Db = Pool | PoolConnection;
export const surfaceWalkTtlMs = 10 * 60_000;
// Compatibility export: the linear footprint fade reaches half opacity here.
export const surfaceWalkHalfLifeMs = surfaceWalkTtlMs / 2;
export const surfaceCombatTtlMs = 12 * 60 * 60_000;
export const surfaceCombatHalfLifeMs = 3 * 60 * 60_000;
export type SurfaceMarkKind = 'blood' | 'slime' | 'debris' | 'magic';
export type SurfaceRecentWalk = { id: string; regionId: number; points: { x: number; y: number }[]; ageMs: number; remainingMs: number; width: number; initialOpacity: number };
export type SurfaceCombatMark = { id: string; regionId: number; x: number; y: number; z: number; kind: SurfaceMarkKind; seed: number; intensity: number; ageMs: number; remainingMs: number; fragments?: SurfacePaintFragment[] };
export type SurfaceMarkRow = RowDataPacket & { event_key: string; scope_key: string; region_id: number; pos_x: number; pos_y: number; pos_z: number; end_x: number | null; end_y: number | null; kind: 'walk' | SurfaceMarkKind; effect_seed: number; intensity: number; occurred_at_ms: number; expires_at_ms: number };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const pointKey = (point: { x: number; y: number; z: number }) => `${point.x}:${point.y}:${point.z}`;
const isPoint = (point: LocalMapPosition) => [point.x, point.y, point.z, point.regionId].every(Number.isSafeInteger) && point.regionId > 0 && [point.x, point.y, point.z].every(value => value >= -0x80000000 && value <= 0x7fffffff);
export const surfaceRegionEnabled = (code: string, ownerOnly: unknown, enabled: unknown) => Boolean(code?.trim()) && !Number(ownerOnly) && Boolean(Number(enabled)) && !/(?:arena|test|private|story|trial|dungeon|home)/i.test(code);

/** 地下首版继续旧地面，不将未知实例或私有场景混入公共地表。 */
export const resolveSurfaceScope = async (db: Db, point: LocalMapPosition): Promise<string | null> => {
  if (!isPoint(point) || point.z < 0) return null;
  const [rows] = await db.execute<RowDataPacket[]>('SELECT code,is_owner_only,is_enabled FROM map_regions WHERE id=? LIMIT 1', [point.regionId]);
  const row = rows[0];
  return row && surfaceRegionEnabled(String(row.code), row.is_owner_only, row.is_enabled) ? `world:${point.z}` : null;
};

/** 硬截止独立于任何显示年龄；仅用于视觉，无行为或奖励修改。 */
export const surfaceMarkAge = (occurredAtMs: number, expiresAtMs: number, nowMs: number) => {
  if (![occurredAtMs, expiresAtMs, nowMs].every(Number.isFinite) || occurredAtMs > nowMs || expiresAtMs <= nowMs) return null;
  return { ageMs: nowMs - occurredAtMs, remainingMs: expiresAtMs - nowMs };
};
export const surfaceOpacityAtAge = (initial: number, ageMs: number, kind: 'walk' | SurfaceMarkKind) => {
  const ttl = kind === 'walk' ? surfaceWalkTtlMs : surfaceCombatTtlMs;
  return ageMs < 0 || ageMs >= ttl ? 0 : kind === 'walk' ? initial * (1 - ageMs / ttl) : initial * 2 ** (-ageMs / surfaceCombatHalfLifeMs);
};
const cleanupExpired = (db: PoolConnection, nowMs: number) => db.execute('DELETE FROM map_surface_marks WHERE expires_at_ms<=? ORDER BY expires_at_ms LIMIT 128', [nowMs]);
type SurfaceMarkInsert = { eventKey: string; scopeKey: string; regionId: number; x: number; y: number; z: number; endX?: number; endY?: number; kind: 'walk' | SurfaceMarkKind; seed: number; intensity: number; occurredAtMs: number; expiresAtMs: number };
const insertMarks = async (db: PoolConnection, marks: readonly SurfaceMarkInsert[]) => {
  for (let offset = 0; offset < marks.length; offset += 64) {
    const batch = marks.slice(offset, offset + 64);
    await db.execute(`INSERT INTO map_surface_marks (event_key,scope_key,region_id,pos_x,pos_y,pos_z,end_x,end_y,kind,effect_seed,intensity,occurred_at_ms,expires_at_ms)
      VALUES ${batch.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')} ON DUPLICATE KEY UPDATE event_key=event_key`, batch.flatMap(value => [digest(value.eventKey), value.scopeKey, value.regionId, value.x, value.y, value.z, value.endX ?? null, value.endY ?? null, value.kind, value.seed >>> 0, value.intensity, value.occurredAtMs, value.expiresAtMs]));
  }
};
export const recordSurfaceCombatMarkIn = async (db: PoolConnection, value: { eventKey: string; scopeKey: string; regionId: number; x: number; y: number; z: number; kind: SurfaceMarkKind; seed?: number; intensity?: number; occurredAtMs?: number }) => {
  const nowMs = Date.now(), occurredAtMs = Math.floor(value.occurredAtMs ?? nowMs);
  if (!value.eventKey?.trim() || !isPoint(value) || value.z < 0 || value.scopeKey !== `world:${value.z}` || !['blood', 'slime', 'debris', 'magic'].includes(value.kind) || value.seed !== undefined && (!Number.isSafeInteger(value.seed) || value.seed < 0 || value.seed > 0xffffffff) || !surfaceMarkAge(occurredAtMs, occurredAtMs + surfaceCombatTtlMs, nowMs)) return;
  if (await resolveSurfaceScope(db, value) !== value.scopeKey) return;
  const intensity = Math.max(.1, Math.min(1, Number(value.intensity ?? .8)));
  if (!Number.isFinite(intensity)) return;
  await insertMarks(db, [{ ...value, seed: value.seed ?? environmentHash(value.eventKey), intensity, occurredAtMs, expiresAtMs: occurredAtMs + surfaceCombatTtlMs }]);
  await cleanupExpired(db, nowMs);
};

/** 接受调用方已经合法结算的逐格序列，不接受对角线或起终点推测路线。 */
export const recordSurfaceWalkIn = async (db: PoolConnection, points: readonly LocalMapPosition[], options: { eventKey?: string; occurredAtMs?: number; segmentTimesMs?: readonly number[] } = {}) => {
  if (points.length < 2 || points.length > 4097 || points.some(point => !isPoint(point)) || options.eventKey !== undefined && !options.eventKey.trim()) return;
  if (options.segmentTimesMs && (options.segmentTimesMs.length !== points.length - 1 || options.segmentTimesMs.some((time, index) => !Number.isFinite(time) || index > 0 && time < options.segmentTimesMs![index - 1]))) return;
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1], to = points[index];
    if (from.z !== to.z || Math.abs(from.x - to.x) + Math.abs(from.y - to.y) !== 1) return;
  }
  const nowMs = Date.now(), eventKey = options.eventKey ?? `walk:${randomUUID()}`;
  const scopes = new Map<number, string | null>();
  const marks: SurfaceMarkInsert[] = [];
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1], to = points[index];
    const occurredAtMs = Math.floor(options.segmentTimesMs?.[index - 1] ?? options.occurredAtMs ?? nowMs);
    if (!surfaceMarkAge(occurredAtMs, occurredAtMs + surfaceWalkTtlMs, nowMs) || from.z < 0) continue;
    for (const point of [from, to]) if (!scopes.has(point.regionId)) scopes.set(point.regionId, await resolveSurfaceScope(db, point));
    if (!scopes.get(from.regionId) || scopes.get(from.regionId) !== scopes.get(to.regionId)) continue;
    // 跨区域边沿分配给目的区域；读取时仍要求两端感知格都获授权。
    marks.push({ eventKey: `${eventKey}:${index}`, scopeKey: scopes.get(to.regionId)!, regionId: to.regionId, x: from.x, y: from.y, z: to.z, endX: to.x, endY: to.y, kind: 'walk', seed: environmentHash(`${eventKey}:${index}`), intensity: 1, occurredAtMs, expiresAtMs: occurredAtMs + surfaceWalkTtlMs });
  }
  if (!marks.length) return;
  await insertMarks(db, marks);
  await cleanupExpired(db, nowMs);
};

/** 仅完整保存的真实四向线路可回填；每一格沿用对应经过时间，换乘段不连接。 */
export const surfaceTravelSegments = (legs: readonly TravelLeg[], startedAtMs: number, arrivalAtMs: number) => {
  if (![startedAtMs, arrivalAtMs].every(Number.isFinite) || arrivalAtMs <= startedAtMs || legs.length > 32) return [];
  if (legs.some(leg => !Number.isFinite(leg.seconds) || Number(leg.seconds) < 0)) return [];
  const totalWeight = legs.reduce((sum, leg) => sum + Number(leg.seconds), 0);
  if (!Number.isFinite(totalWeight) || !totalWeight) return [];
  let elapsed = 0;
  let previous = legs[0]?.from;
  let totalWalked = 0;
  const result: { points: LocalMapPosition[]; times: number[]; legIndex: number }[] = [];
  for (let legIndex = 0; legIndex < legs.length; legIndex++) {
    const leg = legs[legIndex], weight = Number(leg.seconds);
    if (!previous || !isPoint(leg.from) || !isPoint(leg.to) || pointKey(previous) !== pointKey(leg.from) || previous.regionId !== leg.from.regionId || !Number.isSafeInteger(leg.distance) || leg.distance < 0) return [];
    previous = leg.to;
    if (leg.kind !== 'walk') { elapsed += weight; continue; }
    if (leg.distance > 0 && weight <= 0) return [];
    if (totalWalked + leg.distance > 4096) return [];
    totalWalked += leg.distance;
    const waypoints = leg.waypoints;
    if (!waypoints || waypoints.length < 2 || !isPoint(leg.from) || !isPoint(leg.to) || pointKey(waypoints[0]) !== pointKey(leg.from) || pointKey(waypoints.at(-1)!) !== pointKey(leg.to)) return [];
    const points: LocalMapPosition[] = [{ ...waypoints[0] }];
    for (let index = 1; index < waypoints.length; index++) {
      const from = waypoints[index - 1], to = waypoints[index];
      if (!isPoint(from) || !isPoint(to) || from.z !== to.z || from.x !== to.x && from.y !== to.y) return [];
      const distance = Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
      if (distance + points.length > 4097) return [];
      for (let step = 1; step <= distance; step++) points.push({ x: from.x + Math.sign(to.x - from.x) * step, y: from.y + Math.sign(to.y - from.y) * step, z: from.z, regionId: step === distance ? to.regionId : from.regionId });
    }
    if (points.length - 1 !== leg.distance) return [];
    const times = points.slice(1).map((_, index) => Math.floor(startedAtMs + (arrivalAtMs - startedAtMs) * (elapsed + weight * (index + 1) / leg.distance) / totalWeight));
    result.push({ points, times, legIndex }); elapsed += weight;
  }
  return result;
};
export const recordSurfaceTravelIn = async (db: PoolConnection, value: { eventKey: string; legs: readonly TravelLeg[]; startedAtMs: number; arrivalAtMs: number }) => {
  if (!value.eventKey?.trim()) return;
  const segments = surfaceTravelSegments(value.legs, value.startedAtMs, value.arrivalAtMs);
  if (!segments.length) return;
  const [areas] = await db.execute<RowDataPacket[]>(`SELECT a.*,r.code,r.is_owner_only,r.is_enabled,r.danger_level FROM map_region_areas a JOIN map_regions r ON r.id=a.region_id ORDER BY r.danger_level DESC,r.id`);
  for (const segment of segments) {
    const points = segment.points.map(point => {
      const area = areas.find(area => point.x >= Number(area.min_x) && point.x <= Number(area.max_x) && point.y >= Number(area.min_y) && point.y <= Number(area.max_y) && point.z >= Number(area.min_z) && point.z <= Number(area.max_z));
      return area && surfaceRegionEnabled(String(area.code), area.is_owner_only, area.is_enabled) ? { ...point, regionId: Number(area.region_id) } : null;
    });
    // 保存线路已经经过权限/障碍重验；若当前地图覆盖仍无法识别，宁可整段不画。
    if (points.some(point => !point)) continue;
    await recordSurfaceWalkIn(db, points as LocalMapPosition[], { eventKey: `${value.eventKey}:leg:${segment.legIndex}`, segmentTimesMs: segment.times });
  }
};

/** 只返回匿名、已授权的短段和绘画碎片；不发隐藏原点或端点外的历史路线。 */
export const surfaceMarksFromRows = (rows: readonly SurfaceMarkRow[], cells: readonly LocalMapCell[], scopeKey: string, nowMs: number) => {
  const visibleCells = cells.filter(cell => cell.regionId && cell.regionCode && isPoint(cell as LocalMapPosition) && cell.z >= 0 && surfaceRegionEnabled(cell.regionCode, 0, 1) && scopeKey === `world:${cell.z}`);
  const visible = new Map(visibleCells.map(cell => [pointKey(cell), cell]));
  const recentWalks: SurfaceRecentWalk[] = [], combatMarks: SurfaceCombatMark[] = [];
  const recentCombatSites = new Set<string>();
  let fragmentCount = 0;
  for (const row of [...rows].sort((a, b) => Number(b.occurred_at_ms) - Number(a.occurred_at_ms) || a.event_key.localeCompare(b.event_key))) {
    const age = surfaceMarkAge(Number(row.occurred_at_ms), Number(row.expires_at_ms), nowMs);
    if (!age || row.scope_key !== scopeKey) continue;
    const x = Number(row.pos_x), y = Number(row.pos_y), z = Number(row.pos_z), regionId = Number(row.region_id);
    if (!isPoint({ x, y, z, regionId })) continue;
    const cell = visible.get(pointKey({ x, y, z }));
    if (row.kind === 'walk') {
      if (!cell || recentWalks.length >= 192) continue;
      const end = { x: Number(row.end_x), y: Number(row.end_y), z };
      const next = visible.get(pointKey(end));
      if (row.end_x === null || row.end_y === null || !next || Number(next.regionId) !== regionId || !cell.passable || !next.passable || Math.abs(x - end.x) + Math.abs(y - end.y) !== 1 || age.ageMs >= surfaceWalkTtlMs) continue;
      recentWalks.push({ id: row.event_key, regionId, points: [{ x, y }, { x: end.x, y: end.y }], ...age, remainingMs: Math.min(age.remainingMs, surfaceWalkTtlMs - age.ageMs), width: .34, initialOpacity: 1 });
    } else if (['blood', 'slime', 'debris', 'magic'].includes(row.kind) && age.ageMs < surfaceCombatTtlMs && combatMarks.length < 48 && fragmentCount < 768 && scopeKey === `world:${z}`) {
      const site = `${regionId}:${x}:${y}:${z}:${row.kind}`;
      if (recentCombatSites.has(site)) continue;
      const seed = Number(row.effect_seed), intensity = Math.max(0, Math.min(1, Number(row.intensity)));
      if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isFinite(intensity)) continue;
      const paint = surfaceMarkPaint(x, y, seed, row.kind, intensity);
      const fragments = visibleSurfacePaint(paint, visibleCells, { x, y, z, regionId }).slice(0, 768 - fragmentCount);
      if (!fragments.length) continue;
      const anchor = fragments[0].points.reduce((sum, point) => ({ x: sum.x + point.x / fragments[0].points.length, y: sum.y + point.y / fragments[0].points.length }), { x: 0, y: 0 });
      combatMarks.push({ id: row.event_key, regionId, x: anchor.x, y: anchor.y, z, kind: row.kind, seed, intensity, ...age, remainingMs: Math.min(age.remainingMs, surfaceCombatTtlMs - age.ageMs), fragments });
      recentCombatSites.add(site);
      fragmentCount += fragments.length;
    }
  }
  return { recentWalks: recentWalks.slice(0, 192), combatMarks: combatMarks.slice(0, 48) };
};
export const readSurfaceMarks = async (db: Db, cells: readonly LocalMapCell[], scopeKey: string, nowMs: number) => {
  const visible = cells.filter(cell => cell.regionId && cell.regionCode && isPoint(cell as LocalMapPosition) && cell.z >= 0 && surfaceRegionEnabled(cell.regionCode, 0, 1) && scopeKey === `world:${cell.z}`), regions = [...new Set(visible.map(cell => Number(cell.regionId)))];
  if (!visible.length) return { recentWalks: [] as SurfaceRecentWalk[], combatMarks: [] as SurfaceCombatMark[] };
  const select = `SELECT event_key,scope_key,region_id,pos_x,pos_y,pos_z,end_x,end_y,kind,effect_seed,intensity,occurred_at_ms,expires_at_ms
    FROM map_surface_marks WHERE scope_key=? AND pos_z=? AND region_id IN (${regions.map(() => '?').join(',')}) AND expires_at_ms>? AND occurred_at_ms<=?
      AND pos_x BETWEEN ? AND ? AND pos_y BETWEEN ? AND ?`;
  const values = (halo: number) => [scopeKey, visible[0].z, ...regions, nowMs, nowMs, Math.min(...visible.map(cell => cell.x)) - halo, Math.max(...visible.map(cell => cell.x)) + halo, Math.min(...visible.map(cell => cell.y)) - halo, Math.max(...visible.map(cell => cell.y)) + halo];
  // 两类有独立预算，繁忙通道不会挤掉全部战后印记。
  const [walkRows] = await db.execute<SurfaceMarkRow[]>(`${select} AND kind='walk' ORDER BY occurred_at_ms DESC,event_key LIMIT 192`, values(0));
  // 从已授权格边缘外扩1.5格（中心bbox共2格），覆盖跨邻格飞溅，不扩大权限集合。
  const [combatRows] = await db.execute<SurfaceMarkRow[]>(`${select} AND kind IN ('blood','slime','debris','magic') ORDER BY occurred_at_ms DESC,event_key LIMIT 96`, values(surfaceMarkRadius + .5));
  return surfaceMarksFromRows([...walkRows, ...combatRows], visible, scopeKey, nowMs);
};
