import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { LocalMapCell, LocalMapPosition } from './local-exploration-route';
import { environmentHash, environmentObjectCells, environmentProtectedCell, generateEnvironmentForCells, type EnvironmentArea } from './map-environment.config';
import type { EnvironmentObjectView } from './map-environment.service';
import { readSurfaceMarks, resolveSurfaceScope, surfaceRegionEnabled, type SurfaceCombatMark, type SurfaceRecentWalk } from './map-surface-marks.service';
import { surfaceRandomFraction as random } from './map-surface-seed';
import { sampleSurfaceEcology, surfaceEcologySeed, type SurfaceEcologySample } from './map-ecology-field';
import { clipSettlementLayout, isSettlementRegion, planSettlementLayout, type SettlementLayout } from './map-settlement-layout';
export { sampleSurfaceEcology, surfaceEcologySeed, type SurfaceEcologySample } from './map-ecology-field';

type Db = Pool | PoolConnection;
export const sceneryGeneratorVersion = 1;
export type SurfaceScenery = { id: string; regionId: number; assetKey: string; x: number; y: number; z: number; scale: number; rotation: number; flip: boolean };
export type SurfaceRoad = { id: string; regionId: number; points: { x: number; y: number }[]; width: number };
export type MapSurfaceScene = { schemaVersion: 1; sceneryVersion: 1; scopeToken: string; snapshotId: string; serverNowMs: number; terrainFields: { regionId: number; regionCode: string; seed: number }[]; scenery: SurfaceScenery[]; roads: SurfaceRoad[]; recentWalks: SurfaceRecentWalk[]; combatMarks: SurfaceCombatMark[] };
type SurfaceArea = { region_id: number; code: string; is_owner_only: number; is_enabled: number; danger_level: number; min_x: number; max_x: number; min_y: number; max_y: number; min_z: number; max_z: number; generation_version?: number; generation_seed?: string };
type SurfaceFocus = { id: string; regionId: number; x: number; y: number; z: number };
type SceneryCandidate = { id: string; x: number; y: number; scale: number; priority: number; patch: boolean; clusterX: number; clusterY: number; family: number };
export const sceneryCandidatePitch = 1.85;
export const sceneryPairSpacing = (a: Pick<SceneryCandidate, 'scale'>, b: Pick<SceneryCandidate, 'scale'>) => .16 + (a.scale + b.scale) * .15;
const key = (point: { x: number; y: number; z: number }) => `${point.x}:${point.y}:${point.z}`;
const smooth = (n: number) => n * n * (3 - 2 * n);
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const ramp = (a: number, b: number, n: number) => smooth(clamp((n - a) / (b - a)));
type SceneryHabitat = { patch: number; companions: readonly number[] };
const habitats = {
  grass: { patch: 0, companions: [0, 1, 2, 3] }, whiteFlowers: { patch: 1, companions: [0, 2, 4, 4, 7] },
  yellowFlowers: { patch: 2, companions: [0, 2, 5, 5, 7] }, violetFlowers: { patch: 3, companions: [0, 1, 6, 6] },
  leafGrass: { patch: 4, companions: [0, 1, 2, 12, 13] }, poorGrass: { patch: 5, companions: [0, 3, 15, 32, 34, 35] },
  shrub: { patch: 6, companions: [1, 2, 8, 12, 13] }, fern: { patch: 7, companions: [8, 8, 9, 10, 14, 28] },
  litter: { patch: 8, companions: [11, 12, 13, 14, 15, 24] }, edge: { patch: 9, companions: [0, 1, 2, 4, 8, 12] },
  reeds: { patch: 10, companions: [16, 17, 19, 21, 25, 27] }, damp: { patch: 11, companions: [19, 24, 26, 28, 29, 31] },
  dry: { patch: 12, companions: [0, 3, 15, 22, 32, 34, 35] }, snow: { patch: 13, companions: [32, 36, 37, 38, 39, 40, 41] },
  ruins: { patch: 14, companions: [2, 12, 24, 32, 42, 43, 44, 45, 47] }, rock: { patch: 15, companions: [0, 3, 22, 32, 33, 34, 35, 46] }
} satisfies Record<string, SceneryHabitat>;
const ecologyProfiles: Record<string, 'meadow' | 'forest' | 'shore' | 'swamp' | 'mountain' | 'snow' | 'ruins' | 'town'> = {
  world_tree: 'town', baina_town: 'town', floating_leaf_town: 'town', frost_dragon_inn: 'snow',
  worldtree_meadow: 'meadow', morningdew_riverbank: 'shore', gravelwind_shore: 'mountain', dark_forest: 'forest', dark_forest_deep: 'forest',
  ridge_foothills: 'mountain', rediron_pass: 'mountain', mistalgae_marsh: 'swamp', fallenstar_swamp: 'swamp',
  frostcrown_plateau: 'snow', thundercliff: 'mountain', eclipse_ruins: 'ruins'
};
const ecologyProfileFor = (code: string) => ecologyProfiles[code] ?? (/frost|snow/.test(code) ? 'snow'
  : /dungeon|ruins|arena/.test(code) ? 'ruins' : /marsh|swamp/.test(code) ? 'swamp' : /river/.test(code) ? 'shore'
    : /ridge|shore|cliff|rediron/.test(code) ? 'mountain' : /town|inn/.test(code) ? 'town' : /forest/.test(code) ? 'forest' : 'meadow');
