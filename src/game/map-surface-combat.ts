import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { recordSurfaceCombatMarkIn, resolveSurfaceScope } from './map-surface-marks.service';

export type SurfaceResidueKind = 'blood' | 'slime' | 'debris' | 'magic';
type GroundOrigin = { scopeKey: string; regionId: number; x: number; y: number; z: number };
export type SurfaceCombatState = {
  version: 1;
  origin: GroundOrigin;
  seed: number;
  settledAtMs?: number;
  /** 实际 HP 下降占该单位 HP 上限的累计比例；治疗不会撤销已有损伤事实。 */
  damage: Record<SurfaceResidueKind, number>;
};
type SurfaceTarget = { template_code?: unknown; code?: unknown; traits_json?: unknown };
const residueKinds: SurfaceResidueKind[] = ['blood', 'slime', 'debris', 'magic'];
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
};
const traitsOf = (target: SurfaceTarget): string[] => {
  let traits = target.traits_json;
  if (typeof traits === 'string') { try { traits = JSON.parse(traits); } catch { return []; } }
  return Array.isArray(traits) ? traits.map(trait => String(object(trait).code ?? '')) : [];
};
const excludedTraits = new Set(['boss_test', 'advanced_profession_trial', 'npc_sparring', 'aeson_duel', 'leaf_route_encounter', 'city_pursuit']);
const cosmeticOnlyTraits = new Set(['summoned', 'uzz_summon', 'boss_component']);
const slimeCodes = new Set(['dew_slime', 'bubble_slime', 'tide_slime', 'starmud_slime', 'forest_slime', 'slime_red', 'slime_orange', 'slime_yellow', 'slime_green', 'slime_cyan', 'slime_blue', 'slime_purple', 'black_slime', 'floatlight_jelly', 'mistalgae_mass', 'fallingstar_mudid']);
const debrisCodes = new Set(['vine_puppet', 'grassroot_guard', 'rubble_beast', 'stonevein_golem', 'magnet_golem', 'lava_rockbeast', 'gruen_mountainheart', 'coldpine_ent', 'storm_gargoyle', 'thundercopper_golem', 'ruin_stoneguard', 'starchart_doll', 'broken_armillary', 'tree_ent', 'skeleton', 'skeleton_warrior', 'skeleton_general', 'reed_walker', 'frostarmored_rider']);
const magicCodes = new Set(['reed_spirit', 'tidewraith', 'rediron_wisp', 'watermirror_siren', 'bogfire_wisp', 'faceless_bogspirit', 'ice_spike_sprite', 'icelake_spirit', 'windblade_elemental', 'moon_dust_wraith', 'well_wraith', 'undead', 'death_wight', 'death_knight', 'necromancer_uz']);
// 显式登记有血肉的目标；新加入的石偶/元素等不会因出现在地表配置中自动被当作血肉。
const bloodCodes = new Set([
  'clover_rabbit', 'sprout_rat', 'pollen_bee', 'grass_antler_deer', 'mossback_turtle', 'windchime_bird', 'dawn_fox', 'rootcrown_ram',
  'mudfin_murloc', 'river_shell_crab', 'watergrass_snake', 'rapid_otter', 'ironbeak_heron', 'mire_toad', 'river_scavenger', 'dawntide_crocodile',
  'shard_hermit', 'salt_urchin', 'sandrunner_lizard', 'shell_gull', 'rockarm_crab', 'headwind_sharkdog', 'shore_giant_lizard', 'ebb_acolyte', 'shattertide_crab',
  'canyon_jackal', 'ironfeather_vulture', 'mountain_beetle', 'cliff_ram', 'ember_bat', 'mine_goblin', 'fault_centipede', 'canyon_overseer',
  'moltenscorpion', 'ash_lizard', 'cinder_boar', 'mine_hexer', 'furnace_beetle', 'ore_raider', 'rediron_torchbearer', 'valk_forge_overseer',
  'marsh_crocodile', 'bog_midge', 'blackfeather_stork', 'mudarmor_rhino', 'rottedroot_python', 'reed_shaman', 'threehead_mother',
  'crater_toad', 'darkbog_snake', 'fallenstar_murloc', 'mud_parasite', 'meteor_carapace', 'lost_lamplighter', 'crater_eel', 'fallenstar_warden',
  'tundra_wolf', 'snowplush_bear', 'whiteantler_guard', 'snowblind_eagle', 'permafrost_giant', 'snowline_hunter', 'frostking_whiteantler',
  'thunderhawk', 'cliff_ram_thunder', 'cloudsplit_bat', 'bridge_raider', 'storm_priest', 'clifftop_lizard', 'cliff_arbiter', 'askr_stormroc',
  'solar_eclipse_priest', 'lunar_eclipse_assassin', 'lost_inquisitor', 'moonwheel_tombbeast', 'keykeeper_ruin', 'seles_eclipse_watcher',
  'ball_rabbit', 'spike_boar', 'vine_snake', 'black_bear', 'mist_wolf', 'roll_rabbit', 'tusk_boar', 'vine_python', 'pitch_bear', 'shadow_wolf',
  'goblin', 'shadow_wolf_king', 'goblin_king', 'habadragon', 'goblin_warrior', 'goblin_archer', 'goblin_bomber', 'goblin_daredevil', 'goblin_drummer', 'goblin_shieldbearer', 'goblin_trapper', 'goblin_priest', 'goblin_mage', 'goblin_assassin', 'goblin_colonel'
]);
/** 只按已登记身份决定材质，未知代码不按名字猜测有血生物。 */
export const surfaceResidueForTarget = (target: SurfaceTarget): SurfaceResidueKind | null => {
  if (traitsOf(target).some(code => excludedTraits.has(code) || cosmeticOnlyTraits.has(code))) return null;
  const code = String(target.template_code ?? target.code ?? '');
  if (slimeCodes.has(code)) return 'slime';
  if (debrisCodes.has(code)) return 'debris';
  if (magicCodes.has(code)) return 'magic';
  return bloodCodes.has(code) ? 'blood' : null;
};
const seedFor = (sessionId: string) => {
  let seed = 2166136261;
  for (const char of sessionId) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return seed >>> 0;
};
export const readSurfaceCombatState = (raw: unknown): SurfaceCombatState | null => {
  const state = object(raw); const origin = object(state.origin);
  if (state.version !== 1 || !Number.isInteger(state.seed) || Number(state.seed) < 0 || Number(state.seed) > 0xffffffff) return null;
  if (typeof origin.scopeKey !== 'string' || !/^world:\d+$/.test(origin.scopeKey)) return null;
  if (!Number.isInteger(origin.regionId) || Number(origin.regionId) <= 0 || !['x', 'y', 'z'].every(key => Number.isSafeInteger(origin[key])) || Number(origin.z) < 0) return null;
  if (origin.scopeKey !== 'world:' + origin.z) return null;
  const damage = object(state.damage);
  if (!residueKinds.every(kind => Number.isFinite(damage[kind]) && Number(damage[kind]) >= 0 && Number(damage[kind]) <= 1000)) return null;
  if (state.settledAtMs !== undefined && (!Number.isSafeInteger(state.settledAtMs) || Number(state.settledAtMs) <= 0)) return null;
  return { version: 1, origin: origin as GroundOrigin, seed: Number(state.seed), damage: damage as SurfaceCombatState['damage'], ...(state.settledAtMs ? { settledAtMs: Number(state.settledAtMs) } : {}) };
};
/** 冻结起战时权限范围；旧会话或不能确认公开地表的场景不会补猜落点。 */
export const freezeSurfaceCombatIn = async (connection: PoolConnection, sessionId: string, origin: Omit<GroundOrigin, 'scopeKey'>, targets: SurfaceTarget[], inPrivateHome = false): Promise<SurfaceCombatState | null> => {
  if (inPrivateHome || !targets.length || targets.some(target => traitsOf(target).some(code => excludedTraits.has(code)))) return null;
  const scopeKey = await resolveSurfaceScope(connection, origin);
  if (!scopeKey) return null;
  return readSurfaceCombatState({ version: 1, origin: { ...origin, scopeKey }, seed: seedFor(sessionId), damage: { blood: 0, slime: 0, debris: 0, magic: 0 } });
};
/**
 * 兼容规则引擎和旧技能直接写行对象的 HP 路径。
 * 保留已有生命守卫 setter，读取其实际结果；护盾吸收、闪避和治疗不制造损伤。
 * 仅在战斗面板/职业缩放初始化完成后安装，统计结果随回合事务存入 session.cooldowns。
 */
