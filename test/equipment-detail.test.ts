import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { equipmentSections } from '../src/game/equipment-detail-format';
import { equipmentEnchantmentLines } from '../src/game/equipment-enchantment-format';
import { monsterCards, parseMonsterCardEffects } from '../src/config/monster-cards';
import { epicForgeRecipes } from '../src/config/epic-forging';
import { equipmentDetailSets, projectEquippedDetail, readEquippedDetail, requireEquipmentDetailSlot, type EquippedDetailRow } from '../src/app-api/equipment-detail.service';

const item = (patch: Partial<EquippedDetailRow> = {}): EquippedDetailRow => ({
  slot: 'weapon', instance_id: 71, owned_instance_id: 71, code: 'instance-sword', name: '实例长剑',
  item_category: '武器', weapon_type: '长剑', rarity: '精良', required_level: 20, quality: 50,
  durability: 17, durability_max: 80, effect_json: { physicalAttack: 125, speed: 7, elementMastery_火: 2.5 },
  forge_primary_json: ['physicalAttack'], description: '独立测试装备。', ...patch
});
const armor = (count: number, set = 'valk_forge_regalia', type = '重甲') => ['shoulder', 'upper', 'waist', 'lower', 'feet'].slice(0, count).map((slot, index) => item({
  slot, instance_id: 80 + index, owned_instance_id: 80 + index, item_category: ['头肩', '上装', '腰部', '下装', '脚部'][index]!, weapon_type: type,
  effect_json: { physicalDefense: 100, ...(set ? { epicSetCode: set } : {}) }
}));
const lines = (result: ReturnType<typeof projectEquippedDetail>, key: string) => result.detail!.sections.find(section => section.key === key)!.lines;

test('slot whitelist rejects invalid and prototype keys before any data access', async () => {
  const db = { execute: async () => { throw new Error('Data access must not occur'); } } as unknown as Pick<Pool, 'execute'>;
  for (const value of ['constructor', '__proto__', 'toString', '../weapon', 'weapon ', '', null, 1]) {
    assert.throws(() => requireEquipmentDetailSlot(value), /无效/);
    await assert.rejects(readEquippedDetail('owner', value, db), /无效/);
  }
});

test('projection uses instance rolls, quality and primary keys; ratings are not percentages', () => {
  const result = projectEquippedDetail('weapon', [item()]);
  assert.equal(result.id, 71);
  assert.deepEqual(lines(result, 'primary'), ['物攻 原始+125｜品质折算+100']);
  assert.ok(lines(result, 'secondary').includes('火元素精通 原始+2.5｜品质折算+2.0'));
  assert.ok(lines(result, 'basic').includes('耐久：17/80'));
  assert.ok(equipmentSections({ critRateBp: 125, critResistPct: 10 }, 50, [], '武器', '长剑').attributes.some(line => line.includes('暴击 原始+125｜实际+100')));
  assert.ok(equipmentSections({ critResistPct: 10 }, 50, [], '武器', '长剑').attributes.some(line => line.includes('暴免 原始+10.0%｜实际+8.0%')));
  assert.deepEqual(equipmentSections({ actualHitRatePct: 6, actualCritRatePct: 4, physicalActualHitRatePct: 3, manaCostReduction: 2 }, 100, [], '武器', '长剑').effects,
    ['实际命中率 +6 个百分点', '实际暴击率 +4 个百分点', '物理攻击实际命中率 +3 个百分点', '技能魔力消耗降低 2']);
});

test('unknown artifacts and prototype-named effect keys neither throw nor invent attributes', () => {
  for (const artifact of ['constructor', '__proto__', 'toString', 'unknown']) {
    assert.deepEqual(equipmentSections({ artifact }, 100, [], '武器', '长剑'), { attributes: [], effects: [] });
  }
  assert.deepEqual(equipmentSections(JSON.parse('{"constructor":1,"__proto__":2,"toString":3}'), 100, [], '武器', '长剑'), { attributes: [], effects: [] });
});