const ecologyHabitat = (code: string, sample: SurfaceEcologySample, family: number): SceneryHabitat => {
  const profile = ecologyProfileFor(code);
  if (profile === 'snow') return habitats.snow;
  if (profile === 'ruins') return sample.cover > .57 ? habitats.litter : habitats.ruins;
  if (profile === 'mountain') return sample.rock > .47 ? habitats.rock : habitats.dry;
  if (profile === 'swamp') return sample.moisture > .5 ? habitats.damp : habitats.reeds;
  if (profile === 'shore') return sample.moisture > .55 ? habitats.reeds : sample.rock > .61 ? habitats.rock : habitats.leafGrass;
  if (sample.fertility < .29 || sample.rock > .76) return habitats.poorGrass;
  if (profile === 'forest' && sample.shade > .36) return sample.moisture > .52
    ? family < .40 ? habitats.fern : family < .68 ? habitats.litter : family < .83 ? habitats.damp : habitats.edge
    : family < .46 ? habitats.shrub : family < .75 ? habitats.litter : habitats.edge;
  if (sample.flowers > .57 && sample.fertility > .37 && profile !== 'town') return family < .42 ? habitats.whiteFlowers : family < .77 ? habitats.yellowFlowers : habitats.violetFlowers;
  return family < .55 ? habitats.grass : habitats.leafGrass;
};
const habitatPatchScale = (patch: number, unit: number) => [1, 2, 3].includes(patch) ? .88 + unit * .55 : [6, 7, 9].includes(patch) ? .95 + unit * .65 : 1.05 + unit * .70;
const roadDistance = (point: { x: number; y: number }, roads: readonly SurfaceRoad[], regionId: number) => {
  let distance = Infinity;
  const measure = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    distance = Math.min(distance, Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy));
  };
  for (const road of roads) if (road.regionId === regionId) {
    const compact: { x: number; y: number }[] = [];
    for (const current of road.points) {
      const last = compact[compact.length - 1];
      if (last && last.x === current.x && last.y === current.y) continue;
      while (compact.length > 1) {
        const a = compact[compact.length - 2], b = compact[compact.length - 1], ax = b.x - a.x, ay = b.y - a.y, bx = current.x - b.x, by = current.y - b.y;
        if (Math.abs(ax * by - ay * bx) > .00001 || ax * bx + ay * by <= 0) break;
        compact.pop();
      }
      compact.push(current);
    }
    for (let index = 1; index < compact.length; index++) measure(compact[index - 1], compact[index]);
    // 同时避让 Web 最大圆角的内侧；始终取完整道路，不随感知裁切半径改变群落。
    for (let index = 1; index < compact.length - 1; index++) {
      const before = compact[index - 1], turn = compact[index], after = compact[index + 1], ax = turn.x - before.x, ay = turn.y - before.y, bx = after.x - turn.x, by = after.y - turn.y;
      const aLength = Math.hypot(ax, ay), bLength = Math.hypot(bx, by);
      if (!aLength || !bLength || Math.abs(ax * by - ay * bx) < .00001) continue;
      const radius = Math.min(1.65, aLength * .45, bLength * .45), entry = { x: turn.x - ax / aLength * radius, y: turn.y - ay / aLength * radius }, exit = { x: turn.x + bx / bLength * radius, y: turn.y + by / bLength * radius };
      let previous = entry;
      for (let step = 1; step <= 24; step++) {
        const t = step / 24, u = 1 - t, next = { x: u * u * entry.x + 2 * u * t * turn.x + t * t * exit.x, y: u * u * entry.y + 2 * u * t * turn.y + t * t * exit.y };
        measure(previous, next); previous = next;
      }
    }
  }
  return distance;
};