export const observeSurfaceCombatHp = (row: { current_hp: number; hp_max: number }, kind: SurfaceResidueKind | null, state: SurfaceCombatState | null) => {
  if (!kind || !state) return;
  const descriptor = Object.getOwnPropertyDescriptor(row, 'current_hp');
  if (descriptor?.configurable === false || descriptor?.writable === false) return;
  let hp = row.current_hp;
  const get = () => descriptor?.get ? descriptor.get.call(row) : hp;
  const set = (next: number) => {
    if (descriptor?.set) descriptor.set.call(row, next); else hp = next;
  };
  Object.defineProperty(row, 'current_hp', {
    configurable: true, enumerable: descriptor?.enumerable ?? true, get,
    set(next: number) {
      const before = Number(get()); set(next); const after = Number(get());
      const loss = Math.max(0, before) - Math.max(0, after);
      if (Number.isFinite(loss) && loss > 0 && Number.isFinite(row.hp_max) && row.hp_max > 0)
        state.damage[kind] = Math.min(1000, state.damage[kind] + loss / row.hp_max);
    }
  });
};
type SurfaceMarkWriter = typeof recordSurfaceCombatMarkIn;
/** 与最终战斗状态同事务；唯一 eventKey 由地表持久事件表保证重放不加深。 */
export const recordSurfaceCombatSettlementIn = async (connection: PoolConnection, sessionId: string, liveState?: SurfaceCombatState | null, writer: SurfaceMarkWriter = recordSurfaceCombatMarkIn) => {
  const [rows] = await connection.execute<(RowDataPacket & { mode: string; state: string; cooldowns: unknown })[]>('SELECT mode,state,cooldowns FROM combat_sessions WHERE id=? FOR UPDATE', [sessionId]);
  const session = rows[0];
  if (!session || session.mode !== 'pve' || !['victory', 'defeat', 'escaped'].includes(session.state)) return false;
  const saved = readSurfaceCombatState(object(session.cooldowns).__surfaceCombat);
  if (!saved) return false;
  // 结清泰坦延迟伤势等最终 HP 变化，也必须沿用已经冻结并持久保存的落点。
  const live = readSurfaceCombatState(liveState);
  const compatible = live && (['scopeKey', 'regionId', 'x', 'y', 'z'] as const).every(key => live.origin[key] === saved.origin[key]) && live.seed === saved.seed;
  const state: SurfaceCombatState = { ...saved, damage: { ...saved.damage }, settledAtMs: saved.settledAtMs ?? Date.now() };
  if (compatible) for (const kind of residueKinds) state.damage[kind] = Math.max(saved.damage[kind], live.damage[kind]);
  const kind = residueKinds.reduce((best, next) => state.damage[next] > state.damage[best] ? next : best);
  if (state.damage[kind] <= 0) return false;
  await connection.execute("UPDATE combat_sessions SET cooldowns=JSON_SET(cooldowns,'$.__surfaceCombat',CAST(? AS JSON)) WHERE id=?", [JSON.stringify(state), sessionId]);
  await writer(connection, { eventKey: 'combat:' + sessionId, ...state.origin, kind, seed: state.seed, intensity: Math.min(1, .35 + Math.sqrt(state.damage[kind]) * .45), occurredAtMs: state.settledAtMs });
  return true;
};
