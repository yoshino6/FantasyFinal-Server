import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { LocalMapPosition } from './local-exploration-route';
import { surfaceRegionEnabled } from './map-surface-marks.service';
import { environmentHash } from './map-environment.config';

type TerrainField = { regionId: number; regionCode: string; seed: number };
type GroundArea = { region_id: number; code: string; danger_level: number; is_owner_only: number; is_enabled: number;
  min_x: number; max_x: number; min_y: number; max_y: number; min_z: number; max_z: number };
export type GroundWindow = { cells: { x: number; y: number; z: number; regionId: number; regionCode: string }[]; terrainFields: TerrainField[]; padding?: number; scopeToken?: 'world:0' };
const prepared = new Map<string, GroundWindow>();
const cacheLimit = 128;

/** Public base terrain only. Current visible region permissions and fresh area priority remain mandatory. */
export const prepareGroundWindow = (origin: LocalMapPosition, range: number, fields: readonly TerrainField[], areas: readonly GroundArea[], padding = 2): GroundWindow | undefined => {
  if (origin.z !== 0 || ![origin.x, origin.y, origin.regionId, range, padding].every(Number.isSafeInteger)
    || origin.regionId <= 0 || range < 0 || range > 32 || padding < 2 || padding > 12) return undefined;
  const allowed = new Map(fields.filter(field => Number.isSafeInteger(field.regionId) && field.regionId > 0
    && Number.isFinite(field.seed) && field.regionCode.trim()).map(field => [field.regionId, field]));
  if (!allowed.has(origin.regionId)) return undefined;
  const ordered = [...areas].sort((a, b) => Number(b.danger_level) - Number(a.danger_level) || Number(a.region_id) - Number(b.region_id));
  const radius = range + padding;
  const signature = JSON.stringify([origin, radius, padding, [...allowed.values()], ordered]);
  const cached = prepared.get(signature);
  if (cached) { prepared.delete(signature); prepared.set(signature, cached); return structuredClone(cached); }
  const cells: GroundWindow['cells'] = [];
  for (let dy = radius; dy >= -radius; dy--) for (let dx = -radius; dx <= radius; dx++) {
    if (Math.abs(dx) + Math.abs(dy) > radius) continue;
    const x = origin.x + dx, y = origin.y + dy;
    if (![x, y].every(Number.isSafeInteger)) continue;
    const area = ordered.find(item => x >= Number(item.min_x) && x <= Number(item.max_x)
      && y >= Number(item.min_y) && y <= Number(item.max_y) && origin.z >= Number(item.min_z) && origin.z <= Number(item.max_z));
    const field = area && allowed.get(Number(area.region_id));
    if (!area || !field || field.regionCode !== area.code || !surfaceRegionEnabled(area.code, area.is_owner_only, area.is_enabled)) continue;
    cells.push({ x, y, z: origin.z, regionId: field.regionId, regionCode: field.regionCode });
  }
  if (!cells.some(cell => cell.x === origin.x && cell.y === origin.y && cell.regionId === origin.regionId)) return undefined;
  const present = new Set(cells.map(cell => cell.regionId));
  const result = { cells, terrainFields: [...allowed.values()].filter(field => present.has(field.regionId)).map(field => ({ ...field })), padding };
  if (prepared.size >= cacheLimit) prepared.delete(prepared.keys().next().value!);
  prepared.set(signature, result);
  return structuredClone(result);
};

/** Do not cache the authorization read, private overlays, mutable obstacles or entities. */
export const groundWindowFor = async (db: Pool | PoolConnection, origin: LocalMapPosition, range: number,
  surface: { scopeToken: string; terrainFields: readonly TerrainField[] }, movement?: { step: number; speed: number }): Promise<GroundWindow | undefined> => {
  if (origin.z !== 0 || surface.scopeToken !== 'world:0' || ![origin.x, origin.y, origin.regionId, range].every(Number.isSafeInteger)
    || origin.regionId <= 0 || range < 0 || range > 32) return undefined;
  const step = typeof movement?.step === 'number' && Number.isFinite(movement.step) && movement.step > 0 ? movement.step : 0;
  const speed = typeof movement?.speed === 'number' && Number.isFinite(movement.speed) && movement.speed > 0 ? movement.speed : 0;
  // Cover one complete movement and 1.5 seconds of animation while the next read is in flight.
  // At the maximum range, radius 44 is still only 3961 public terrain cells.
  const padding = Math.max(2, Math.min(12, Math.ceil(Math.max(step, speed * 1.5)) + 1));
  const radius = range + padding;
  const [areas] = await db.execute<(RowDataPacket & GroundArea)[]>(`SELECT a.region_id,a.min_x,a.max_x,a.min_y,a.max_y,a.min_z,a.max_z,r.code,r.danger_level,r.is_owner_only,r.is_enabled
    FROM map_region_areas a JOIN map_regions r ON r.id=a.region_id WHERE ? BETWEEN a.min_z AND a.max_z
    AND a.min_x<=? AND a.max_x>=? AND a.min_y<=? AND a.max_y>=? ORDER BY r.danger_level DESC,r.id`,
  [origin.z, origin.x + radius, origin.x - radius, origin.y + radius, origin.y - radius]);
  const fields = [...surface.terrainFields];
  // Static public terrain may lead actual observation across a region boundary.
  // Preserve the observed origin and every existing field identity and seed.
  for (const area of areas) {
    const regionId = Number(area.region_id);
    if (!Number.isSafeInteger(regionId) || regionId <= 0 || regionId === origin.regionId
      || !surfaceRegionEnabled(area.code, area.is_owner_only, area.is_enabled)
      || fields.some(field => field.regionId === regionId || field.regionCode === area.code)) continue;
    fields.push({ regionId, regionCode: area.code, seed: environmentHash(`surface1:${surface.scopeToken}:${area.code}`) });
  }
  const window = prepareGroundWindow(origin, range, fields, areas, padding);
  return window ? { ...window, scopeToken: 'world:0' } : undefined;
};
