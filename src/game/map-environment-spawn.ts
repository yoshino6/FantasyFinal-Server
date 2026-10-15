import type { Pool, PoolConnection } from 'mysql2/promise';
import { environmentForCells } from './map-environment.service';
import { environmentObjectCells } from './map-environment.config';

type SpawnPoint = { x: number; y: number; z: number };
const pointKey = (point: SpawnPoint) => `${point.x},${point.y},${point.z}`;

/** 每批候选点共用环境查询；刷新怪物与矿物只避让，不清除环境物件。 */
export const createEnvironmentSpawnPicker = (db: Pool | PoolConnection, regionId: number, nextPoint: () => SpawnPoint) => {
  let pending: { point: SpawnPoint; obstructed: boolean }[] = [];
  return async (forbidden: (point: SpawnPoint) => boolean): Promise<SpawnPoint | null> => {
    for (let attempt = 0; attempt < 64; attempt++) {
      if (!pending.length) {
        const points = Array.from({ length: 16 }, () => nextPoint());
        const objects = await environmentForCells(db, points.map(point => ({ ...point, regionId })));
        const occupied = new Set(objects.filter(object => object.blocking).flatMap(environmentObjectCells).map(pointKey));
        pending = points.map(point => ({ point, obstructed: occupied.has(pointKey(point)) }));
      }
      const candidate = pending.shift()!;
      if (!candidate.obstructed && !forbidden(candidate.point)) return candidate.point;
    }
    return null;
  };
};
