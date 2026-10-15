import type { EnvironmentArea, EnvironmentCell, EnvironmentProtection, EnvironmentTemplate, GeneratedEnvironmentObject } from './map-environment.config';
import { sampleSurfaceEcologyV2, surfaceEcologySeedV2 } from './map-ecology-field';

/** 新区域显式登记的冻结生成版本；不改变任何 env1 身份、通路或存档。 */
export const environmentV2Seed = 'fantasyfinal:environment:v2';
export const environmentV2SectorSize = 6;
export const environmentV2HabitatAt = (x: number, y: number, z: number) => sampleSurfaceEcologyV2(x, y, surfaceEcologySeedV2(`world:${z}`));
export const environmentV2Templates: Record<string, EnvironmentTemplate> = {
  living_oak: { id: 'living_oak', name: '青叶橡树', description: '枝冠繁茂的健康橡树，伐取后得到建设家园的木材。', assetKey: 'living_oak', width: 3, height: 3, blocking: true, destructible: true, workSeconds: 24, dropCode: 'home_wood' },
  living_birch: { id: 'living_birch', name: '白桦树', description: '林缘生长的白桦，伐取后可收集木材。', assetKey: 'living_birch', width: 2, height: 3, blocking: true, destructible: true, workSeconds: 20, dropCode: 'home_wood' },
  living_pine: { id: 'living_pine', name: '常青松树', description: '迎风生长的松树，树干可用作家园建材。', assetKey: 'living_pine', width: 2, height: 3, blocking: true, destructible: true, workSeconds: 22, dropCode: 'home_wood' },
  moss_boulder: { id: 'moss_boulder', name: '覆苔岩簇', description: '草木间露出的覆苔岩块，可敲取家园石料。', assetKey: 'moss_boulder', width: 2, height: 2, blocking: true, destructible: true, workSeconds: 20, dropCode: 'home_stone' }
};
type Helpers = {
  hash: (value: string) => number;
  areaAt: (areas: readonly EnvironmentArea[], cell: EnvironmentCell) => EnvironmentArea | undefined;
  objectCells: (object: GeneratedEnvironmentObject) => EnvironmentCell[];
  protectedCell: (cell: EnvironmentCell, protections: readonly EnvironmentProtection[]) => boolean;
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);
/** 世界坐标连续值噪声；访问顺序、视野大小与玩家状态不进入种子。 */
const noise = (x: number, y: number, scale: number, seed: string, hash: Helpers['hash']) => {
  const gx = Math.floor(x / scale), gy = Math.floor(y / scale), tx = smooth(x / scale - gx), ty = smooth(y / scale - gy);
  const sample = (dx: number, dy: number) => hash(`${seed}:${gx + dx}:${gy + dy}`) / 0x100000000;
  return mix(mix(sample(0, 0), sample(1, 0), tx), mix(sample(0, 1), sample(1, 1), tx), ty);
};
const ecology = (code: string) => {
  if (['world_tree', 'baina_town', 'floating_leaf_town', 'frost_dragon_inn', 'eternal_arena', 'boss_test_arena', 'dark_forest_dungeon'].includes(code)
    || /town|inn|arena|dungeon/.test(code)) return { density: 0, trees: [] as string[], rock: 0 };
  if (/frost|snow|thunder|ridge/.test(code)) return { density: .58, trees: ['living_pine'], rock: .38 };
  if (/ruins|rediron|gravel/.test(code)) return { density: .42, trees: ['living_birch'], rock: .8 };
  if (/swamp|marsh|riverbank/.test(code)) return { density: .55, trees: ['living_birch', 'living_oak'], rock: .22 };
  if (/forest/.test(code)) return { density: .94, trees: ['living_oak', 'living_birch', 'living_pine'], rock: .14 };
  return { density: .4, trees: ['living_birch', 'living_oak'], rock: .32 };
};
export const generateEnvironmentV2ForCells = (areas: readonly EnvironmentArea[], cells: readonly EnvironmentCell[], protections: readonly EnvironmentProtection[], helpers: Helpers): GeneratedEnvironmentObject[] => {
  if (cells.some(cell => ![cell.x, cell.y, cell.z].every(Number.isSafeInteger))) throw new Error('环境坐标必须为整数整格。');
  const sectors = new Map<string, { area: EnvironmentArea; sx: number; sy: number; z: number }>();
  const wanted = new Set(cells.map(cell => `${cell.x}:${cell.y}:${cell.z}`));
  for (const cell of cells) {
    if (cell.z < 0) continue;
    const sx = Math.floor(cell.x / 6), sy = Math.floor(cell.y / 6);
    for (const area of areas.filter(area => area.enabled && area.generationVersion === 2 && cell.z >= area.minZ && cell.z <= area.maxZ)) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) sectors.set(`${area.regionId}:${sx + dx}:${sy + dy}:${cell.z}`, { area, sx: sx + dx, sy: sy + dy, z: cell.z });
    }
  }
  const result: GeneratedEnvironmentObject[] = [];
  for (const { area, sx, sy, z } of sectors.values()) {
    const rules = ecology(area.code);
    if (!rules.density) continue;
    const seed = area.generationSeed ?? environmentV2Seed;
    const base = `2:${seed}:${area.code}:${sx}:${sy}:${z}`;
    const value = (key: string) => helpers.hash(`${base}:${key}`) / 0x100000000;
    const habitat = environmentV2HabitatAt(sx * 6 + 3, sy * 6 + 3, z);
    // 宏观林冠潜势与共享 cover/shade/moisture 共同形成林缘；profile seed
    // 只决定候选及抖动，不改变公共 world:z 生态场或其冻结数值版本。
    const macro = noise(sx * 6 + 3, sy * 6 + 3, 30, `${environmentV2Seed}:woodland:${z}`, helpers.hash) * .7
      + noise(sx * 6 + 3, sy * 6 + 3, 72, `${environmentV2Seed}:moisture:${z}`, helpers.hash) * .3;
    const woodland = macro * .35 + habitat.cover * .35 + habitat.shade * .2 + habitat.moisture * .1;
    // 连续生境形成密林核心、疏林边和开阔草地，避免每微区块均匀一株。
    const density = rules.density * Math.max(0, Math.min(1, (woodland - .22) / .45));
    const mirrored = value('mirror') < .5;
    for (let slot = 0; slot < 2; slot++) {
      if (value(`admission:${slot}`) > density * (slot === 0 ? 1 : .7)) continue;
      const tree = rules.trees.includes('living_pine') && habitat.shade > .57 && habitat.moisture < .54 ? 'living_pine'
        : rules.trees.includes('living_oak') && habitat.shade > .42 && habitat.moisture > .35 ? 'living_oak'
          : rules.trees.includes('living_birch') ? 'living_birch' : rules.trees[0]!;
      const kind = value(`kind:${slot}`) < rules.rock * (.35 + habitat.rock) ? 'moss_boulder' : tree;
      // 橡树仅占宽侧；窄侧使用桦/松/岩。两侧占用 x 列不交叉，
      // 任意未阻挡格都能沿本列直达南/北永久通路，不产生封闭口袋。
      const definition = environmentV2Templates[slot === 1 && kind === 'living_oak' ? 'living_birch' : kind]!;
      const onLeft = slot === 0 ? !mirrored : mirrored;
      const jitterX = slot === 0 && definition.width === 2 ? helpers.hash(`${base}:x:${slot}`) % 2 : 0;
      const x = sx * 6 + (onLeft ? 1 + jitterX : 6 - definition.width - jitterX);
      const y = sy * 6 + 1 + helpers.hash(`${base}:y:${slot}`) % (6 - definition.height);
      const footprint = Array.from({ length: definition.width * definition.height }, (_, index) => ({ dx: index % definition.width, dy: Math.floor(index / definition.width) }));
      const object: GeneratedEnvironmentObject = { ...definition, id: `env2:${area.code}:${x}:${y}:${z}:${slot}`, templateId: definition.id,
        regionId: area.regionId, regionCode: area.code, x, y, z, footprint, seed: helpers.hash(base), variant: helpers.hash(`${base}:variant:${slot}`) % 3 };
      const occupied = helpers.objectCells(object);
      if (!occupied.every(cell => helpers.areaAt(areas, cell)?.regionId === area.regionId)) continue;
      if (occupied.some(cell => helpers.protectedCell(cell, protections))) continue;
      if (occupied.some(cell => wanted.has(`${cell.x}:${cell.y}:${cell.z}`))) result.push(object);
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
};
