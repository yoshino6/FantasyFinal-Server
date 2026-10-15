// Pure shared geometry: this module deliberately has no server or Node imports.
export type SettlementCell = { x: number; y: number; z: number; regionId?: number; regionCode?: string; passable: boolean };
export type SettlementFocus = { x: number; y: number; z: number; regionId: number; id?: unknown };
export type SettlementRoad = { id: string; regionId: number; points: { x: number; y: number }[]; width: number };
export type SettlementScenery = { id: string; regionId: number; assetKey: string; x: number; y: number; z: number; scale: number; rotation: number; flip: boolean };
export type SettlementLayout = { roads: SettlementRoad[]; scenery: SettlementScenery[] };
export type SettlementSpriteBounds = { left: number; top: number; width: number; height: number; anchorX: number; anchorY: number; extent?: number };
export type SettlementSpriteMap = Partial<Record<'settlement_0' | 'settlement_1' | 'settlement_2' | 'settlement_3' | 'settlement_4', SettlementSpriteBounds>>;
export type SettlementExclusion = ({ x: number; y: number } | { left: number; right: number; south: number; north: number }) & { regionId?: number; z?: number };
export type SettlementLayoutInput = { regionId: number; regionCode: string; z: number; cells: readonly SettlementCell[]; focuses: readonly SettlementFocus[]; spriteBounds?: SettlementSpriteMap };
export type SettlementRoadsideInput = Omit<SettlementLayoutInput, 'focuses'> & { roads: readonly SettlementRoad[]; focuses?: readonly SettlementFocus[]; exclusions?: readonly SettlementExclusion[] };
type Point = { x: number; y: number };
type Scope = { regionId: number; regionCode: string; z: number };
type Graph = { points: Point[]; indices: Map<string, number>; neighbours: Int32Array };
type Edge = { from: number; to: number; length: number; turns: number };
const maximumCells = 16_384, maximumFocuses = 128, infinity = 0x3fffffff;
const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;
const pointKey = (point: Point) => `${point.x}:${point.y}`;
const cellKey = (point: Point & { z: number }) => `${point.x}:${point.y}:${point.z}`;
const comparePoints = (a: Point, b: Point) => a.x - b.x || a.y - b.y;
const coordinate = (value: unknown): value is number => Number.isSafeInteger(value) && Math.abs(Number(value)) <= Number.MAX_SAFE_INTEGER - 4;
const emptyLayout = (): SettlementLayout => ({ roads: [], scenery: [] });

export const isSettlementRegion = (code: unknown): code is 'baina_town' | 'world_tree' => code === 'baina_town' || code === 'world_tree';

/** Conflicting identities and blocked duplicates deny a coordinate regardless of input order. */
const authorisedCells = (cells: readonly SettlementCell[]) => {
  const allowed = new Map<string, SettlementCell>(), denied = new Set<string>();
  for (const cell of cells) {
    if (!cell || !coordinate(cell.x) || !coordinate(cell.y) || !Number.isSafeInteger(cell.z)) continue;
    const identity = cellKey(cell), previous = allowed.get(identity);
    if (cell.passable !== true || !Number.isSafeInteger(cell.regionId) || Number(cell.regionId) <= 0
      || typeof cell.regionCode !== 'string' || !cell.regionCode || previous && (previous.regionId !== cell.regionId || previous.regionCode !== cell.regionCode)) {
      denied.add(identity); allowed.delete(identity); continue;
    }
    if (!denied.has(identity)) allowed.set(identity, { x: cell.x, y: cell.y, z: cell.z, regionId: cell.regionId, regionCode: cell.regionCode, passable: true });
  }
  return allowed;
};

const createGraph = (cells: readonly SettlementCell[], scope: Scope): Graph => {
  const points = [...authorisedCells(cells).values()].filter(cell => cell.regionId === scope.regionId && cell.regionCode === scope.regionCode && cell.z === scope.z)
    .map(cell => ({ x: cell.x, y: cell.y })).sort(comparePoints);
  const indices = new Map(points.map((point, index) => [pointKey(point), index]));
  const neighbours = new Int32Array(points.length * 4).fill(-1);
  points.forEach((point, index) => directions.forEach(([dx, dy], direction) => {
    neighbours[index * 4 + direction] = indices.get(`${point.x + dx}:${point.y + dy}`) ?? -1;
  }));
  return { points, indices, neighbours };
};