/** 先连续生境、再同种群落和伴生小物；密集边缘与开阔低谷由同一世界场决定。 */
export const generateSurfaceScenery = (cells: readonly LocalMapCell[], scopeToken: string, blocked: ReadonlySet<string>, focuses: readonly SurfaceFocus[] = [], roads: readonly SurfaceRoad[] = []): SurfaceScenery[] => {
  const floor = /^world:(\d+)$/.exec(scopeToken), z = floor ? Number(floor[1]) : -1;
  if (!cells.length || cells.length > 16_384 || !Number.isSafeInteger(z) || z < 0) return [];
  const allowed = new Map<string, LocalMapCell>(), denied = new Set<string>();
  for (const cell of cells) {
    if (cell.z !== z || ![cell.x, cell.y, cell.z].every(Number.isSafeInteger)) continue;
    const identity = key(cell), previous = allowed.get(identity);
    if (cell.passable !== true || !Number.isSafeInteger(cell.regionId) || Number(cell.regionId) <= 0 || typeof cell.regionCode !== 'string' || !surfaceRegionEnabled(cell.regionCode, 0, 1)
      || previous && (previous.regionId !== cell.regionId || previous.regionCode !== cell.regionCode)) { denied.add(identity); allowed.delete(identity); continue; }
    if (!denied.has(identity)) allowed.set(identity, cell);
  }
  if (!allowed.size) return [];
  const known = [...allowed.values()];
  const result: SurfaceScenery[] = [], pitch = sceneryCandidatePitch;
  const minX = Math.floor((Math.min(...known.map(cell => cell.x)) - 2) / pitch), maxX = Math.floor((Math.max(...known.map(cell => cell.x)) + 2) / pitch);
  const minY = Math.floor((Math.min(...known.map(cell => cell.y)) - 2) / pitch), maxY = Math.floor((Math.max(...known.map(cell => cell.y)) + 2) / pitch);
  if ((maxX - minX + 1) * (maxY - minY + 1) > 16_384) return [];
  const ecologySeed = surfaceEcologySeed(scopeToken);
  const candidateCache = new Map<string, SceneryCandidate[]>();
  const candidatesAt = (gx: number, gy: number): SceneryCandidate[] => {
    const cacheKey = `${gx}:${gy}`, cached = candidateCache.get(cacheKey); if (cached) return cached;
    const base = `scenery${sceneryGeneratorVersion}e2:${scopeToken}:${z}:${gx}:${gy}`;
    const clusterX = (gx + random(`${base}:x`)) * pitch, clusterY = (gy + random(`${base}:y`)) * pitch;
    const sample = sampleSurfaceEcology(clusterX, clusterY, ecologySeed), family = random(`${base}:family`);
    const candidates: SceneryCandidate[] = [];
    if (random(`${base}:open`) <= .045 + ramp(.22, .64, sample.cover) * .70) {
      const patch = random(`${base}:patch`) > .12;
      const count = 1 + Math.floor(random(`${base}:count`) * 2) + Number(patch);
      for (let slot = 0; slot < count; slot++) {
        const id = `${base}:${slot}`, isPatch = patch && slot === 0;
        const angle = random(`${id}:angle`) * Math.PI * 2, radius = isPatch ? .08 : .4 + random(`${id}:radius`) * .72;
        const x = Math.round((clusterX + Math.cos(angle) * radius) * 256) / 256, y = Math.round((clusterY + Math.sin(angle) * radius) * 256) / 256;
        // 成组主景观先于伴生碎叶竞争，避免簇群被多个零碎单株挤掉后又退回散点画面。
        const priority = (environmentHash(`${id}:priority`) >>> 1) + (isPatch ? 0 : 0x80000000);
        // 保留旧最大包络参与邻域竞争；缩小原画不额外塞密度，也无需猜视野外生境。
        candidates.push({ id, x, y, patch: isPatch, clusterX, clusterY, family, scale: isPatch ? 1.25 + random(`${id}:scale`) * .85 : .25 + random(`${id}:scale`) * .5, priority });
      }
    }
    candidateCache.set(cacheKey, candidates); return candidates;
  };
  for (let gy = minY; gy <= maxY; gy++) for (let gx = minX; gx <= maxX; gx++) {
    for (const candidate of candidatesAt(gx, gy)) {
      const { id, x, y } = candidate;
      const cell = allowed.get(key({ x: Math.floor(x + .5), y: Math.floor(y + .5), z }));
      if (!cell || blocked.has(key(cell))) continue;
      const habitat = ecologyHabitat(String(cell.regionCode), sampleSurfaceEcology(candidate.clusterX, candidate.clusterY, ecologySeed), candidate.family);
      const scale = candidate.patch ? habitatPatchScale(habitat.patch, random(`${id}:scale`)) : candidate.scale;
      // 邻候选空间一并参与固定优先级筛选，不依赖视口、裁剪或区块加载顺序。
      let crowded = false;
      for (let ny = gy - 2; ny <= gy + 2 && !crowded; ny++) for (let nx = gx - 2; nx <= gx + 2 && !crowded; nx++) for (const other of candidatesAt(nx, ny)) {
        if (other.id === id || other.priority > candidate.priority || other.priority === candidate.priority && other.id > id) continue;
        if (Math.hypot(x - other.x, y - other.y) < sceneryPairSpacing(candidate, other)) { crowded = true; break; }
      }
      if (crowded) continue;
      if (focuses.some(focus => focus.regionId === cell.regionId && focus.z === z && Math.hypot(x - focus.x, y - focus.y) < 1.3 + (candidate.patch ? scale * .3 : 0)) || roadDistance({ x, y }, roads, Number(cell.regionId)) < .32 + (candidate.patch ? scale * .16 : 0)) continue;
      const asset = habitat.companions[environmentHash(`${id}:${cell.regionCode}:asset`) % habitat.companions.length];
      const ground = [11, 12, 13, 14, 15, 19, 20, 22, 23, 24, 26, 29, 31, 32, 33, 34, 37, 39, 40, 42, 43, 44, 46, 47].includes(asset);
      result.push({ id, regionId: Number(cell.regionId), assetKey: candidate.patch ? `scenery_patch_${habitat.patch}` : `scenery_${asset}`, x, y, z, scale, rotation: (random(`${id}:rotation`) - .5) * (candidate.patch ? 16 : ground ? 140 : 18), flip: random(`${id}:flip`) > .5 });
    }
  }
  // 稳定ID优先级预算，不依赖候选遍历顺序。
  return result.sort((a, b) => environmentHash(a.id) - environmentHash(b.id)).slice(0, Math.min(1024, Math.max(24, Math.ceil(cells.length * .8))));
};