test('offhand reports quality conversion and explicitly avoids claiming final panel contribution', () => {
  const result = projectEquippedDetail('offhand', [item({ slot: 'offhand' })]);
  assert.deepEqual(lines(result, 'primary'), ['物攻 原始+125｜品质折算+100']);
  assert.match(lines(result, 'offhand-note')[0]!, /副手武器精通倍率.*不代表最终角色面板增量/);
});

test('enchantment uses committed version/text; fusion ledger does not add its values again', () => {
  const result = projectEquippedDetail('weapon', [item({ enchant_card_code: 'card-v1', enchant_card_name: '旧版卡片', enchant_card_version: 1, enchant_effect_text: '物理攻击 +9', enchant_effects_json: { physicalAttack: 9 } })], [{ material_name: '旧铁', effect_key: 'physicalAttack', effect_value: 25 }]);
  assert.deepEqual(lines(result, 'primary'), ['物攻 原始+125｜品质折算+100']);
  assert.deepEqual(lines(result, 'enchantment'), ['旧版卡片（版本 1）', '物理攻击 +9']);
  assert.match(lines(result, 'legacy-fusion')[0]!, /不重复叠加/);
});

test('missing enchantment text falls back to exact stored effects, slot restriction and version', () => {
  const result = projectEquippedDetail('weapon', [item({ quality: 0, enchant_card_code: 'retired-card', enchant_card_version: 2,
    enchant_effect_text: ' ', enchant_effects_json: JSON.stringify({ physicalAttack: 8.58, cardDamageReductionPct: 3, actualCritRatePct: 6 }),
    enchant_allowed_slots_json: '["upper","lower"]' })]);
  const enchantment = lines(result, 'enchantment');
  assert.ok(enchantment.includes('retired-card（版本 2）'));
  assert.ok(enchantment.includes('可附魔部位：上装 / 下装'));
  assert.ok(enchantment.some(line => line.includes('此附魔未生效')));
  assert.ok(enchantment.includes('物理攻击 +8.58'));
  assert.ok(enchantment.includes('承受伤害降低 3%'));
  assert.ok(enchantment.includes('实际暴击 +6 个百分点'));
});

test('snapshot formatter preserves every currently defined card effect and future unknown values', () => {
  for (const card of monsterCards) {
    const formatted = equipmentEnchantmentLines(card.effects), parsed = parseMonsterCardEffects(formatted.join('；'));
    assert.deepEqual(parsed.unknown, [], card.cardCode);
    assert.deepEqual(parsed.effects, card.effects, card.cardCode);
  }
  assert.deepEqual(equipmentEnchantmentLines({ futureEffect: 1.25 }), ['快照词条 futureEffect：1.25']);
});

test('empty and foreign-owned instances never expose fallback definition details', () => {
  const expected = { slot: 'weapon', id: null, code: null, name: null, detail: null };
  assert.deepEqual(projectEquippedDetail('weapon', []), expected);
  assert.deepEqual(projectEquippedDetail('weapon', [item({ owned_instance_id: null })]), expected);
  assert.deepEqual(projectEquippedDetail('weapon', [item({ owned_instance_id: 999 })]), expected);
});

test('legacy equipment with no instance stays readable and has a null identity id', () => {
  const result = projectEquippedDetail('weapon', [item({ instance_id: null, owned_instance_id: null, quality: 100 })]);
  assert.equal(result.id, null);
  assert.equal(result.code, 'instance-sword');
  assert.deepEqual(lines(result, 'primary'), ['物攻 原始+125｜品质折算+125']);
});