/** BFS first minimises whole-cell path length; direction DP then minimises turns among those shortest paths. */
const shortestPaths = (graph: Graph, start: number, withParents = false) => {
  const distances = new Int32Array(graph.points.length).fill(-1), queue = new Int32Array(graph.points.length);
  const turns = new Int32Array(graph.points.length * 4).fill(infinity);
  const parents = withParents ? new Uint8Array(graph.points.length * 4) : undefined;
  let count = 1; queue[0] = start; distances[start] = 0;
  for (let head = 0; head < count; head++) {
    const current = queue[head];
    for (let direction = 0; direction < 4; direction++) {
      const next = graph.neighbours[current * 4 + direction];
      if (next < 0 || distances[next] >= 0) continue;
      distances[next] = distances[current] + 1; queue[count++] = next;
    }
  }
  for (let head = 0; head < count; head++) {
    const current = queue[head];
    for (let direction = 0; direction < 4; direction++) {
      const next = graph.neighbours[current * 4 + direction];
      if (next < 0 || distances[next] !== distances[current] + 1) continue;
      let best = current === start ? 0 : infinity, previousDirection = 0;
      if (current !== start) for (let before = 0; before < 4; before++) {
        const cost = turns[current * 4 + before] + Number(before !== direction);
        if (cost < best) { best = cost; previousDirection = before; }
      }
      turns[next * 4 + direction] = best;
      if (parents) parents[next * 4 + direction] = previousDirection;
    }
  }
  return { distances, turns, parents };
};

const arrivalDirection = (turns: Int32Array, index: number) => {
  let best = 0;
  for (let direction = 1; direction < 4; direction++) if (turns[index * 4 + direction] < turns[index * 4 + best]) best = direction;
  return best;
};

const pathBetween = (graph: Graph, start: number, end: number) => {
  const paths = shortestPaths(graph, start, true), points: Point[] = [];
  let cursor = end, direction = arrivalDirection(paths.turns, end);
  while (cursor !== start) {
    points.push({ ...graph.points[cursor] });
    const previous = graph.neighbours[cursor * 4 + (direction + 2) % 4];
    direction = paths.parents![cursor * 4 + direction]; cursor = previous;
  }
  points.push({ ...graph.points[start] }); return points.reverse();
};

const fnvHash = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const settlementScales = [.95, .72, .95, .8, .9] as const;
const defaultSpriteBounds: SettlementSpriteBounds = { left: 0, top: 0, width: 1, height: 1, anchorX: .5, anchorY: .9 };
// Frozen measurements of the authored settlement atlas; no Web/server runtime import.
export const SETTLEMENT_SPRITE_BOUNDS: SettlementSpriteMap = {
  settlement_0: { left: .36328125, top: .05859375, width: .30078125, height: .86328125, extent: .86328125, anchorX: .5, anchorY: .886875 },
  settlement_1: { left: .12109375, top: .21875, width: .7578125, height: .48828125, extent: .7578125, anchorX: .5, anchorY: .67203125 },
  settlement_2: { left: .09375, top: .265625, width: .8125, height: .453125, extent: .8125, anchorX: .5, anchorY: .68375 },
  settlement_3: { left: .19921875, top: .0546875, width: .65625, height: .87890625, extent: .87890625, anchorX: .5, anchorY: .89859375 },
  settlement_4: { left: .05078125, top: .046875, width: .89453125, height: .8984375, extent: .8984375, anchorX: .5, anchorY: .9103125 }
};
const validSpriteBounds = (bounds: SettlementSpriteBounds) => bounds && [bounds.left, bounds.top, bounds.width, bounds.height, bounds.anchorX, bounds.anchorY].every(Number.isFinite)
  && bounds.left >= 0 && bounds.top >= 0 && bounds.width > 0 && bounds.height > 0 && bounds.left + bounds.width <= 1.000001 && bounds.top + bounds.height <= 1.000001
  && bounds.anchorX >= 0 && bounds.anchorX <= 1 && bounds.anchorY >= 0 && bounds.anchorY <= 1.01;