/** 四向逐格道路，不使用越障平滑；客户端圆角必须保持在合法格内。 */
export const planSurfaceRoad = (from: SurfaceFocus, to: SurfaceFocus, cells: readonly LocalMapCell[]): SurfaceRoad | null => {
  if (from.regionId !== to.regionId || from.z !== to.z) return null;
  const allowed = new Map(cells.filter(cell => cell.passable && cell.regionId === from.regionId && cell.z === from.z).map(cell => [key(cell), cell]));
  const start = key(from), end = key(to), queue = [from], previous = new Map<string, string>(), visited = new Set([start]);
  if (!allowed.has(start) || !allowed.has(end)) return null;
  for (let head = 0; head < queue.length && queue.length <= 1600; head++) {
    const current = queue[head];
    if (key(current) === end) {
      const points = [{ x: to.x, y: to.y }];
      for (let cursor = end; cursor !== start;) { cursor = previous.get(cursor)!; const cell = allowed.get(cursor)!; points.unshift({ x: cell.x, y: cell.y }); }
      const anonymousId = createHash('sha256').update(`${from.regionId}:${from.z}:${[from.id, to.id].sort().join(':')}`).digest('hex').slice(0, 24);
      return { id: `road1:${anonymousId}`, regionId: from.regionId, points, width: .72 };
    }
    const order = environmentHash(`${from.id}:${to.id}:${current.x}:${current.y}`) % 2 ? [[1, 0], [0, 1], [-1, 0], [0, -1]] : [[0, 1], [1, 0], [0, -1], [-1, 0]];
    for (const [dx, dy] of order) {
      const cell = allowed.get(key({ x: current.x + dx, y: current.y + dy, z: from.z }));
      if (!cell || visited.has(key(cell))) continue;
      visited.add(key(cell)); previous.set(key(cell), key(current)); queue.push({ ...cell, id: '', regionId: from.regionId });
    }
  }
  return null;
};
export const clipSurfaceRoads = (roads: readonly SurfaceRoad[], cells: readonly LocalMapCell[]) => {
  const visible = new Map(cells.filter(cell => cell.passable).map(cell => [`${cell.x}:${cell.y}`, cell]));
  const result: SurfaceRoad[] = [];
  for (const road of roads) {
    let points: { x: number; y: number }[] = [], fragment = 0;
    const flush = () => { if (points.length > 1) result.push({ ...road, id: `${road.id}:${fragment++}`, points }); points = []; };
    for (const point of road.points) { if (visible.get(`${point.x}:${point.y}`)?.regionId === road.regionId) points.push(point); else flush(); }
    flush();
  }
  return result.slice(0, 8);
};

