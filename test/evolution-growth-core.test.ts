import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from '../../web/node_modules/typescript/lib/typescript.js';

test('ordinary injection validators and settlement progress 20 through 30 with full XP and real material rules', async () => {
  const names = ['injectionRules', 'injectionAvailable', 'materialsForLevel', 'fixedBonusFor', 'previewEvolutionInjectionInTransaction', 'injectEvolutionOnConnection', 'injectEvolutionInTransaction', 'toggleShapingTraitInTransaction'];
  const file = ts.createSourceFile('evolution.ts', readFileSync(new URL('../src/game/evolution.service.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const statements = file.statements.filter(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => names.includes(d.name.getText(file))));
  assert.equal(statements.length, names.length);
  const source = ts.transpileModule(statements.map(s => s.getText(file).replace(/^export\s+/, '')).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const character = { id: 7, name: '测试旅者', level: 20, experience: 2000, skill_points: 0, profession_code: 'warrior', realm_stage: 3 };
  const profile: any = { unlocked_level: 20, injection_count: 0, adaptation_pressure: 0, stability: 50, fixed_bonus_json: '{}', lineage_marks_json: '{}', final_traits_json: '[]', symbiosis_trait_code: null };
  const inventory: Record<string, number> = { evolution_active_sample: 100, evolution_stable_medium: 100, evolution_catalyst: 100 };
  let traits: any[] = [], enzyme = false, legacy = 0, consumes = 0, draws = 0, events = 0;
  const connection = { execute: async (sql: string, args: any[]) => {
    if (sql.startsWith('SELECT 1 FROM player_mutations') || sql.includes('SELECT 1 FROM player_mutations\n')) return [enzyme ? [{}] : []];
    if (sql.includes('SET unlocked_level=?')) {
      Object.assign(profile, { unlocked_level: args[0], injection_count: profile.injection_count + 1, adaptation_pressure: args[1], stability: args[2], fixed_bonus_json: args[3], lineage_marks_json: args[4], symbiosis_trait_code: profile.symbiosis_trait_code ?? args[5] });
    } else if (sql.startsWith('UPDATE characters SET level=')) { character.level = args[0]; character.experience = 0; character.skill_points++; }
    else if (sql.includes('SET final_traits_json=')) profile.final_traits_json = args[0];
    else if (sql.includes('INSERT INTO player_events')) events++;
    else assert.fail(`Unexpected SQL: ${sql}`);
    return [{ affectedRows: 1, insertId: events }];
  } };
  const deps: Record<string, any> = {
    bodyParts: ['eye','nerve','skin','chest','bone','organ'], characterFor: async () => ({ ...character }), ensureEvolutionProfile: async () => ({ ...profile }),
    experienceRequiredForLevel: (level: number) => level * 100,
    symbiosisTraitCodes: ['shared_guard','mana_circulation','healing_resonance'], symbiosisTraits: { shared_guard: { name: '守护' } },
    selectableFinalTraits: async () => traits, jsonNumberList: (value: string) => JSON.parse(value), jsonObject: (value: string) => JSON.parse(value), jsonStringObject: (value: string) => JSON.parse(value),
    injectionItemCodes: Object.fromEntries(['conservative','aggressive','harmonic','perception','symbiosis','metamorphosis','shaping'].map(c => [c, `needle_${c}`])),
    injectionNames: { conservative: '保守', shaping: '定型', symbiosis: '共生' }, evolutionItemName: (code: string) => code,
    itemQuantity: async (_: any, _id: number, code: string) => ({ quantity: code.startsWith('needle_') ? legacy : inventory[code] ?? 0 }),
    consumeItem: async () => { legacy--; consumes++; },
    consumeItems: async (_: any, _id: number, costs: Record<string, number>) => { for (const [code, count] of Object.entries(costs)) { assert.ok(inventory[code] >= count); inventory[code] -= count; } consumes++; },
    randomItem: (values: any[]) => values[0], Math: { ...Math, random: () => .99, min: Math.min, max: Math.max, floor: Math.floor },
    drawMutation: async () => { draws++; assert.fail('Unexpected mutation draw'); }, lineageForPart: {},
    mergeBonus: (left: any, right: any) => { const result = { ...left }; for (const [key, value] of Object.entries(right)) result[key] = Number(result[key] ?? 0) + Number(value); return result; },
    clamp: (value: number, min: number, max: number) => Math.max(min, Math.min(max, value)),
    recordCharacterOperation: async (_: any, record: any) => assert.equal(record.detail.adminTest, false),
    createHeartQuestionsForLevels: async () => {}, achievementLevel: () => {}, recordSkillPointChange: async () => {}
  };
  const service = new Function(...Object.keys(deps), `${source}\nreturn { ${names.join(',')} };`)(...Object.values(deps));
  await assert.rejects(service.previewEvolutionInjectionInTransaction(connection, 'player', 'perception'), /当前生长结/);
  await assert.rejects(service.previewEvolutionInjectionInTransaction(connection, 'player', 'conservative', 'eye'), /部位/);
  const before = JSON.stringify({ character, profile, inventory });
  assert.deepEqual((await service.previewEvolutionInjectionInTransaction(connection, 'player', 'conservative')).costs, {});
  assert.equal(JSON.stringify({ character, profile, inventory }), before);
  for (let level = 20; level < 30; level++) {
    character.experience = 0;
    await assert.rejects(service.previewEvolutionInjectionInTransaction(connection, 'player', level === 29 ? 'shaping' : 'conservative'), /经验/);
    character.experience = level * 100;
    const code = level === 29 ? 'shaping' : 'conservative';
    const quote = await service.previewEvolutionInjectionInTransaction(connection, 'player', code);
    assert.equal(quote.toLevel, level + 1);
    if (level === 29) assert.deepEqual(quote.costs, { evolution_active_sample: 8, evolution_stable_medium: 5, evolution_catalyst: 5 });
    const result = await service.injectEvolutionInTransaction(connection, 'player', code);
    assert.equal(result.toLevel, level + 1); assert.equal(character.experience, 0);
  }
  assert.equal(character.level, 30); assert.equal(character.skill_points, 10); assert.equal(consumes, 9); assert.equal(events, 10); assert.equal(draws, 0);
  profile.unlocked_level = character.level = 29; character.experience = 2900;
  traits = [{ id: 1, mutation_name: '稳定观察' }];
  await assert.rejects(service.previewEvolutionInjectionInTransaction(connection, 'player', 'shaping'), /选择 1/);
  await service.toggleShapingTraitInTransaction(connection, 'player', 1, true); assert.equal(profile.final_traits_json, '[]');
  await service.toggleShapingTraitInTransaction(connection, 'player', 1); assert.equal(profile.final_traits_json, '[1]');
  assert.equal((await service.previewEvolutionInjectionInTransaction(connection, 'player', 'shaping')).finalTraits.length, 1);
  inventory.evolution_catalyst = 0; await assert.rejects(service.previewEvolutionInjectionInTransaction(connection, 'player', 'shaping'), /缺少材料/);
  legacy = 1; assert.deepEqual((await service.previewEvolutionInjectionInTransaction(connection, 'player', 'shaping')).costs, { needle_shaping: 1 });
  profile.unlocked_level = character.level = 23; character.experience = 2300;
  await assert.rejects(service.previewEvolutionInjectionInTransaction(connection, 'player', 'symbiosis'), /共生/);
});
