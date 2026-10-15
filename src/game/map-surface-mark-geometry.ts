import { environmentHash } from './map-environment.config';
import type { LocalMapCell } from './local-exploration-route';
import { surfaceRandomFraction as random } from './map-surface-seed';

export type SurfacePaintFragment = { points: { x: number; y: number }[]; opacity: number };
export const surfaceMarkRadius = 1.5;
type Point = { x: number; y: number };
const rounded = (value: number) => Math.round(value * 4096) / 4096;

/** 闭合的平滑手绘轮廓采样；不把方格或规则星形作为血渍主体。 */
const curvedOutline = (controls: readonly Point[], subdivisions: number): Point[] => {
  const points: Point[] = [];
  for (let index = 0; index < controls.length; index++) {
    const p0 = controls[(index - 1 + controls.length) % controls.length], p1 = controls[index], p2 = controls[(index + 1) % controls.length], p3 = controls[(index + 2) % controls.length];
    for (let part = 0; part < subdivisions; part++) {
      const t = part / subdivisions, t2 = t * t, t3 = t2 * t;
      const sample = (axis: 'x' | 'y') => .5 * ((2 * p1[axis]) + (-p0[axis] + p2[axis]) * t + (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * t2 + (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * t3);
      points.push({ x: sample('x'), y: sample('y') });
    }
  }
  return points;
};
const blob = (seed: string, x: number, y: number, radius: number, stretch: number, rotation: number, controls = 10): Point[] => curvedOutline(Array.from({ length: controls }, (_, index) => {
  const angle = index / controls * Math.PI * 2, extent = radius * (.73 + random(`${seed}:radius:${index}`) * .44);
  const dx = Math.cos(angle) * extent * stretch, dy = Math.sin(angle) * extent;
  return { x: x + dx * Math.cos(rotation) - dy * Math.sin(rotation), y: y + dx * Math.sin(rotation) + dy * Math.cos(rotation) };
}), 3);

const tau = Math.PI * 2;
const angularGap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const localPoint = (x: number, y: number, dx: number, dy: number, rotation: number): Point => ({ x: x + dx * Math.cos(rotation) - dy * Math.sin(rotation), y: y + dx * Math.sin(rotation) + dy * Math.cos(rotation) });
const cubic = (a: Point, b: Point, c: Point, d: Point, samples: number): Point[] => Array.from({ length: samples }, (_, index) => {
  const t = index / samples, s = 1 - t;
  return { x: s * s * s * a.x + 3 * s * s * t * b.x + 3 * s * t * t * c.x + t * t * t * d.x, y: s * s * s * a.y + 3 * s * s * t * b.y + 3 * s * t * t * c.y + t * t * t * d.y };
});

/** 外尖内圆、两侧不对称的有向泪滴；不能用拉长椭圆代替液体飞溅。 */
const tear = (seed: string, x: number, y: number, length: number, width: number, rotation: number): Point[] => {
  const left = width * (.85 + random(`${seed}:left`) * .35), right = width * (.7 + random(`${seed}:right`) * .45), bend = (random(`${seed}:bend`) - .5) * width * .6;
  const tip = { x: length * .65, y: bend }, bellyLeft = { x: -length * .08, y: -left }, base = { x: -length * .45, y: 0 }, bellyRight = { x: -length * .15, y: right };
  return [
    ...cubic(tip, { x: length * .25, y: -left * .12 }, { x: length * .04, y: -left * .9 }, bellyLeft, 6),
    ...cubic(bellyLeft, { x: -length * .35, y: -left * 1.1 }, { x: -length * .5, y: -left * .5 }, base, 6),
    ...cubic(base, { x: -length * .48, y: right * .65 }, { x: -length * .34, y: right * 1.05 }, bellyRight, 6),
    ...cubic(bellyRight, { x: length * .1, y: right * .9 }, { x: length * .39, y: right * .1 }, tip, 6)
  ].map(point => localPoint(x, y, point.x, point.y, rotation));
};

export const surfaceBloodShapeCounts = (seed: number) => ({ mainShapes: 1, sprayShapes: 2 + environmentHash(`surface-blood2:${seed}:sprays`) % 2, droplets: 12 + environmentHash(`surface-blood2:${seed}:drops`) % 7 });

const bloodPaint = (x: number, y: number, seed: number, strength: number): SurfacePaintFragment[] => {
  const key = `surface-blood2:${seed}`, direction = random(`${key}:direction`) * tau, radius = .21 + strength * .085;
  const cx = x + (random(`${key}:cx`) - .5) * .12, cy = y + (random(`${key}:cy`) - .5) * .12;
  // 随机宽叶和缺口叠到连续轮廓上；角度不等距，尖溅只占少数，避免齿轮/规则星形。
  const lobes = Array.from({ length: 5 + environmentHash(`${key}:lobes`) % 3 }, (_, index) => ({ angle: random(`${key}:lobe:${index}:angle`) * tau, width: .17 + random(`${key}:lobe:${index}:width`) * .35, height: .035 + random(`${key}:lobe:${index}:height`) * .09 }));
  const notches = Array.from({ length: 4 }, (_, index) => ({ angle: random(`${key}:notch:${index}:angle`) * tau, width: .11 + random(`${key}:notch:${index}:width`) * .11, depth: .08 + random(`${key}:notch:${index}:depth`) * .12 }));
  // 少量不等距细尖与较深缺口破开圆形积液，避免两瓣主体读成心形。
  // 保留独立喷滴的旧seed及数量，只改变服务器授权主体的视觉轮廓。
  const spikeAngles = [direction];
  for (let index = 1; index < 3 + environmentHash(`${key}:attached-spikes`) % 3; index++) {
    let angle = random(`${key}:attached:${index}`) * tau;
    for (let attempt = 0; attempt < 12 && spikeAngles.some(used => angularGap(angle, used) < .58); attempt++) angle = random(`${key}:attached:${index}:${attempt}`) * tau;
    if (spikeAngles.every(used => angularGap(angle, used) >= .58)) spikeAngles.push(angle);
  }
  const spikes = spikeAngles.map((angle, index) => ({ angle, width: .022 + random(`${key}:spike:${index}:width`) * .035, height: .18 + random(`${key}:spike:${index}:height`) * .24 }));
  const angles = [...Array.from({ length: 96 }, (_, index) => index / 96 * tau), ...lobes.map(lobe => lobe.angle), ...notches.map(notch => notch.angle), ...spikes.flatMap(spike => [spike.angle, (spike.angle - spike.width + tau) % tau, (spike.angle + spike.width) % tau])].sort((a, b) => a - b);
  const outline = angles.map(angle => {
    const local = angle - direction;
    let extent = radius / Math.sqrt(Math.cos(local) ** 2 / 1.12 ** 2 + Math.sin(local) ** 2);
    for (const lobe of lobes) extent += lobe.height * Math.exp(-.5 * (angularGap(angle, lobe.angle) / lobe.width) ** 2);
    for (const notch of notches) extent -= notch.depth * Math.exp(-.5 * (angularGap(angle, notch.angle) / notch.width) ** 2);
    for (const spike of spikes) { const gap = angularGap(angle, spike.angle); extent += .045 * Math.exp(-.5 * (gap / .2) ** 2) + spike.height * Math.exp(-gap / spike.width); }
    return { x: cx + Math.cos(angle) * Math.max(radius * .55, extent), y: cy + Math.sin(angle) * Math.max(radius * .55, extent) };
  });
  const result: SurfacePaintFragment[] = [{ points: outline, opacity: 1 }], counts = surfaceBloodShapeCounts(seed);
  const usedSprays: number[] = [];
  for (let index = 0; index < counts.sprayShapes; index++) {
    const sprayKey = `${key}:spray:${index}`;
    let angle = random(`${sprayKey}:angle`) * tau;
    for (let attempt = 0; attempt < 8 && usedSprays.some(used => angularGap(angle, used) < .65); attempt++) angle = random(`${sprayKey}:angle:${attempt}`) * tau;
    usedSprays.push(angle);
    const reach = .58 + random(`${sprayKey}:reach`) * .38;
    result.push({ points: tear(sprayKey, x + Math.cos(angle) * reach, y + Math.sin(angle) * reach, .19 + random(`${sprayKey}:length`) * .13, .035 + random(`${sprayKey}:width`) * .028, angle), opacity: .64 + random(`${sprayKey}:opacity`) * .22 });
  }
  const usedDrops: number[] = [];
  for (let index = 0; index < counts.droplets; index++) {
    const dropKey = `${key}:drop:${index}`, sizeClass = index % 5;
    let angle = random(`${dropKey}:angle`) * tau;
    for (let attempt = 0; attempt < 8 && usedDrops.some(used => angularGap(angle, used) < .13); attempt++) angle = random(`${dropKey}:angle:${attempt}`) * tau;
    usedDrops.push(angle);
    const reach = .55 + random(`${dropKey}:reach`) * .76, size = sizeClass === 0 ? .055 + random(`${dropKey}:size`) * .03 : sizeClass <= 2 ? .032 + random(`${dropKey}:size`) * .023 : .016 + random(`${dropKey}:size`) * .014;
    const px = x + Math.cos(angle) * reach, py = y + Math.sin(angle) * reach;
    const points = index % 3 === 0 ? tear(dropKey, px, py, size * (2.4 + random(`${dropKey}:length`) * 1.3), size * .75, angle) : blob(dropKey, px, py, size, 1 + random(`${dropKey}:stretch`) * .45, angle, 8);
    result.push({ points, opacity: (sizeClass === 0 ? .66 : sizeClass <= 2 ? .55 : .45) + random(`${dropKey}:opacity`) * .17 });
  }
  return result;
};

/** 世界几何始终由同一落点及seed生成；视口只裁剪，绝不重新随机或移位。 */
export const surfaceMarkPaint = (x: number, y: number, seed: number, kind: string, intensity: number): SurfacePaintFragment[] => {
  if (![x, y, seed, intensity].every(Number.isFinite)) return [];
  const base = `surface-splat1:${seed}:${kind}`, strength = Math.max(.1, Math.min(1, intensity));
  const result: SurfacePaintFragment[] = [];
  const angle = random(`${base}:angle`) * Math.PI * 2;
  if (kind === 'blood') result.push(...bloodPaint(x, y, seed, strength));
  else {
    if (kind !== 'debris') result.push({ points: blob(`${base}:body`, x + (random(`${base}:cx`) - .5) * .16, y + (random(`${base}:cy`) - .5) * .16, .27 + strength * .13, 1.1 + random(`${base}:stretch`) * .35, angle, 12), opacity: 1 });
    const sprays = kind === 'slime' ? 2 : 1;
    for (let index = 0; index < sprays; index++) {
      const key = `${base}:spray:${index}`, direction = random(`${key}:angle`) * Math.PI * 2, reach = .43 + random(`${key}:reach`) * .42;
      result.push({ points: blob(key, x + Math.cos(direction) * reach, y + Math.sin(direction) * reach, .065 + random(`${key}:width`) * .045, 2.1 + random(`${key}:length`) * 1.2, direction, 8), opacity: .58 + random(`${key}:opacity`) * .28 });
    }
    const drops = (kind === 'debris' ? 12 : 6) + environmentHash(`${base}:drops`) % 7;
    for (let index = 0; index < drops; index++) {
      const key = `${base}:drop:${index}`, direction = random(`${key}:angle`) * Math.PI * 2, reach = .46 + random(`${key}:reach`) * .85;
      result.push({ points: blob(key, x + Math.cos(direction) * reach, y + Math.sin(direction) * reach, .025 + random(`${key}:size`) * .04, 1 + random(`${key}:stretch`) * .7, direction, 8), opacity: .38 + random(`${key}:opacity`) * .36 });
    }
  }
  return result.map(fragment => ({ ...fragment, points: fragment.points.map(point => {
    const dx = point.x - x, dy = point.y - y, distance = Math.hypot(dx, dy), factor = distance > surfaceMarkRadius ? surfaceMarkRadius / distance : 1;
    return { x: rounded(x + dx * factor), y: rounded(y + dy * factor) };
  }) }));
};
const clipEdge = (polygon: readonly Point[], inside: (point: Point) => boolean, intersection: (a: Point, b: Point) => Point): Point[] => {
  const output: Point[] = [];
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[(index - 1 + polygon.length) % polygon.length], b = polygon[index], ia = inside(a), ib = inside(b);
    if (ia !== ib) output.push(intersection(a, b));
    if (ib) output.push(b);
  }
  return output;
};
export const clipSurfacePaintToCell = (points: readonly Point[], cell: Pick<LocalMapCell, 'x' | 'y'>): Point[] => {
  let polygon = [...points];
  for (const [axis, bound, greater] of [['x', cell.x - .5, true], ['x', cell.x + .5, false], ['y', cell.y - .5, true], ['y', cell.y + .5, false]] as const) {
    polygon = clipEdge(polygon, point => greater ? point[axis] >= bound : point[axis] <= bound, (a, b) => {
      const t = (bound - a[axis]) / (b[axis] - a[axis]);
      return { x: axis === 'x' ? bound : a.x + (b.x - a.x) * t, y: axis === 'y' ? bound : a.y + (b.y - a.y) * t };
    });
    if (polygon.length < 3) return [];
  }
  let area = 0;
  const origin = polygon[0];
  for (let index = 0; index < polygon.length; index++) { const point = polygon[index], next = polygon[(index + 1) % polygon.length]; area += (point.x - origin.x) * (next.y - origin.y) - (next.x - origin.x) * (point.y - origin.y); }
  return Math.abs(area) < .00001 ? [] : polygon.map(point => ({ x: rounded(point.x), y: rounded(point.y) }));
};

/** 仅发已授权同区域的可见绘画碎片；隐藏原点与包围盒不会进入传输。 */
export const visibleSurfacePaint = (paint: readonly SurfacePaintFragment[], cells: readonly LocalMapCell[], origin: { x: number; y: number; z: number; regionId: number }): SurfacePaintFragment[] => {
  const visible = cells.filter(cell => cell.passable && cell.z === origin.z && cell.regionId === origin.regionId && cell.regionCode && Math.abs(cell.x - origin.x) <= surfaceMarkRadius + .5 && Math.abs(cell.y - origin.y) <= surfaceMarkRadius + .5).sort((a, b) => a.y - b.y || a.x - b.x);
  const result: SurfacePaintFragment[] = [];
  for (const fragment of paint) for (const cell of visible) {
    const points = clipSurfacePaintToCell(fragment.points, cell);
    if (points.length >= 3) result.push({ points, opacity: fragment.opacity });
  }
  return result.slice(0, 64);
};