export const fixedSurfaceRoads = (cells: readonly LocalMapCell[], areas: readonly SurfaceArea[], focuses: readonly SurfaceFocus[]) => {
  const environmentAreas: EnvironmentArea[] = areas.map(area => {
    const version = Number(area.generation_version ?? 1);
    if (version !== 1 && version !== 2) throw new Error('区域环境生成版本不受支持，请联系管理员。');
    return { regionId: Number(area.region_id), code: area.code, danger: Number(area.danger_level), enabled: Boolean(Number(area.is_enabled)), minX: Number(area.min_x), maxX: Number(area.max_x), minY: Number(area.min_y), maxY: Number(area.max_y), minZ: Number(area.min_z), maxZ: Number(area.max_z), generationVersion: version, generationSeed: area.generation_seed == null ? undefined : String(area.generation_seed) };
  });
  const pairs = new Map<string, [SurfaceFocus, SurfaceFocus]>();
  for (const from of focuses) {
    const to = focuses.filter(candidate => candidate.id !== from.id && candidate.regionId === from.regionId && candidate.z === from.z)
      .map(candidate => ({ point: candidate, distance: Math.abs(candidate.x - from.x) + Math.abs(candidate.y - from.y) }))
      .filter(candidate => candidate.distance >= 4 && candidate.distance <= 24).sort((a, b) => a.distance - b.distance || a.point.id.localeCompare(b.point.id))[0]?.point;
    if (to) pairs.set([from.id, to.id].sort().join(':'), from.id < to.id ? [from, to] : [to, from]);
  }
  const plans: { from: SurfaceFocus; to: SurfaceFocus; cells: LocalMapCell[] }[] = [];
  const regionCounts = new Map<number, number>();
  for (const [, [from, to]] of [...pairs].sort(([a], [b]) => a.localeCompare(b))) {
    const count = regionCounts.get(from.regionId) ?? 0;
    if (count >= 3) continue;
    regionCounts.set(from.regionId, count + 1);
    // 先固定每区域候选，再做视口裁切；拖动视口不会重新选择一组道路。
    if (!cells.some(cell => cell.regionId === from.regionId && cell.x >= Math.min(from.x, to.x) - 3 && cell.x <= Math.max(from.x, to.x) + 3 && cell.y >= Math.min(from.y, to.y) - 3 && cell.y <= Math.max(from.y, to.y) + 3)) continue;
    const candidates: LocalMapCell[] = [];
    for (let y = Math.min(from.y, to.y) - 3; y <= Math.max(from.y, to.y) + 3; y++) for (let x = Math.min(from.x, to.x) - 3; x <= Math.max(from.x, to.x) + 3; x++) {
      const area = areas.find(area => x >= Number(area.min_x) && x <= Number(area.max_x) && y >= Number(area.min_y) && y <= Number(area.max_y) && from.z >= Number(area.min_z) && from.z <= Number(area.max_z));
      if (area && Number(area.region_id) === from.regionId && surfaceRegionEnabled(area.code, area.is_owner_only, area.is_enabled)) candidates.push({ x, y, z: from.z, regionId: from.regionId, regionCode: area.code, passable: true });
    }
    plans.push({ from, to, cells: candidates });
  }
  if (!plans.length) return [];
  const candidates = [...new Map(plans.flatMap(plan => plan.cells).map(cell => [key(cell), cell])).values()];
  // 按区域持久 profile 的原始障碍规划；清理/抑制状态不改变中心线。未登记区域仍走 env1。
  const protections = new Map<number, { x: number; y: number; z: number; radius: number }[]>();
  for (const focus of focuses) { const points = protections.get(focus.regionId) ?? []; points.push({ x: focus.x, y: focus.y, z: focus.z, radius: 2 }); protections.set(focus.regionId, points); }
  const objects = generateEnvironmentForCells(environmentAreas, candidates);
  const blocked = new Set(objects.filter(object => object.blocking && !environmentObjectCells(object).some(cell => environmentProtectedCell(cell, protections.get(object.regionId) ?? []))).flatMap(environmentObjectCells).map(key));
  const roads: SurfaceRoad[] = [];
  for (const plan of plans) {
    const road = planSurfaceRoad(plan.from, plan.to, plan.cells.map(cell => ({ ...cell, passable: !blocked.has(key(cell)) })));
    if (road) roads.push(road);
  }
  return roads;
};