const sceneryEnvelope = (scenery: Pick<SettlementScenery, 'assetKey' | 'x' | 'y' | 'scale'>, spriteBounds?: SettlementSpriteMap) => {
  const bounds = spriteBounds?.[scenery.assetKey as keyof SettlementSpriteMap] ?? SETTLEMENT_SPRITE_BOUNDS[scenery.assetKey as keyof SettlementSpriteMap] ?? defaultSpriteBounds;
  if (!validSpriteBounds(bounds) || !Number.isFinite(scenery.scale) || scenery.scale <= 0 || scenery.scale > 1) return undefined;
  // Same drawImage transform as Web: north is positive world Y, above the painted anchor.
  return { left: scenery.x + (bounds.left - bounds.anchorX) * scenery.scale, right: scenery.x + (bounds.left + bounds.width - bounds.anchorX) * scenery.scale,
    south: scenery.y + (bounds.anchorY - bounds.top - bounds.height) * scenery.scale, north: scenery.y + (bounds.anchorY - bounds.top) * scenery.scale };
};
const envelopeCells = (bounds: { left: number; right: number; south: number; north: number }) => {
  const left = Math.floor(bounds.left + .5 + 1e-8), right = Math.ceil(bounds.right + .5 - 1e-8) - 1;
  const south = Math.floor(bounds.south + .5 + 1e-8), north = Math.ceil(bounds.north + .5 - 1e-8) - 1;
  if (![left, right, south, north].every(coordinate) || (right - left + 1) * (north - south + 1) > maximumCells) return undefined;
  const points: Point[] = [];
  for (let y = south; y <= north; y++) for (let x = left; x <= right; x++) points.push({ x, y });
  return points;
};

/** Reserve the anchor and every cell touched by the complete measured alpha envelope. */
export const settlementSceneryFootprint = (scenery: Pick<SettlementScenery, 'assetKey' | 'x' | 'y' | 'z' | 'regionId' | 'scale'>, spriteBounds?: SettlementSpriteMap) => {
  const envelope = sceneryEnvelope(scenery, spriteBounds), points = envelope && envelopeCells(envelope);
  if (!points) return [];
  if (!points.some(point => point.x === scenery.x && point.y === scenery.y)) points.push({ x: scenery.x, y: scenery.y });
  return points.map(point => ({ ...point, z: scenery.z, regionId: scenery.regionId }));
};

