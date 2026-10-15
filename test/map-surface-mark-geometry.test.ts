import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { surfaceBloodShapeCounts, surfaceMarkPaint, visibleSurfacePaint, surfaceMarkRadius } from '../src/game/map-surface-mark-geometry';
import type { LocalMapCell } from '../src/game/local-exploration-route';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const area = (points: readonly { x: number; y: number }[]) => Math.abs(points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y; }, 0)) / 2;
const narrowestAngle = (points: readonly { x: number; y: number }[]) => Math.min(...points.map((point, index) => {
  const a = points[(index + points.length - 1) % points.length], b = points[(index + 1) % points.length], ax = a.x - point.x, ay = a.y - point.y, bx = b.x - point.x, by = b.y - point.y;
  return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by))))) * 180 / Math.PI;
}));

test('blood has a smaller asymmetric concave body, attached sharp sprays and mixed directional droplets', () => {
  const counts = surfaceBloodShapeCounts(17), paint = surfaceMarkPaint(0, 0, 17, 'blood', .72), body = paint[0].points;
  assert.equal(paint.length, counts.mainShapes + counts.sprayShapes + counts.droplets);
  assert.ok(body.length > 90 && area(body) < .56);
  const radii = body.map(point => Math.hypot(point.x, point.y));
  assert.ok(Math.max(...radii) / Math.min(...radii) > 3 && radii.filter(radius => radius > .7).length < body.length / 8, 'a few attached spikes extend beyond the uneven liquid body');
  const turns = body.map((point, index) => { const a = body[(index + body.length - 1) % body.length], b = body[(index + 1) % body.length]; return (point.x - a.x) * (b.y - point.y) - (point.y - a.y) * (b.x - point.x); });
  assert.ok(turns.some(turn => turn > .00001) && turns.some(turn => turn < -.00001), 'real inward notches replace a rounded convex polygon');
  assert.ok(paint.slice(1, 1 + counts.sprayShapes).every(shape => narrowestAngle(shape.points) < 75), 'independent sprays have tapered tips rather than elliptical ends');
  const dropAreas = paint.slice(1 + counts.sprayShapes).map(shape => area(shape.points));
  assert.ok(Math.max(...dropAreas) / Math.min(...dropAreas) > 8, 'outer droplets include distinctly large, medium and small sizes');
});

test('blood variation is deterministic, stays within the display halo and respects the existing clipped budget', () => {
  const cells: LocalMapCell[] = [];
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) cells.push({ x, y, z: 0, regionId: 1, regionCode: 'worldtree_meadow', passable: true });
  const bodies = new Set<string>();
  for (let seed = 0; seed < 48; seed++) {
    const paint = surfaceMarkPaint(0, 0, seed, 'blood', .8), counts = surfaceBloodShapeCounts(seed);
    assert.ok(counts.droplets >= 12 && counts.droplets <= 18); assert.ok(counts.sprayShapes >= 2 && counts.sprayShapes <= 3);
    assert.deepEqual(surfaceMarkPaint(0, 0, seed, 'blood', .8), paint);
    assert.ok(paint.every(shape => shape.opacity >= 0 && shape.opacity <= 1 && shape.points.every(point => Math.hypot(point.x, point.y) <= surfaceMarkRadius + .0002)));
    const clipped = visibleSurfacePaint(paint, cells, { x: 0, y: 0, z: 0, regionId: 1 });
    assert.ok(clipped.length > counts.droplets && clipped.length <= 64);
    bodies.add(fingerprint(paint[0]));
  }
  assert.equal(bodies.size, 48);
});

test('blood-only visual update preserves slime, debris and magic geometry byte for byte', () => {
  const before = { slime: '218d2057bd64c18797d3004a012589a9c3bce23803f70574ec825878fa695965', debris: '4dec65bd0491fd2e9e324df0c6d049f23650cc3d6b3ab4de48b2fd84ca8b58d5', magic: '551322d985a01d68c9f4ed142f3a51cfdea1a9ad222ab2bbd0e04be38ccec5dc' };
  for (const [kind, digest] of Object.entries(before)) assert.equal(fingerprint(surfaceMarkPaint(-16, 17, 17, kind, .8)), digest);
});
