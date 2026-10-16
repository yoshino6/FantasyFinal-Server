import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { openingHubs } from './opening-world.config';
import { openingSafeHubs } from './opening-state';
import { pointBelongsToRegion } from './world-site-geometry';
import type { LocalMapCell } from './local-exploration-route';

type Origin = { x: number; y: number; z: number; regionId: number };
type Surface = { scopeToken: string; terrainFields: readonly { regionId: number; regionCode: string; seed: number }[] };
export type MappedSettlementRect = { minX: number; maxX: number; minY: number; maxY: number };
export type MappedSettlementReceipt = { schemaVersion: 1; regionId: number; regionCode: string; z: number; scopeToken: string; terrainSeed: number;
  areas: MappedSettlementRect[]; excludedAreas: MappedSettlementRect[] };
export type MappedSettlementArea = { region_id: number; code: string; danger_level: number; is_enabled: number; is_owner_only: number; is_spawn_enabled: number;
  min_x: number; max_x: number; min_y: number; max_y: number; min_z: number; max_z: number };
type SafeHub = { id: number; code: string; guild_code: string; pos_x: number; pos_y: number; pos_z: number };
type Scope = { inHome: boolean; isDungeon: boolean };
const rect = (area: MappedSettlementArea): MappedSettlementRect => ({ minX: Number(area.min_x), maxX: Number(area.max_x), minY: Number(area.min_y), maxY: Number(area.max_y) });
const contains = (area: MappedSettlementRect, point: Pick<Origin, 'x' | 'y'>) => point.x >= area.minX && point.x <= area.maxX && point.y >= area.minY && point.y <= area.maxY;
const orderedRects = (areas: MappedSettlementRect[]) => [...new Map(areas.map(area => [JSON.stringify(area), area])).values()]
  .sort((a, b) => a.minX - b.minX || a.minY - b.minY || a.maxX - b.maxX || a.maxY - b.maxY);
const validArea = (area: MappedSettlementArea) => Number.isSafeInteger(Number(area.region_id)) && Number(area.region_id) > 0
  && Number.isFinite(Number(area.danger_level)) && [area.min_x, area.max_x, area.min_y, area.max_y, area.min_z, area.max_z].every(value => Number.isSafeInteger(Number(value)))
  && Number(area.min_x) <= Number(area.max_x) && Number(area.min_y) <= Number(area.max_y) && Number(area.min_z) <= Number(area.max_z);
const fieldFor = (origin: Origin, surface: Surface | undefined, scope: Scope) => {
  if (scope.inHome || scope.isDungeon || ![origin.x, origin.y, origin.z, origin.regionId].every(Number.isSafeInteger) || origin.regionId <= 0 || origin.z < 0
    || surface?.scopeToken !== `world:${origin.z}` || !Array.isArray(surface.terrainFields)) return undefined;
  const fields = surface.terrainFields.filter(field => Number(field.regionId) === origin.regionId);
  if (fields.length !== 1) return undefined;
  const field = fields[0];
  return Object.hasOwn(openingHubs, field.regionCode) && openingHubs[field.regionCode as keyof typeof openingHubs].z === origin.z
    && Number.isSafeInteger(field.seed) && field.seed >= 0 && field.seed <= 0xffffffff ? field : undefined;
};