const generateDecorations = (graph: Graph, roads: readonly SettlementRoad[], focuses: readonly Point[], scope: Scope,
  exclusions: readonly SettlementExclusion[], spriteBounds?: SettlementSpriteMap): SettlementScenery[] => {
  const roadCells = new Set(roads.flatMap(road => road.points.map(pointKey))), clear = new Set<string>();
  const protect = (point: Point) => {
    // Reserve every cell intersecting the circular buffer, including diagonal alpha tails.
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (Math.hypot(Math.max(Math.abs(dx) - .5, 0), Math.max(Math.abs(dy) - .5, 0)) <= 2) clear.add(`${point.x + dx}:${point.y + dy}`);
    }
  };
  focuses.forEach(protect);
  let exclusionCells = 0;
  for (const exclusion of exclusions) {
    if (!exclusion || exclusion.regionId !== undefined && exclusion.regionId !== scope.regionId || exclusion.z !== undefined && exclusion.z !== scope.z) continue;
    if ('x' in exclusion) {
      if (!coordinate(exclusion.x) || !coordinate(exclusion.y)) return [];
      clear.add(pointKey(exclusion)); continue;
    }
    if (![exclusion.left, exclusion.right, exclusion.south, exclusion.north].every(Number.isFinite)
      || exclusion.left >= exclusion.right || exclusion.south >= exclusion.north) return [];
    const points = envelopeCells(exclusion);
    if (!points || (exclusionCells += points.length) > maximumCells * 16) return [];
    points.forEach(point => clear.add(pointKey(point)));
  }
  const straight: { point: Point; horizontal: boolean }[] = [];
  for (const identity of roadCells) {
    const point = graph.points[graph.indices.get(identity)!];
    const adjacent = directions.map(([dx, dy]) => roadCells.has(`${point.x + dx}:${point.y + dy}`));
    const count = adjacent.filter(Boolean).length;
    if (count === 2 && (adjacent[0] && adjacent[2] || adjacent[1] && adjacent[3])) straight.push({ point, horizontal: adjacent[0] });
    else protect(point); // Junctions, corners and road ends keep a two-cell entrance buffer.
  }
  type Candidate = { item: SettlementScenery; bucket: string; phase: number; offset: number };
  const makeCandidate = (point: Point, horizontal: boolean, side: number, offset: number, asset: number): Candidate => {
    const along = horizontal ? point.x : point.y, bucket = Math.floor(along / 6);
    const x = point.x + (horizontal ? 0 : side * offset), y = point.y + (horizontal ? side * offset : 0);
    return { bucket: `${horizontal ? 'h' : 'v'}:${horizontal ? point.y : point.x}:${side}:${bucket}`, phase: along - bucket * 6, offset,
      item: { id: `settlement-scenery1:${scope.regionCode}:${scope.regionId}:${scope.z}:${asset}:${x}:${y}`, regionId: scope.regionId,
        assetKey: `settlement_${asset}`, x, y, z: scope.z, scale: settlementScales[asset], rotation: 0, flip: false } };
  };
  const candidates: Candidate[] = [];
  for (const { point, horizontal } of straight.sort((a, b) => comparePoints(a.point, b.point))) {
    const along = horizontal ? point.x : point.y, rhythm = (along % 18 + 18) % 18;
    if (rhythm !== 0 && rhythm !== 6 && rhythm !== 12) continue;
    const asset = rhythm === 12 ? 2 : rhythm === 0 ? scope.regionCode === 'world_tree' ? 3 : 0 : scope.regionCode === 'world_tree' ? 4 : 1;
    for (const side of [-1, 1]) {
      // Fixed world-coordinate rhythm is independent of road traversal direction and viewport.
      candidates.push(makeCandidate(point, horizontal, side, 2, asset));
    }
  }
  const occupied = new Set<string>(), occupiedBuckets = new Set<string>(), result: SettlementScenery[] = [];
  const place = (candidate: Candidate) => {
    const footprint = settlementSceneryFootprint(candidate.item, spriteBounds).map(pointKey);
    if (!footprint.length || footprint.some(identity => !graph.indices.has(identity) || roadCells.has(identity) || clear.has(identity) || occupied.has(identity))) return false;
    footprint.forEach(identity => occupied.add(identity)); occupiedBuckets.add(candidate.bucket); result.push(candidate.item); return true;
  };
  for (const candidate of candidates.sort((a, b) => comparePoints(a.item, b.item) || a.item.assetKey.localeCompare(b.item.assetKey))) place(candidate);
  if (scope.regionCode === 'world_tree' && result.length < 4 && [2, 3, 4].some(asset => !result.some(item => item.assetKey === `settlement_${asset}`))) {
    // The compact world's many entrances may suppress every standard beat. Try other
    // fixed phases of the same six-cell world buckets and wider authorised verges;
    // keep the original radius-two buffers, centreline and full alpha checks intact.
    const sparse: Candidate[] = [];
    for (const { point, horizontal } of straight) {
      const along = horizontal ? point.x : point.y, bucket = Math.floor(along / 6), asset = [3, 4, 2][(bucket % 3 + 3) % 3];
      for (const offset of [2, 3, 4]) for (const side of [-1, 1]) sparse.push(makeCandidate(point, horizontal, side, offset, asset));
    }
    sparse.sort((a, b) => a.phase - b.phase || a.offset - b.offset || comparePoints(a.item, b.item) || a.item.assetKey.localeCompare(b.item.assetKey));
    for (const candidate of sparse) {
      if (result.some(item => item.assetKey === candidate.item.assetKey)) continue;
      if (occupiedBuckets.has(candidate.bucket) || result.some(item => Math.hypot(item.x - candidate.item.x, item.y - candidate.item.y) < 4)) continue;
      place(candidate);
    }
  }
  return result;
};

