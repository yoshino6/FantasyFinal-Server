import { environmentHash } from './map-environment.config';

/** 独立视觉随机数；雪崩混合避免相邻后缀造成草簇对角排列或等角飞溅。 */
export const surfaceRandomFraction = (value: string): number => {
  let mixed = environmentHash(value);
  mixed = Math.imul(mixed ^ mixed >>> 16, 0x85ebca6b);
  mixed = Math.imul(mixed ^ mixed >>> 13, 0xc2b2ae35);
  return ((mixed ^ mixed >>> 16) >>> 0) / 0x100000000;
};
