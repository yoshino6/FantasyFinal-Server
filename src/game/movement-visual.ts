import { AsyncLocalStorage } from 'node:async_hooks';
import type { TravelPlan } from './connected-travel.service';
import { samePoint, type TravelPoint } from './travel-path';
import { buildTravelVisual, type TravelVisualPoint } from './travel-visual';

export type MovementVisual = {
  id: string; origin: TravelVisualPoint; target: TravelVisualPoint; totalDistance: number; movementSpeed?: number;
  waypoints: (TravelVisualPoint & { distance: number })[];
};
const capture = new AsyncLocalStorage<{ movementVisual?: MovementVisual }>();
export const captureMovementVisual = async <T>(work: () => Promise<T>) => {
  const context: { movementVisual?: MovementVisual } = {};
  const result = await capture.run(context, work);
  return { result, ...context };
};
/** Call after the movement transaction commits, within the current command only. */
export const recordMovementVisual = (movementVisual: MovementVisual) => {
  const context = capture.getStore();
  if (context) context.movementVisual = movementVisual;
};

export const buildMovementVisual = (plan: TravelPlan, actual: TravelPoint, id: string, regions: { id: number; code: string; name: string }[], movementSpeed?: number): MovementVisual | undefined => {
  if (!samePoint(plan.target, actual) || plan.legs.some(leg => leg.kind !== 'walk')) return undefined;
  const totalDistance = plan.legs.reduce((sum, leg) => sum + leg.distance, 0);
  if (totalDistance <= 0) return undefined;
  const visual = buildTravelVisual({ ...plan, legs: plan.legs.map(leg => ({ ...leg, seconds: leg.distance })) }, { id, serverNow: 0, startAt: 0, arrivalAt: totalDistance }, regions);
  if (!visual) return undefined;
  const waypoints: MovementVisual['waypoints'] = [];
  for (const segment of visual.segments) for (const { at: _at, ...point } of segment.waypoints) {
    if (!waypoints.length || !samePoint(waypoints.at(-1)!, point)) waypoints.push(point);
  }
  return { id, origin: visual.start, target: visual.target, totalDistance, waypoints, ...(Number.isFinite(movementSpeed) && Number(movementSpeed) > 0 ? { movementSpeed } : {}) };
};