const settlementLayoutCache = new Map<string, SettlementLayout>();
/** Complete static settlement plans are chosen before any observation-window clipping. */
const applySettlementSurfaceLayout = (visible: readonly LocalMapCell[], areas: readonly SurfaceArea[], focuses: readonly SurfaceFocus[], blocked: ReadonlySet<string>, legacyRoads: SurfaceRoad[], legacyScenery: SurfaceScenery[]) => {
  const regionIds = new Map<number, string>();
  for (const cell of visible) if (cell.z === 0 && isSettlementRegion(cell.regionCode)
    && areas.some(area => Number(area.region_id) === cell.regionId && area.code === cell.regionCode && surfaceRegionEnabled(area.code, area.is_owner_only, area.is_enabled))) regionIds.set(Number(cell.regionId), cell.regionCode);
  if (!regionIds.size) return { roads: legacyRoads, scenery: legacyScenery };
  const ordered = [...areas].sort((a, b) => Number(b.danger_level) - Number(a.danger_level) || Number(a.region_id) - Number(b.region_id));
  const roads = legacyRoads.filter(road => !regionIds.has(road.regionId)), scenery = legacyScenery.filter(item => !regionIds.has(item.regionId));
  for (const [regionId, regionCode] of [...regionIds].sort(([a], [b]) => a - b)) {
    const origins = [...new Map(focuses.filter(focus => focus.regionId === regionId && focus.z === 0
      && [focus.x, focus.y].every(Number.isSafeInteger)).map(focus => [key(focus), { regionId, x: focus.x, y: focus.y, z: 0 }])).values()].sort((a, b) => a.y - b.y || a.x - b.x);
    const signature = JSON.stringify([regionId, regionCode, ordered, origins]);
    let layout = settlementLayoutCache.get(signature);
    if (!layout) {
      const bounds = ordered.filter(area => Number(area.region_id) === regionId && Number(area.min_z) <= 0 && Number(area.max_z) >= 0);
      if (!bounds.length) continue;
      const minX = Math.min(...bounds.map(area => Number(area.min_x))), maxX = Math.max(...bounds.map(area => Number(area.max_x)));
      const minY = Math.min(...bounds.map(area => Number(area.min_y))), maxY = Math.max(...bounds.map(area => Number(area.max_y)));
      if (![minX, maxX, minY, maxY].every(Number.isSafeInteger) || maxX < minX || maxY < minY || (maxX - minX + 1) * (maxY - minY + 1) > 16_384) continue;
      const complete: LocalMapCell[] = [];
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const owner = ordered.find(area => x >= Number(area.min_x) && x <= Number(area.max_x) && y >= Number(area.min_y) && y <= Number(area.max_y) && Number(area.min_z) <= 0 && Number(area.max_z) >= 0);
        if (owner && Number(owner.region_id) === regionId && owner.code === regionCode && surfaceRegionEnabled(owner.code, owner.is_owner_only, owner.is_enabled)) complete.push({ x, y, z: 0, regionId, regionCode, passable: true });
      }
      const environmentAreas: EnvironmentArea[] = ordered.map(area => {
        const version = Number(area.generation_version ?? 1);
        if (version !== 1 && version !== 2) throw new Error('区域环境生成版本不受支持，请联系管理员。');
        return { regionId: Number(area.region_id), code: area.code, danger: Number(area.danger_level), enabled: Boolean(Number(area.is_enabled)), minX: Number(area.min_x), maxX: Number(area.max_x), minY: Number(area.min_y), maxY: Number(area.max_y), minZ: Number(area.min_z), maxZ: Number(area.max_z), generationVersion: version, generationSeed: area.generation_seed == null ? undefined : String(area.generation_seed) };
      });
      const protections = origins.map(point => ({ ...point, radius: 2 }));
      // Match the existing road planner's original-profile obstacle exclusions.
      // Clearing or suppressing an obstacle never reroutes this cosmetic plan.
      const originalBlocked = new Set(generateEnvironmentForCells(environmentAreas, complete).filter(object => object.blocking
        && !environmentObjectCells(object).some(cell => environmentProtectedCell(cell, protections))).flatMap(environmentObjectCells).map(key));
      layout = planSettlementLayout({ regionId, regionCode, z: 0, cells: complete.map(cell => ({ ...cell, passable: !originalBlocked.has(key(cell)) })), focuses: origins });
      if (settlementLayoutCache.size >= 16) settlementLayoutCache.delete(settlementLayoutCache.keys().next().value!);
      settlementLayoutCache.set(signature, layout);
    }
    const clipped = clipSettlementLayout(layout, visible.map(cell => ({ ...cell, passable: cell.passable === true && !blocked.has(key(cell)) })));
    roads.push(...clipped.roads); scenery.push(...clipped.scenery);
  }
  return { roads, scenery };
};

