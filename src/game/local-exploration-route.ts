export type LocalMapPosition = { x: number; y: number; z: number; regionId: number };
export type LocalMapCell = { x: number; y: number; z: number; regionId?: number; regionCode?: string; passable: boolean };
export type ReachableLocalMapCell = LocalMapCell & { reachable: boolean };

export class LocalExplorationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'LocalExplorationError';
  }
}

export const localPositionKey = (point: { x: number; y: number; z: number }) => `${point.x}:${point.y}:${point.z}`;
export const localDistance = (from: { x: number; y: number }, to: { x: number; y: number }) => Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
export const isLocalPosition = (point: unknown, requireRegion = false): point is LocalMapPosition => {
  if (!point || typeof point !== 'object') return false;
  const value = point as Partial<LocalMapPosition>;
  return [value.x, value.y, value.z].every(Number.isSafeInteger)
    && (!requireRegion || (Number.isSafeInteger(value.regionId) && Number(value.regionId) > 0));
};

/** One bounded traversal serves both reachability and shortest route planning. */
const localWalkTree = (origin: LocalMapPosition, cells: readonly LocalMapCell[], budget: number, radius = budget) => {
  const allowed = new Map(cells.filter(cell => cell.passable && cell.z === origin.z && localDistance(origin, cell) <= radius).map(cell => [localPositionKey(cell), cell]));
  const start = localPositionKey(origin);
  const queue = [{ ...origin, depth: 0 }], previous = new Map<string, string>();
  const visited = new Set([start]);
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (current.depth >= budget) continue;
    // The game world uses cardinal movement, with positive Y pointing north.
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const key = localPositionKey({ x: current.x + dx, y: current.y + dy, z: origin.z });
      if (visited.has(key) || !allowed.has(key)) continue;
      visited.add(key); previous.set(key, localPositionKey(current));
      const cell = allowed.get(key)!;
      queue.push({ ...cell, regionId: Number(cell.regionId), depth: current.depth + 1 });
    }
  }
  return { allowed, visited, previous, start };
};

/** Mark the supplied perceived cells in one BFS, retaining real passability. */
export const localReachableCells = (origin: LocalMapPosition, cells: readonly LocalMapCell[], moveRange: number, actionRange: number, pathBudget?: number): ReachableLocalMapCell[] => {
  const budget = Math.max(0, Math.floor(Math.min(moveRange, actionRange)));
  const steps = pathBudget === undefined ? budget : Math.max(0, Math.min(cells.length - 1, Math.floor(pathBudget)));
  const { visited } = localWalkTree(origin, cells, steps, budget);
  return cells.map(cell => ({ ...cell, reachable: visited.has(localPositionKey(cell)) }));
};

/** A longer simple route never expands its initial authorised spatial radius. */
export const localShortestPath = (origin: LocalMapPosition, target: { x: number; y: number; z: number }, cells: readonly LocalMapCell[], moveRange: number, actionRange: number, knownTargets: readonly { x: number; y: number; z?: number; regionId?: number }[] = [], pathBudget?: number): LocalMapCell[] => {
  if (!isLocalPosition(target)) throw new LocalExplorationError('INVALID_POSITION', '目标坐标必须是三个安全整数（x、y、z）。');
  if (target.z !== origin.z) throw new LocalExplorationError('WRONG_LAYER', '探索方格只能移动当前楼层。');
  const budget = Math.max(0, Math.floor(Math.min(moveRange, actionRange)));
  const steps = pathBudget === undefined ? budget : Math.max(0, Math.min(cells.length - 1, Math.floor(pathBudget)));
  if (localDistance(origin, target) > budget) throw new LocalExplorationError('OUT_OF_RANGE', `目标超出当前可移动范围（${budget} 格）。`);
  if (localDistance(origin, target) === 0) return [];
  const destination = localPositionKey(target);
  const startKey = localPositionKey(origin);
  const authorised = new Map(cells.map(cell => [localPositionKey(cell), cell]));
  const avoid = new Set(knownTargets.filter(point => [point.x, point.y, point.z ?? origin.z].every(Number.isSafeInteger)
    && (point.z ?? origin.z) === origin.z && authorised.has(localPositionKey({ ...point, z: origin.z }))
    && (point.regionId === undefined || point.regionId === authorised.get(localPositionKey({ ...point, z: origin.z }))!.regionId))
    .map(point => localPositionKey({ ...point, z: origin.z })).filter(key => key !== startKey && key !== destination));
  const preferred = avoid.size ? localWalkTree(origin, cells.filter(cell => !avoid.has(localPositionKey(cell))), steps, budget) : undefined;
  const { allowed, visited, previous, start } = preferred?.visited.has(destination) ? preferred : localWalkTree(origin, cells, steps, budget);
  if (!allowed.has(destination)) throw new LocalExplorationError('BLOCKED_TARGET', '目标位置当前无法通行。');
  if (!visited.has(destination)) throw new LocalExplorationError('NO_LOCAL_ROUTE', '当前移动范围内没有可通行的路线。');
  const path: LocalMapCell[] = [];
  for (let cursor = destination; cursor !== start; cursor = previous.get(cursor)!) path.unshift(allowed.get(cursor)!);
  return path;
};

/** Called only after a locking read, before any movement side effect. */
export const assertExpectedLocalStep = (actual: LocalMapPosition, target: { x: number; y: number; z: number }, expected: LocalMapPosition) => {
  if (!isLocalPosition(expected, true) || !isLocalPosition(target)) throw new LocalExplorationError('INVALID_POSITION', '移动坐标或起点凭据无效。');
  if (actual.x !== expected.x || actual.y !== expected.y || actual.z !== expected.z || actual.regionId !== expected.regionId) {
    throw new LocalExplorationError('STALE_POSITION', '角色位置已变化，请刷新探索地图后重新前往。', 409);
  }
  if (target.z !== actual.z || localDistance(actual, target) !== 1) throw new LocalExplorationError('INVALID_STEP', '路线移动每次只能前往相邻的上下左右一格。');
};