test('set thresholds show inactive effects at one/two pieces, count real armor slots only', () => {
  for (const count of [1, 2]) {
    const rows = armor(count), sets = equipmentDetailSets(rows[0]!, [...rows, rows[0]!, item({ effect_json: { epicSetCode: 'valk_forge_regalia' } })]);
    assert.deepEqual(sets.map(set => set.count), [count, count]);
    assert.ok(sets.every(set => set.thresholds.length === 2 && set.thresholds.every(tier => !tier.active && tier.lines[0]!.length > 10)));
  }
  assert.deepEqual(equipmentDetailSets(item({ effect_json: { epicSetCode: 'valk_forge_regalia' } }), armor(5)), []);
});

test('armor five-piece tier replaces three, epic five-piece tier keeps both effects', () => {
  for (const count of [3, 5]) {
    const rows = armor(count), sets = equipmentDetailSets(rows[0]!, rows);
    assert.deepEqual(sets.find(set => set.code === 'armor:重甲')!.thresholds.map(tier => tier.active), count === 3 ? [true, false] : [false, true]);
    assert.deepEqual(sets.find(set => set.code === 'valk_forge_regalia')!.thresholds.map(tier => tier.active), count === 3 ? [true, false] : [true, true]);
  }
});

test('crimson one/two/five piece shield replacement and rest thresholds remain distinct', () => {
  for (const [count, expected] of [[1, [true, false, false]], [2, [false, true, false]], [5, [false, true, true]]] as const) {
    const rows = armor(count, 'crimson_crown'), set = equipmentDetailSets(rows[0]!, rows).find(set => set.code === 'crimson_crown')!;
    assert.deepEqual(set.thresholds.map(tier => tier.active), expected);
  }
});

test('mixed sets use worn-slot counts and keep crimson effects independent of the winning epic set', () => {
  const rows = armor(5);
  for (const row of rows.slice(0, 2)) row.effect_json = { epicSetCode: 'crimson_crown' };
  const crimson = equipmentDetailSets(rows[0]!, rows).find(set => set.code === 'crimson_crown')!;
  assert.equal(crimson.count, 2);
  assert.deepEqual(crimson.thresholds.map(tier => tier.active), [false, true, false]);
  const winner = equipmentDetailSets(rows[2]!, rows).find(set => set.code === 'valk_forge_regalia')!;
  assert.equal(winner.count, 3);
  assert.deepEqual(winner.thresholds.map(tier => tier.active), [true, false]);
  const foreign = rows.map(row => ({ ...row, owned_instance_id: null }));
  assert.equal(equipmentDetailSets(rows[2]!, [...foreign, rows[2]!]).find(set => set.code === 'valk_forge_regalia')!.count, 1);
});

test('unrecognized set metadata cannot read prototype properties or invent a set', () => {
  for (const code of ['unknown_set', 'constructor', '__proto__']) {
    const rows = armor(1, code, '未知甲');
    assert.deepEqual(equipmentDetailSets(rows[0]!, rows), []);
  }
});

test('epic weapon independent effect appears without inventing armor set membership', () => {
  const result = projectEquippedDetail('weapon', [item({ effect_json: { physicalAttack: 100, epicWeaponEffect: 'epic_zhenling_longsword' } })]);
  assert.ok(lines(result, 'special').some(line => line.includes('生命护盾') && line.includes('8%')));
  assert.deepEqual(result.detail!.sets, []);
  const recipe = epicForgeRecipes.find(recipe => recipe.code === 'epic_zhenling_longsword')!;
  for (const wrongCode of ['zhenling_longsword', recipe.name, 'unknown']) {
    const other = projectEquippedDetail('weapon', [item({ code: recipe.code, name: recipe.name, effect_json: { epicWeaponEffect: wrongCode } })]);
    assert.ok(!lines(other, 'special').includes(recipe.weaponEffect!));
  }
  const armorWithWeaponMetadata = armor(1);
  armorWithWeaponMetadata[0]!.effect_json = { epicWeaponEffect: recipe.code };
  assert.ok(!lines(projectEquippedDetail('shoulder', armorWithWeaponMetadata), 'special').includes(recipe.weaponEffect!));
});