/** Legacy-client decoration fallback: use only supplied authorised roads; never infer or create a road. */
export const planSettlementRoadside = (input: SettlementRoadsideInput): SettlementScenery[] => {
  if (!input || !isSettlementRegion(input.regionCode) || !Number.isSafeInteger(input.regionId) || input.regionId <= 0 || input.z !== 0
    || !Array.isArray(input.cells) || input.cells.length > maximumCells || !Array.isArray(input.roads) || input.roads.length > maximumCells
    || input.focuses !== undefined && (!Array.isArray(input.focuses) || input.focuses.length > maximumFocuses)
    || input.exclusions !== undefined && (!Array.isArray(input.exclusions) || input.exclusions.length > maximumCells)) return [];
  const graph = createGraph(input.cells, input), roads: SettlementRoad[] = [];
  let roadPointCount = 0;
  for (const road of input.roads) {
    if (!road || road.regionId !== input.regionId || !Array.isArray(road.points) || road.points.length < 2 || road.points.length > maximumCells) continue;
    if ((roadPointCount += road.points.length) > maximumCells * 16) return [];
    if (road.points.some((point: Point, index: number) => !point || !coordinate(point.x) || !coordinate(point.y) || !graph.indices.has(pointKey(point))
      || index > 0 && Math.abs(point.x - road.points[index - 1].x) + Math.abs(point.y - road.points[index - 1].y) !== 1)) continue;
    roads.push(road);
  }
  const entrances: Point[] = [];
  for (const focus of input.focuses ?? []) if (focus && coordinate(focus.x) && coordinate(focus.y) && focus.regionId === input.regionId && focus.z === input.z) entrances.push({ x: focus.x, y: focus.y });
  return generateDecorations(graph, roads, entrances, input, input.exclusions ?? [], input.spriteBounds);
};

/**
 * Plan once with the complete authorised, original passability geometry of a public settlement.
 * All reachable focus pairs compete by actual shortest path length, then by the fewest turns.
 * Kruskal produces a deterministic minimum spanning forest when obstacles divide the region;
 * blocked or absent focuses cannot be connected. IDs never read any focus identity.
 * No viewport, cleared-obstacle state or mutable entity data belongs in this input.
 */
export const planSettlementLayout = (input: SettlementLayoutInput): SettlementLayout => {
  if (!input || !isSettlementRegion(input.regionCode) || !Number.isSafeInteger(input.regionId) || input.regionId <= 0 || input.z !== 0
    || !Array.isArray(input.cells) || !Array.isArray(input.focuses) || input.cells.length > maximumCells || input.focuses.length > maximumFocuses) return emptyLayout();
  const graph = createGraph(input.cells, input);
  if (!graph.points.length) return emptyLayout();
  const entrances = new Map<string, Point>();
  for (const focus of input.focuses) if (focus && coordinate(focus.x) && coordinate(focus.y) && focus.z === input.z && focus.regionId === input.regionId) {
    const point = { x: focus.x, y: focus.y }; entrances.set(pointKey(point), point);
  }
  const focuses = [...entrances.values()].filter(point => graph.indices.has(pointKey(point))).sort(comparePoints);
  if (focuses.length < 2) return emptyLayout();
  const focusIndices = focuses.map(point => graph.indices.get(pointKey(point))!), edges: Edge[] = [];
  for (let from = 0; from < focuses.length - 1; from++) {
    const paths = shortestPaths(graph, focusIndices[from]);
    for (let to = from + 1; to < focuses.length; to++) {
      const index = focusIndices[to], length = paths.distances[index];
      if (length > 0) edges.push({ from, to, length, turns: paths.turns[index * 4 + arrivalDirection(paths.turns, index)] });
    }
  }
  edges.sort((a, b) => a.length - b.length || a.turns - b.turns || a.from - b.from || a.to - b.to);
  const components = focuses.map((_, index) => index), root = (index: number): number => {
    while (components[index] !== index) { components[index] = components[components[index]]; index = components[index]; } return index;
  };
  const roads: SettlementRoad[] = [];
  for (const edge of edges) {
    const from = root(edge.from), to = root(edge.to);
    if (from === to) continue;
    components[Math.max(from, to)] = Math.min(from, to);
    const points = pathBetween(graph, focusIndices[edge.from], focusIndices[edge.to]);
    const geometry = `${input.regionCode}:${input.regionId}:${input.z}:${points.map(pointKey).join(';')}`;
    roads.push({ id: `settlement-road1:${input.regionCode}:${input.regionId}:${input.z}:${fnvHash(geometry)}`, regionId: input.regionId, points, width: .72 });
  }
  return { roads, scenery: planSettlementRoadside({ ...input, roads }) };
};

