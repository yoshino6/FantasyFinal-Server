import type { MappedTravelArea } from './mapped-travel-route';
import { connectedTravelPath, samePoint, type TravelBlockedCell, type TravelLeg, type TravelLink, type TravelPoint } from './travel-path';

export type TravelEnvironmentObject = { x: number; y: number; z: number; blocking: boolean; footprint: readonly { dx: number; dy: number }[]; name?: string };
export type TravelEnvironmentLookup = (cells: readonly TravelBlockedCell[]) => Promise<readonly TravelEnvironmentObject[]>;
const key = (cell: TravelBlockedCell) => `${cell.x}:${cell.y}:${cell.z}`;
const objectCells = (object: TravelEnvironmentObject): TravelBlockedCell[] => object.footprint.map(cell => ({ x: object.x + cell.dx, y: object.y + cell.dy, z: object.z }));

/** 展开实际保存的四向步行线；传送与接驳只验端点，不把换层连成穿墙直线。 */
export const travelWalkingCells = (legs: readonly TravelLeg[]): TravelBlockedCell[] => {
  const cells = new Map<string, TravelBlockedCell>();
  for (const leg of legs) {
    if (leg.kind !== 'walk') {
      for (const point of [leg.from, leg.to]) {
        if (![point.x, point.y, point.z].every(Number.isSafeInteger)) throw Error('换乘坐标无效，请重新发送前往。');
        cells.set(key(point), { x: point.x, y: point.y, z: point.z });
      }
      continue;
    }
    const points = leg.waypoints;
    if (!points?.length || !samePoint(points[0], leg.from) || !samePoint(points.at(-1)!, leg.to)) throw Error('步行路线缺少完整坐标，请重新发送前往。');
    let walked = 0;
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      if (![point.x, point.y, point.z].every(Number.isSafeInteger)) throw Error('步行路线坐标无效，请重新发送前往。');
      cells.set(key(point), { x: point.x, y: point.y, z: point.z });
      if (!index) continue;
      const before = points[index - 1];
      if (point.z !== before.z || point.x !== before.x && point.y !== before.y) throw Error('步行路线已改变，请重新发送前往。');
      const length = Math.abs(point.x - before.x) + Math.abs(point.y - before.y);
      if (length > 100_000 || cells.size + length > 100_000) throw Error('步行路线过长，请分段前往。');
      walked += length;
      for (let step = 1; step < length; step++) {
        const cell = { x: before.x + Math.sign(point.x - before.x) * step, y: before.y + Math.sign(point.y - before.y) * step, z: point.z };
        cells.set(key(cell), cell);
      }
    }
    if (walked !== leg.distance) throw Error('步行路线距离已改变，请重新发送前往。');
  }
  return [...cells.values()];
};

const queryObjects = async (cells: readonly TravelBlockedCell[], lookup: TravelEnvironmentLookup) => {
  const objects: TravelEnvironmentObject[] = [];
  // 数据库连接串行分批，限制 SQL 参数量及单次生成范围。
  for (let offset = 0; offset < cells.length; offset += 1000) objects.push(...await lookup(cells.slice(offset, offset + 1000)));
  return objects;
};

/** 只查询候选线上尚未检查的格子；发现完整占地后插入压缩图，反复绕行直到全线通过校验。 */
export const environmentTravelPath = async (
  areas: MappedTravelArea[], maps: ReadonlySet<number>, start: TravelPoint, target: TravelPoint,
  links: TravelLink[], lookup: TravelEnvironmentLookup, knownTargets: readonly TravelBlockedCell[] = []
): Promise<TravelLeg[] | null> => {
  const checked = new Set<string>(), blocked = new Map<string, TravelBlockedCell>();
  for (let attempt = 0; attempt < 64; attempt++) {
    const legs = connectedTravelPath(areas, maps, start, target, links, [...blocked.values()], knownTargets);
    if (!legs) return null;
    const unseen = travelWalkingCells(legs).filter(cell => !checked.has(key(cell)));
    if (!unseen.length) return legs;
    const objects = await queryObjects(unseen, lookup);
    for (const cell of unseen) checked.add(key(cell));
    let changed = false;
    for (const object of objects) {
      if (!object.blocking) continue;
      for (const cell of objectCells(object)) {
        if (![cell.x, cell.y, cell.z].every(Number.isSafeInteger)) throw Error('障碍物占地坐标无效。');
        if (!blocked.has(key(cell))) { blocked.set(key(cell), cell); changed = true; }
      }
    }
    if (!changed) return legs;
  }
  throw Error('沿途障碍较多，暂时无法规划完整路线，请分段前往。');
};

/** 已保存旅行抵达前重验每一个经过格，旧记录和动态障碍均不能通过只验终点绕过。 */
export const assertTravelEnvironmentClear = async (legs: readonly TravelLeg[], lookup: TravelEnvironmentLookup) => {
  const cells = travelWalkingCells(legs), route = new Set(cells.map(key));
  const obstacle = (await queryObjects(cells, lookup)).find(object => object.blocking && objectCells(object).some(cell => route.has(key(cell))));
  if (obstacle) throw Error(`原路线被${obstacle.name ?? '障碍物'}阻挡，请取消前往并重新规划路线。`);
};