/** 可选扩展，只读；权限、感知和现有障碍裁切已由 local-map 决定。 */
export const surfaceSceneFor = async (db: Db, origin: LocalMapPosition, cells: readonly LocalMapCell[], environment: readonly EnvironmentObjectView[]): Promise<MapSurfaceScene | undefined> => {
  const scopeToken = await resolveSurfaceScope(db, origin);
  if (!scopeToken) return undefined;
  const [areas] = await db.execute<(RowDataPacket & SurfaceArea)[]>(`SELECT a.*,r.code,r.is_owner_only,r.is_enabled,r.danger_level,COALESCE(p.generation_version,1) AS generation_version,p.generation_seed FROM map_region_areas a JOIN map_regions r ON r.id=a.region_id LEFT JOIN map_environment_region_profiles p ON p.region_id=r.id WHERE ? BETWEEN a.min_z AND a.max_z ORDER BY r.danger_level DESC,r.id`, [origin.z]);
  const publicRegions = new Set(areas.filter(area => surfaceRegionEnabled(area.code, area.is_owner_only, area.is_enabled)).map(area => Number(area.region_id)));
  const visible = cells.filter(cell => cell.regionId && cell.regionCode && cell.z === origin.z && publicRegions.has(Number(cell.regionId)));
  if (!visible.length) return undefined;
  const regionIds = [...new Set(visible.map(cell => Number(cell.regionId)))];
  const focuses: SurfaceFocus[] = [];
  for (const regionId of regionIds) {
    // 每区域独立预算，邻区进入感知时不挤掉当前区域原有地标。
    const [points] = await db.execute<RowDataPacket[]>(`SELECT CONCAT('npc:',id) AS id,region_id,pos_x AS x,pos_y AS y,pos_z AS z FROM map_npcs WHERE region_id=? AND pos_z=? AND pos_x IS NOT NULL AND pos_y IS NOT NULL
      UNION ALL SELECT CONCAT('site:',id),region_id,pos_x,pos_y,pos_z FROM map_special_objects WHERE region_id=? AND pos_z=? AND pos_x IS NOT NULL AND pos_y IS NOT NULL
      UNION ALL SELECT CONCAT('entrance:',dungeon_id,':',pos_x,':',pos_y),region_id,pos_x,pos_y,0 FROM dungeon_entrances WHERE region_id=? AND ?=0 ORDER BY id LIMIT 128`, [regionId, origin.z, regionId, origin.z, regionId, origin.z]);
    focuses.push(...points.filter(point => [point.x, point.y, point.z].every(value => value !== null && Number.isSafeInteger(Number(value)))).map(point => ({ id: String(point.id), regionId: Number(point.region_id), x: Number(point.x), y: Number(point.y), z: Number(point.z) })));
  }
  const fixedRoads = fixedSurfaceRoads(visible, areas, focuses), baseRoads = clipSurfaceRoads(fixedRoads, visible), blocked = new Set(environment.filter(object => object.blocking).flatMap(environmentObjectCells).map(key));
  const baseScenery = generateSurfaceScenery(visible, scopeToken, blocked, focuses, fixedRoads);
  const { roads, scenery } = applySettlementSurfaceLayout(visible, areas, focuses, blocked, baseRoads, baseScenery);
  const terrainFields = [...new Map(visible.map(cell => [Number(cell.regionId), { regionId: Number(cell.regionId), regionCode: String(cell.regionCode), seed: environmentHash(`surface1:${scopeToken}:${cell.regionCode}`) }])).values()];
  const serverNowMs = Date.now(), marks = await readSurfaceMarks(db, visible, scopeToken, serverNowMs);
  return { schemaVersion: 1, sceneryVersion: sceneryGeneratorVersion, scopeToken, snapshotId: `surface1:${environmentHash(JSON.stringify([scopeToken, origin, visible.map(cell => [key(cell), cell.regionId, cell.passable]), roads.map(road => [road.id, road.points]), scenery.map(item => item.id), marks.recentWalks.map(mark => mark.id), marks.combatMarks.map(mark => mark.id)]))}`, serverNowMs, terrainFields, scenery, roads, ...marks };
};