/** Pure compact public-ground geometry; movement rechecks collision separately. */
export const prepareMappedSettlementReceipt = (origin: Origin, surface: Surface | undefined, scope: Scope, ownsMap: boolean,
  safeHubs: readonly SafeHub[], allAreas: readonly MappedSettlementArea[]): MappedSettlementReceipt | undefined => {
  const field = fieldFor(origin, surface, scope);
  if (!field || !ownsMap || !allAreas.every(validArea)) return undefined;
  const hub = safeHubs.find(row => Number(row.id) === origin.regionId && row.code === field.regionCode
    && row.guild_code === openingHubs[field.regionCode as keyof typeof openingHubs].guild && Number(row.pos_z) === origin.z);
  if (!hub || ![hub.pos_x, hub.pos_y, hub.pos_z].every(value => Number.isSafeInteger(Number(value)))
    || !pointBelongsToRegion([...allAreas], origin.regionId, { x: Number(hub.pos_x), y: Number(hub.pos_y), z: Number(hub.pos_z) })) return undefined;
  const floorAreas = allAreas.filter(area => origin.z >= Number(area.min_z) && origin.z <= Number(area.max_z));
  const current = floorAreas.filter(area => Number(area.region_id) === origin.regionId);
  if (!current.length || current.some(area => area.code !== field.regionCode || Number(area.is_enabled) !== 1 || Number(area.is_owner_only) !== 0 || Number(area.is_spawn_enabled) !== 0)) return undefined;
  const areas = orderedRects(current.map(rect)), excluded: MappedSettlementRect[] = [];
  for (const own of current) for (const other of floorAreas) {
    if (Number(other.region_id) === origin.regionId || Number(other.danger_level) < Number(own.danger_level)
      || Number(other.danger_level) === Number(own.danger_level) && Number(other.region_id) > origin.regionId) continue;
    const overlap = { minX: Math.max(Number(own.min_x), Number(other.min_x)), maxX: Math.min(Number(own.max_x), Number(other.max_x)),
      minY: Math.max(Number(own.min_y), Number(other.min_y)), maxY: Math.min(Number(own.max_y), Number(other.max_y)) };
    if (overlap.minX <= overlap.maxX && overlap.minY <= overlap.maxY) excluded.push(overlap);
  }
  const excludedAreas = orderedRects(excluded);
  if (!areas.some(area => contains(area, origin)) || excludedAreas.some(area => contains(area, origin))) return undefined;
  return { schemaVersion: 1, regionId: origin.regionId, regionCode: field.regionCode, z: origin.z, scopeToken: surface!.scopeToken,
    terrainSeed: field.seed, areas, excludedAreas };
};

/** Recheck ownership and the existing safe-guild policy, on the supplied connection only. */
export const mappedSettlementFor = async (db: Pool | PoolConnection, origin: Origin, surface: Surface | undefined, scope: Scope,
  ownsMap: () => Promise<boolean>): Promise<MappedSettlementReceipt | undefined> => {
  if (!fieldFor(origin, surface, scope) || !await ownsMap()) return undefined;
  const safeHubs = await openingSafeHubs(db);
  const field = fieldFor(origin, surface, scope)!;
  if (!safeHubs.some(hub => Number(hub.id) === origin.regionId && hub.code === field.regionCode && Number(hub.pos_z) === origin.z)) return undefined;
  const [areas] = await db.execute<(RowDataPacket & MappedSettlementArea)[]>(`SELECT a.region_id,a.min_x,a.max_x,a.min_y,a.max_y,a.min_z,a.max_z,
    r.code,r.danger_level,r.is_enabled,r.is_owner_only,r.is_spawn_enabled FROM map_region_areas a JOIN map_regions r ON r.id=a.region_id
    WHERE ? BETWEEN a.min_z AND a.max_z ORDER BY r.danger_level DESC,r.id`, [origin.z]);
  return prepareMappedSettlementReceipt(origin, surface, scope, true, safeHubs as SafeHub[], areas);
};

/** Expand only a freshly checked current settlement, without authorising its entities. */
export const mappedSettlementRouteCells = (receipt: MappedSettlementReceipt | undefined, origin: Origin,
  target: Pick<Origin, 'x' | 'y' | 'z'>, observed: readonly LocalMapCell[]): LocalMapCell[] | undefined => {
  if (!receipt || receipt.regionId !== origin.regionId || receipt.z !== origin.z || target.z !== origin.z
    || ![origin.x, origin.y, origin.z, target.x, target.y, target.z].every(Number.isSafeInteger)) return undefined;
  const covered = (point: Pick<Origin, 'x' | 'y'>) => receipt.areas.some(area => contains(area, point))
    && !receipt.excludedAreas.some(area => contains(area, point));
  if (!covered(origin) || !covered(target)) return undefined;
  const maximumCells = 16384, cells = new Map<string, LocalMapCell>();
  const known = new Map(observed.map(cell => [`${cell.x}:${cell.y}:${cell.z}`, cell]));
  for (const area of receipt.areas) {
    const count = (area.maxX - area.minX + 1) * (area.maxY - area.minY + 1);
    if (!Number.isSafeInteger(count) || count < 1 || count > maximumCells) return undefined;
    for (let y = area.minY; y <= area.maxY; y++) for (let x = area.minX; x <= area.maxX; x++) {
      if (!covered({ x, y })) continue;
      const key = `${x}:${y}:${origin.z}`, cell = known.get(key);
      cells.set(key, { x, y, z: origin.z, regionId: receipt.regionId, regionCode: receipt.regionCode,
        passable: !cell || cell.passable && cell.regionId === receipt.regionId && cell.regionCode === receipt.regionCode });
      if (cells.size > maximumCells) return undefined;
    }
  }
  return [...cells.values()];
};
