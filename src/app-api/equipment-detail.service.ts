import type { Pool, RowDataPacket } from 'mysql2/promise';
import { armorSlots, armorSlot } from '../game/armor-class';
import { armorSetDescription, armorSetFromRows } from '../game/armor-set';
import { epicLoadoutFromRows } from '../game/epic-equipment.service';
import { epicSetThresholdEffects } from '../game/equipment-set-summary';
import { equipmentEffectObject, equipmentSections } from '../game/equipment-detail-format';
import { equipmentEnchantmentLines } from '../game/equipment-enchantment-format';
import { epicForgeRecipes, epicSetProfile, type EpicSetCode } from '../config/epic-forging';

export const equipmentDetailSlots = ['weapon', 'offhand', 'shoulder', 'upper', 'waist', 'lower', 'feet', 'necklace', 'bracelet', 'ring'] as const;
export const requireEquipmentDetailSlot = (value: unknown) => {
  if (typeof value !== 'string' || !(equipmentDetailSlots as readonly string[]).includes(value)) throw new Error('无效的装备部位。');
  return value;
};
const slotNames: Record<string, string> = { weapon: '武器', offhand: '副手', shoulder: '头肩', upper: '上装', waist: '腰部', lower: '下装', feet: '脚部', necklace: '项链', bracelet: '手镯', ring: '戒指' };
export type EquipmentDetailSection = { key: string; title: string; lines: string[] };
export type EquipmentDetailSet = { code: string; name: string; count: number; maxPieces: 5; thresholds: { pieces: number; active: boolean; lines: string[] }[] };
export type EquippedDetailRow = {
  slot: string; instance_id: number | null; owned_instance_id: number | null; code: string; name: string;
  item_category: string; weapon_type: string | null; rarity: string; required_level: number;
  quality: number; durability: number; durability_max: number; effect_json: unknown; forge_primary_json: unknown; description: string;
  enchant_card_code?: string | null; enchant_card_version?: number | null; enchant_card_name?: string | null;
  enchant_effect_text?: string | null; enchant_effects_json?: unknown; enchant_allowed_slots_json?: unknown;
};
type FusionRow = { material_name: string; effect_key: string; effect_value: number };
const validRows = (rows: readonly EquippedDetailRow[]) => rows.filter(row => row.instance_id == null || row.owned_instance_id != null && Number(row.instance_id) === Number(row.owned_instance_id));
const uniqueArmor = (rows: readonly EquippedDetailRow[]) => {
  const result = new Map<string, EquippedDetailRow>();
  for (const row of rows) {
    const slot = armorSlot(row.slot);
    if ((armorSlots as readonly string[]).includes(slot) && !result.has(slot)) result.set(slot, row);
  }
  return [...result.values()];
};

/** Display the selected piece's sets, without treating owned/backpack items as worn pieces. */
export const equipmentDetailSets = (selected: EquippedDetailRow, rows: readonly EquippedDetailRow[]): EquipmentDetailSet[] => {
  if (!armorSlot(selected.slot)) return [];
  const equipped = uniqueArmor(validRows(rows)), sets: EquipmentDetailSet[] = [];
  const armor = String(selected.weapon_type ?? '');
  if (['布甲', '皮甲', '轻甲', '重甲', '板甲'].includes(armor)) {
    const count = equipped.filter(row => row.weapon_type === armor).length;
    sets.push({ code: `armor:${armor}`, name: `${armor}套装`, count, maxPieces: 5, thresholds: [3, 5].map(pieces => {
      const tier = armorSetFromRows(armorSlots.slice(0, pieces).map(slot => ({ slot, weapon_type: armor })))!;
      return { pieces, active: count >= pieces && (pieces === 5 || count < 5), lines: [armorSetDescription(tier), ...(pieces === 3 && count >= 5 ? ['已由5件效果替代；两档效果不叠加。'] : [])] };
    }) });
  }
  const setCode = String(equipmentEffectObject(selected.effect_json).epicSetCode ?? '');
  const count = equipped.filter(row => equipmentEffectObject(row.effect_json).epicSetCode === setCode).length;
  if (setCode === 'crimson_crown') {
    sets.push({ code: setCode, name: '猩红王冠', count, maxPieces: 5, thresholds: [
      { pieces: 1, active: count === 1, lines: ['残光护持：每场 PVE 首次受直接伤害后生命低于40%时，获得5%最大生命护盾（1回合）。', ...(count >= 2 ? ['已由2件护盾效果替代。'] : [])] },
      { pieces: 2, active: count >= 2, lines: ['残光护持：护盾提高至8%最大生命（1回合），替代单件的5%护盾。'] },
      { pieces: 5, active: count >= 5, lines: ['非战斗休息恢复速度提高10%。'] }
    ] });
  } else if (Object.prototype.hasOwnProperty.call(epicSetThresholdEffects, setCode)) {
    const code = setCode as EpicSetCode, loadout = epicLoadoutFromRows(equipped);
    sets.push({ code, name: epicSetProfile(code)?.name ?? code, count, maxPieces: 5, thresholds: [3, 5].map((pieces, index) => ({
      pieces, active: loadout.setCode === code && count >= pieces, lines: [epicSetThresholdEffects[code][index]!]
    })) });
  }
  return sets;
};

