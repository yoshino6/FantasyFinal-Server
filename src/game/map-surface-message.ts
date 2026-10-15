import { surfaceCombatTtlMs, surfaceWalkTtlMs } from './map-surface-marks.service';
import type { MapSurfaceScene } from './map-surface-scene';

type SurfaceHintScene = Pick<MapSurfaceScene, 'schemaVersion' | 'scopeToken' | 'recentWalks' | 'combatMarks'>;
const visibleNow = (mark: { ageMs: number; remainingMs: number }, ttl: number) =>
  Number.isFinite(mark.ageMs) && mark.ageMs >= 0 && mark.ageMs < ttl && Number.isFinite(mark.remainingMs) && mark.remainingMs > 0;
/** QQ只描述当前感知内的匿名地表事实，不回显轨迹、坐标、年龄或角色身份。 */
export const surfaceEnvironmentHint = (scene?: SurfaceHintScene) => {
  if (scene?.schemaVersion !== 1 || !/^world:\d+$/.test(scene.scopeToken)) return '';
  const lines: string[] = [];
  if (scene.recentWalks.some(mark => visibleNow(mark, surfaceWalkTtlMs))) lines.push('草地留着浅浅脚印。');
  if (scene.combatMarks.some(mark => ['blood', 'slime', 'debris', 'magic'].includes(mark.kind) && visibleNow(mark, surfaceCombatTtlMs))) lines.push('附近留有战斗痕迹。');
  return lines.join('\n');
};