const layoutScope = (id: string, kind: 'road' | 'scenery'): Scope | undefined => {
  if (typeof id !== 'string') return undefined;
  const match = new RegExp(`^settlement-${kind}1:(baina_town|world_tree):(\\d+):0:`).exec(id);
  const regionId = Number(match?.[2]);
  return match && Number.isSafeInteger(regionId) && regionId > 0 ? { regionId, regionCode: match[1], z: 0 } : undefined;
};

/** Clip only after full-region planning. Returned objects never alias the cached plan. */
export const clipSettlementLayout = (layout: { roads: readonly SettlementRoad[]; scenery: readonly SettlementScenery[] }, visibleCells: readonly SettlementCell[], spriteBounds?: SettlementSpriteMap): SettlementLayout => {
  if (!layout || !Array.isArray(layout.roads) || !Array.isArray(layout.scenery) || layout.roads.length > maximumCells
    || layout.scenery.length > maximumCells || !Array.isArray(visibleCells) || visibleCells.length > maximumCells) return emptyLayout();
  const visible = authorisedCells(visibleCells), result = emptyLayout();
  const known = (point: Point, scope: Scope) => {
    const cell = visible.get(cellKey({ ...point, z: scope.z }));
    return cell?.regionId === scope.regionId && cell?.regionCode === scope.regionCode;
  };
  let roadPointCount = 0;
  for (const road of layout.roads) {
    const scope = road && layoutScope(road.id, 'road');
    if (!scope || road.regionId !== scope.regionId || !Array.isArray(road.points) || road.points.length > maximumCells || road.width !== .72) continue;
    if ((roadPointCount += road.points.length) > maximumCells * 16) return emptyLayout();
    let start = -1;
    const flush = (end: number) => {
      if (start >= 0 && end > start) result.roads.push({ id: `${road.id}:cells:${start}-${end}`, regionId: road.regionId,
        points: road.points.slice(start, end + 1).map((point: Point) => ({ x: point.x, y: point.y })), width: road.width });
      start = -1;
    };
    for (let index = 0; index < road.points.length; index++) {
      const point = road.points[index];
      if (!point || !coordinate(point.x) || !coordinate(point.y) || !known(point, scope)) { flush(index - 1); continue; }
      if (start >= 0 && Math.abs(point.x - road.points[index - 1].x) + Math.abs(point.y - road.points[index - 1].y) !== 1) flush(index - 1);
      if (start < 0) start = index;
    }
    flush(road.points.length - 1);
  }
  for (const item of layout.scenery) {
    const scope = item && layoutScope(item.id, 'scenery');
    if (!scope || item.regionId !== scope.regionId || item.z !== scope.z || !coordinate(item.x) || !coordinate(item.y)
      || !/^settlement_[0-4]$/.test(item.assetKey) || item.rotation !== 0 || item.flip !== false || item.scale !== settlementScales[Number(item.assetKey.slice(-1))]) continue;
    const footprint = settlementSceneryFootprint(item, spriteBounds);
    if (footprint.length && footprint.every(point => known(point, scope))) result.scenery.push({ ...item });
  }
  return result;
};