export const projectEquippedDetail = (slot: string, rows: readonly EquippedDetailRow[], fusions: readonly FusionRow[] = []) => {
  const owned = validRows(rows), selected = owned.find(row => row.slot === slot);
  if (!selected) return { slot, id: null, code: null, name: null, detail: null };
  const quality = Number(selected.quality ?? 100), effect = equipmentEffectObject(selected.effect_json);
  const formatted = equipmentSections(effect, quality, selected.forge_primary_json, selected.item_category, selected.weapon_type, '品质折算');
  const sections: EquipmentDetailSection[] = [
    { key: 'basic', title: '装备信息', lines: [`部位：${slotNames[slot]}`, `类型：${selected.weapon_type || selected.item_category}`, `稀有度：${selected.rarity}`, `装备等级：${selected.required_level}`, `精炼品质：${quality.toFixed(1)}%`, `耐久：${selected.durability}/${selected.durability_max}`] },
    { key: 'primary', title: '主属性', lines: formatted.attributes.filter(line => line.endsWith('(主)')).map(line => line.replace(/\(主\)$/, '')) },
    { key: 'secondary', title: '副属性与元素', lines: formatted.attributes.filter(line => line.endsWith('(副)')).map(line => line.replace(/\(副\)$/, '')) }
  ];
  if (slot === 'offhand') sections.push({ key: 'offhand-note', title: '副手属性说明', lines: ['以上为装备词条按品质折算的数值；穿戴后的属性还受副手武器精通倍率影响，不代表最终角色面板增量。'] });
  const weaponEffect = ['weapon', 'offhand'].includes(slot) ? epicForgeRecipes.find(recipe => recipe.code === effect.epicWeaponEffect)?.weaponEffect : undefined;
  sections.push({ key: 'special', title: '特殊效果', lines: [...formatted.effects, ...(weaponEffect ? [weaponEffect] : [])] });
  const allowedSlots = (() => {
    try {
      const raw = typeof selected.enchant_allowed_slots_json === 'string' ? JSON.parse(selected.enchant_allowed_slots_json) : selected.enchant_allowed_slots_json;
      return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string' && (equipmentDetailSlots as readonly string[]).includes(value)) : [];
    } catch { return []; }
  })();
  const storedEnchantText = String(selected.enchant_effect_text ?? '').trim();
  const enchantLines = selected.enchant_card_code ? [
    `${selected.enchant_card_name || selected.enchant_card_code}（版本 ${selected.enchant_card_version ?? '—'}）`,
    ...(allowedSlots.length ? [`可附魔部位：${allowedSlots.map(value => slotNames[value]).join(' / ')}`, ...(!allowedSlots.includes(slot) ? ['当前部位不在附魔快照的适用范围内，此附魔未生效。'] : [])] : []),
    ...(storedEnchantText ? [storedEnchantText] : equipmentEnchantmentLines(selected.enchant_effects_json))
  ].filter(Boolean) : ['无'];
  sections.push({ key: 'enchantment', title: '附魔', lines: enchantLines });
  if (fusions.length) sections.push({ key: 'legacy-fusion', title: '旧版熔铸记录', lines: ['以下为来源记录，已包含在当前装备词条中，不重复叠加。', ...fusions.map(row => {
    const text = equipmentSections({ [row.effect_key]: Number(row.effect_value) }, 100, [], selected.item_category, selected.weapon_type, '品质折算');
    return `${row.material_name}：${text.attributes[0]?.split('｜')[0]?.replace(' 原始', '') || text.effects[0] || `${row.effect_key} ${row.effect_value}`}`;
  })] });
  if (selected.description) sections.push({ key: 'description', title: '装备说明', lines: [selected.description] });
  return { slot, id: selected.instance_id == null ? null : Number(selected.instance_id), code: selected.code, name: selected.name,
    detail: { sections: sections.map(section => ({ ...section, lines: section.lines.length ? section.lines : ['无'] })), sets: equipmentDetailSets(selected, owned) } };
};

