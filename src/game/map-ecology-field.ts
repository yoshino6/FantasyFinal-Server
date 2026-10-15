/** Frozen v2 world field. Entity placement depends on these exact numbers;
 * change collision versions before changing this implementation. Pure module:
 * never import environment config/services here (they consume this field).
 */
export type SurfaceEcologySample = { cover: number; moisture: number; fertility: number; shade: number; rock: number; flowers: number };
const hashV2 = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
};
const mix = (a: number, b: number, amount: number) => a + (b - a) * amount;
const smooth = (n: number) => n * n * (3 - 2 * n);
const lattice = (x: number, y: number, seed: number) => {
  let value = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed;
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return ((value ^ value >>> 16) >>> 0) / 4294967295;
};
const noiseV2 = (x: number, y: number, seed: number) => {
  const ix = Math.floor(x), iy = Math.floor(y), tx = smooth(x - ix), ty = smooth(y - iy);
  return mix(mix(lattice(ix, iy, seed), lattice(ix + 1, iy, seed), tx), mix(lattice(ix, iy + 1, seed), lattice(ix + 1, iy + 1, seed), tx), ty);
};
export const surfaceEcologySeedV2 = (scopeToken: string): number => hashV2(`surface-ecology2:${scopeToken}`);
export const sampleSurfaceEcologyV2 = (x: number, y: number, seed: number): SurfaceEcologySample => {
  const wx = x + (noiseV2(x / 11, y / 11, seed ^ 97) - .5) * 3.4;
  const wy = y + (noiseV2(x / 11, y / 11, seed ^ 193) - .5) * 3.4;
  return {
    cover: noiseV2(wx / 8.5, wy / 8.5, seed ^ 7349) * .72 + noiseV2(wx / 3.1, wy / 3.1, seed ^ 7919) * .28,
    moisture: noiseV2(wx / 15, wy / 15, seed ^ 15823), fertility: noiseV2(wx / 12, wy / 12, seed ^ 3217),
    shade: noiseV2(wx / 13, wy / 13, seed ^ 7253), rock: noiseV2(wx / 10, wy / 10, seed ^ 8783),
    flowers: noiseV2(wx / 6.5, wy / 6.5, seed ^ 6353)
  };
};
// Existing visual consumers keep their public signature and exact values.
export const surfaceEcologySeed = surfaceEcologySeedV2;
export const sampleSurfaceEcology = sampleSurfaceEcologyV2;