test('read path binds the authenticated owner in all SELECTs and never writes', async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = { execute: async (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    assert.match(sql, /^SELECT /);
    assert.doesNotMatch(sql, /FOR UPDATE|INSERT|UPDATE |DELETE|REPLACE/i);
    if (sql.startsWith('SELECT c.id')) { assert.deepEqual(params, ['owner-A']); return [[{ id: 12 }]]; }
    if (sql.startsWith('SELECT pe.slot')) {
      assert.deepEqual(params, [12]);
      assert.match(sql, /ii.id=pe.instance_id AND ii.character_id=pe.character_id/);
      assert.match(sql, /COALESCE\(ii.effect_json,i.effect_json\)/);
      assert.match(sql, /WHERE pe.character_id=\?/);
      return [[item()]];
    }
    assert.deepEqual(params, [71, 12]);
    assert.match(sql, /f.instance_id=\? AND ii.character_id=\?/);
    return [[{ material_name: '旧铁', effect_key: 'physicalAttack', effect_value: 25 }]];
  } } as unknown as Pick<Pool, 'execute'>;
  const result = await readEquippedDetail('owner-A', 'weapon', db);
  assert.equal(result.id, 71);
  assert.equal(queries.length, 3);
  assert.deepEqual(lines(result, 'primary'), ['物攻 原始+125｜品质折算+100']);
});

test('no character and empty/foreign slot stop without fetching another instance', async () => {
  let calls = 0;
  const noOwner = { execute: async () => { calls++; return [[]]; } } as unknown as Pick<Pool, 'execute'>;
  await assert.rejects(readEquippedDetail('missing', 'weapon', noOwner), /注册/);
  assert.equal(calls, 1);
  for (const rows of [[], [item({ owned_instance_id: null })]]) {
    calls = 0;
    const db = { execute: async () => { calls++; return [calls === 1 ? [{ id: 12 }] : rows]; } } as unknown as Pick<Pool, 'execute'>;
    assert.equal((await readEquippedDetail('owner-A', 'weapon', db)).detail, null);
    assert.equal(calls, 2);
  }
});

test('GET route requires a session, derives owner from it and returns normal empty-slot JSON', async () => {
  const source = readFileSync(new URL('../src/app-api/equipment-detail-routes.ts', import.meta.url), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const module: { exports: any } = { exports: {} }, calls: unknown[][] = [];
  new Function('require', 'exports', 'module', compiled)((name: string) => {
    if (name.endsWith('app-channel.service')) return { appSessionQqUser: async (session: any) => session.owner };
    if (name.endsWith('equipment-detail.service')) return { readEquippedDetail: async (owner: string, slot: string) => {
      requireEquipmentDetailSlot(slot); calls.push([owner, slot]); return projectEquippedDetail(slot, []);
    } };
    throw new Error(`Unexpected dependency ${name}`);
  }, module.exports, module);
  let handler: (ctx: any) => Promise<void>;
  let session: any = { owner: 'authenticated-owner' };
  const router = { get: (path: string, callback: typeof handler) => { assert.equal(path, '/api/web/v1/equipment/:slot/detail'); handler = callback; } };
  module.exports.registerEquipmentDetailApiRoutes(router, '/api/web/v1', { requireSession: async () => session, apiError: (ctx: any, status: number, message: string) => { ctx.status = status; ctx.body = { ok: false, message }; } });
  const empty: any = { params: { slot: 'weapon' }, query: { owner: 'someone-else' } };
  await handler!(empty);
  assert.deepEqual(calls, [['authenticated-owner', 'weapon']]);
  assert.deepEqual(empty.body, { ok: true, slot: 'weapon', id: null, code: null, name: null, detail: null });
  const invalid: any = { params: { slot: 'constructor' } };
  await handler!(invalid); assert.equal(invalid.status, 400); assert.equal(calls.length, 1);
  session = null;
  await handler!({ params: { slot: 'weapon' } }); assert.equal(calls.length, 1);
});