/** Only SELECTs: never call characterFor/getCharacter or settle rest, story, crafting or codex state. */
export const readEquippedDetail = async (qqUserId: string, requestedSlot: unknown, reader?: Pick<Pool, 'execute'>) => {
  const slot = requireEquipmentDetailSlot(requestedSlot);
  const db = reader ?? await (await import('../database/pool')).getPool();
  const [owners] = await db.execute<(RowDataPacket & { id: number })[]>('SELECT c.id FROM characters c JOIN players p ON p.id=c.player_id WHERE p.qq_user_id=? AND c.npc_code IS NULL LIMIT 1', [qqUserId]);
  if (!owners[0]) throw new Error('请先注册角色。');
  const owner = Number(owners[0].id);
  const [rows] = await db.execute<(RowDataPacket & EquippedDetailRow)[]>(`SELECT pe.slot,pe.instance_id,ii.id AS owned_instance_id,i.code,i.name,i.item_category,i.weapon_type,i.rarity,i.required_level,
      COALESCE(ii.quality,100) AS quality,COALESCE(ii.durability,100) AS durability,COALESCE(ii.durability_max,100) AS durability_max,
      COALESCE(ii.effect_json,i.effect_json) AS effect_json,ii.forge_primary_json,i.description,
      ee.card_code AS enchant_card_code,ee.card_version AS enchant_card_version,card.name AS enchant_card_name,
      ee.effect_text AS enchant_effect_text,ee.effects_json AS enchant_effects_json,ee.allowed_slots_json AS enchant_allowed_slots_json
    FROM player_equipment pe JOIN item_definitions i ON i.id=pe.item_id
    LEFT JOIN player_item_instances ii ON ii.id=pe.instance_id AND ii.character_id=pe.character_id
    LEFT JOIN equipment_enchantments ee ON ee.instance_id=ii.id LEFT JOIN item_definitions card ON card.id=ee.card_item_id
    WHERE pe.character_id=? AND i.item_type='equipment'
    ORDER BY FIELD(pe.slot,'shoulder','upper','waist','lower','feet','weapon','offhand','necklace','bracelet','ring')`, [owner]);
  const selected = validRows(rows).find(row => row.slot === slot);
  let fusions: FusionRow[] = [];
  if (selected?.instance_id != null) {
    const [entries] = await db.execute<(RowDataPacket & FusionRow)[]>(`SELECT i.name AS material_name,e.effect_key,e.effect_value
      FROM equipment_fusion_effects e JOIN equipment_fusions f ON f.id=e.fusion_id
      JOIN player_item_instances ii ON ii.id=f.instance_id JOIN item_definitions i ON i.id=f.material_item_id
      WHERE f.instance_id=? AND ii.character_id=? ORDER BY e.id`, [Number(selected.instance_id), owner]);
    fusions = entries;
  }
  return projectEquippedDetail(slot, rows, fusions);
};
