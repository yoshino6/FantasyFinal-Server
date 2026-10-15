import type { TravelPlan } from './connected-travel.service';
import { samePoint, type TravelPoint } from './travel-path';

export type TravelVisualPoint = TravelPoint & { regionCode: string; regionName: string };
export type TravelVisualWaypoint = TravelVisualPoint & { distance: number; at: number };
export type TravelVisualSegment = {
  kind: 'walk' | 'portal' | 'guild'; instant: boolean;
  from: TravelVisualPoint; to: TravelVisualPoint; distance: number;
  startAt: number; arrivalAt: number; waypoints: TravelVisualWaypoint[];
};
export type TravelVisual = {
  id: string; serverNow: number; startAt: number; arrivalAt: number;
  start: TravelVisualPoint; target: TravelVisualPoint; totalDistance: number;
  segments: TravelVisualSegment[];
};
type Region = { id: number; code: string; name: string };
type Timing = { id: string; serverNow: number; startAt: number; arrivalAt: number };
const validPoint = (point: TravelPoint | undefined): point is TravelPoint => Boolean(point
  && [point.x, point.y, point.z, point.regionId].every(Number.isSafeInteger) && point.regionId > 0);
const distance = (a: TravelPoint, b: TravelPoint) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Serialize saved authoritative route geometry; never invent missing old paths. */
export const buildTravelVisual = (plan: TravelPlan, timing: Timing, regions: readonly Region[]): TravelVisual | undefined => {
  if (!plan || !validPoint(plan.start) || !validPoint(plan.target) || !Array.isArray(plan.legs) || !plan.legs.length
    || !timing.id || ![timing.serverNow, timing.startAt, timing.arrivalAt].every(Number.isFinite) || timing.arrivalAt <= timing.startAt) return undefined;
  const lookup = new Map(regions.map(region => [Number(region.id), region]));
  const enrich = (point: TravelPoint): TravelVisualPoint | undefined => {
    const region = lookup.get(point.regionId);
    return region?.code && region.name ? { x: point.x, y: point.y, z: point.z, regionId: point.regionId, regionCode: region.code, regionName: region.name } : undefined;
  };
  const seconds = plan.legs.reduce((sum, leg) => sum + Number(leg?.seconds), 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const start = enrich(plan.start), target = enrich(plan.target);
  if (!start || !target) return undefined;
  const segments: TravelVisualSegment[] = [];
  let previous = plan.start, elapsed = 0, totalDistance = 0;
  for (const leg of plan.legs) {
    if (!leg || !validPoint(leg.from) || !validPoint(leg.to) || !samePoint(leg.from, previous)
      || !['walk', 'portal', 'guild'].includes(leg.kind) || !Number.isFinite(leg.distance) || leg.distance < 0
      || !Number.isFinite(leg.seconds) || Number(leg.seconds) < 0) return undefined;
    const from = enrich(leg.from), to = enrich(leg.to);
    if (!from || !to) return undefined;
    const startAt = timing.startAt + elapsed / seconds * (timing.arrivalAt - timing.startAt);
    elapsed += Number(leg.seconds);
    const arrivalAt = timing.startAt + elapsed / seconds * (timing.arrivalAt - timing.startAt);
    const instant = leg.kind !== 'walk';
    const raw = instant ? [leg.from, leg.to] : leg.waypoints;
    if (!Array.isArray(raw) || !raw.length || !raw.every(validPoint) || !samePoint(raw[0], leg.from) || !samePoint(raw.at(-1)!, leg.to)) return undefined;
    const waypoints: TravelVisualWaypoint[] = [];
    let walked = 0;
    for (let index = 0; index < raw.length; index++) {
      const point = raw[index], enriched = enrich(point);
      if (!enriched) return undefined;
      if (index > 0) {
        const before = raw[index - 1];
        if (!instant && (point.z !== before.z || (point.x !== before.x && point.y !== before.y))) return undefined;
        walked += instant ? leg.distance : distance(before, point);
      }
      waypoints.push({ ...enriched, distance: totalDistance + walked, at: index === raw.length - 1 ? arrivalAt : startAt + (leg.distance ? walked / leg.distance : 0) * (arrivalAt - startAt) });
    }
    if (walked !== leg.distance) return undefined;
    segments.push({ kind: leg.kind, instant, from, to, distance: leg.distance, startAt, arrivalAt, waypoints });
    totalDistance += leg.distance;
    previous = leg.to;
  }
  if (!samePoint(previous, plan.target)) return undefined;
  return { ...timing, start, target, totalDistance, segments };
};

/** Server-clock observation follows completed whole cells only, never a future waypoint. */
export const travelObservationPoint = (visual: TravelVisual): TravelVisualPoint => {
  const now = Math.max(visual.startAt, Math.min(visual.arrivalAt, visual.serverNow));
  if (now >= visual.arrivalAt) return { ...visual.target };
  const segment = visual.segments.find(candidate => now < candidate.arrivalAt);
  if (!segment) return { ...visual.start };
  if (segment.instant || now <= segment.startAt) return { ...segment.from };
  for (let index = 1; index < segment.waypoints.length; index++) {
    const before = segment.waypoints[index - 1], after = segment.waypoints[index];
    if (now >= after.at) continue;
    const span = Math.abs(after.x - before.x) + Math.abs(after.y - before.y);
    const elapsed = Math.max(0, Math.min(1, (now - before.at) / Math.max(1, after.at - before.at)));
    const completed = Math.min(span, Math.floor(span * elapsed));
    return { x: before.x + Math.sign(after.x - before.x) * completed,
      y: before.y + Math.sign(after.y - before.y) * completed, z: before.z,
      regionId: before.regionId, regionCode: before.regionCode, regionName: before.regionName };
  }
  return { ...segment.to };
};
