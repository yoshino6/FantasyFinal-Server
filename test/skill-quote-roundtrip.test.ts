import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const source = readFileSync(fileURLToPath(new URL('../src/app-api/skill.service.ts', import.meta.url)), 'utf8');
const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
const nativeRequire = createRequire(import.meta.url);

// Native JSON storage may return object keys in a different order from the
// inserted document. Arrays retain their order, and values retain JSON types.
const normalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
      .map(([key, item]) => [key, normalizeJson(item)]));
  }
  return value;
};
const persistJson = (value: unknown) => JSON.stringify(normalizeJson(JSON.parse(JSON.stringify(value))));

type StoredRequest = { owner: number; kind: string; snapshotJson: string; resultJson: string | null };

const harness = (driver: 'object' | 'string' = 'object', resultExtra: Record<string, unknown> = {}) => {
  const requests = new Map<string, StoredRequest>();
  const state = { skillPoints: 3, skillLevel: 4, specializationLevel: 1, costAdjustment: 0,
    rangeLevel: 1, informationLevel: 1, mutations: 0, fighting: false, resultExtra };
  const specializationCalls: boolean[] = [];
  const driverReadTypes: string[] = [];
  const readJson = (json: string) => {
    const value = driver === 'string' ? json : JSON.parse(json);
    driverReadTypes.push(typeof value);
    // Match craftJson's handling of mysql2 native objects and jsonStrings mode.
    return typeof value === 'string' ? JSON.parse(value) : value;
  };
  let nextId = 0;
  const uuid = () => `00000000-0000-0000-0000-${String(++nextId).padStart(12, '0')}`;
  const connection = {
    execute: async (sql: string) => {
      if (sql.includes('SELECT skill_points FROM characters')) return [[{ skill_points: state.skillPoints }]];
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const unexpected = async () => { throw new Error('Unexpected presentation or unrelated skill action'); };
  const craft = {
    craftCharacterId: async (_connection: unknown, user: string) => user === 'player' ? 1 : 2,
    createCraftRequest: async (_connection: unknown, owner: number, kind: string, snapshot: unknown) => {
      const token = uuid();
      requests.set(token, { owner, kind, snapshotJson: persistJson(snapshot), resultJson: null });
      return token;
    },
    craftRequestFor: async (_connection: unknown, owner: number, kind: string, token: string) => {
      const stored = requests.get(token);
      if (!stored || stored.owner !== owner || stored.kind !== kind) throw new Error('Invalid request');
      return { snapshot: readJson(stored.snapshotJson), result: stored.resultJson === null ? null : readJson(stored.resultJson) };
    },
    completeCraftRequest: async (_connection: unknown, owner: number, token: string, result: unknown) => {
      const stored = requests.get(token);
      assert.equal(stored?.owner, owner);
      stored!.resultJson = persistJson(result);
    }
  };
  const settle = (cost: number, preview: boolean) => {
    if (state.skillPoints < cost) throw new Error(`技能点不足，升级需要 ${cost} 点。`);
    if (!preview) { state.mutations++; state.skillPoints -= cost; }
  };
  const adventure = {
    learnSkillInTransaction: async (_connection: unknown, _user: string, _skillId: number, preview: boolean) => {
      settle(1, preview);
      return { name: '新技能', cost: 1 };
    },
    upgradeSkillInTransaction: async (_connection: unknown, _user: string, _skillId: number, preview: boolean) => {
      const result = { name: '技能', level: state.skillLevel + 1, cost: 1 };
      settle(result.cost, preview);
      if (!preview) state.skillLevel++;
      return result;
    },
    upgradeAppraisalInTransaction: async (_connection: unknown, _user: string, direction: string, preview: boolean) => {
      const current = direction === 'range' ? state.rangeLevel : state.informationLevel;
      const cost = direction === 'range' ? current : current + 1;
      const result = { name: '鉴识', level: state.skillLevel + 1, cost, direction,
        rangeLevel: state.rangeLevel + (direction === 'range' ? 1 : 0),
        informationLevel: state.informationLevel + (direction === 'information' ? 1 : 0) };
      settle(cost, preview);
      if (!preview) { state.skillLevel++; if (direction === 'range') state.rangeLevel++; else state.informationLevel++; }
      return result;
    },
    upgradeSkillSpecializationInTransaction: async (_connection: unknown, _user: string, _skillId: number, specialization: string, preview: boolean) => {
      specializationCalls.push(preview);
      const cost = state.specializationLevel + state.costAdjustment;
      const result = { name: '技能', skillLevel: state.skillLevel + 1, specialization, level: state.specializationLevel + 1, cost,
        ...JSON.parse(JSON.stringify(state.resultExtra)) };
      settle(cost, preview);
      if (!preview) {
        state.skillLevel++;
        state.specializationLevel++;
      }
      return result;
    },
    skillDetail: async () => ({ code: 'appraisal', learned: true }),
    skillList: unexpected, togglePassiveLinkInTransaction: unexpected, toggleSkillShortcutInTransaction: unexpected
  };
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: uuid },
    '../database/pool': { withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work(connection) },
    '../game/alchemy-journal.service': craft,
    '../game/adventure.service': adventure,
    '../game/combat-loadout-lock.service': { assertCombatLoadoutMutable: async () => {
      if (state.fighting) throw new Error('战斗中不能调整配置。');
    } },
    './skill-specialization-details': { skillSpecializationDetails: unexpected },
    './skill-combat-details': { skillCombatDetails: unexpected },
    '../game/aoe-damage.config': { aoeSkillPower: unexpected },
    '../game/blacksmith.service': { craftsmanshipEffect: unexpected }
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (name in modules) return modules[name];
    if (name.startsWith('node:')) return nativeRequire(name);
    throw new Error(`Unexpected import: ${name}`);
  }, loaded, loaded.exports);
  const specializationPreview = () => loaded.exports.previewSkillAction('player', { action: 'specialization', skillId: 4, specialization: 'overcharge' });
  const confirm = (preview: { token: string; idempotencyKey: string }) => loaded.exports.confirmSkillAction('player', preview.token, preview.idempotencyKey);
  return { service: loaded.exports, state, requests, uuid, driverReadTypes, specializationCalls, specializationPreview, confirm };
};

for (const driver of ['object', 'string'] as const) {
test(`specialization quote survives recursive JSON key reordering (${driver} driver) and settles once`, async () => {
  const h = harness(driver);
  const preview = await h.specializationPreview();
  const storedQuote = JSON.parse(h.requests.get(preview.token)!.snapshotJson).quote;
  assert.deepEqual(storedQuote, preview.quote);
  assert.notEqual(JSON.stringify(storedQuote), JSON.stringify(preview.quote));
  assert.notEqual(JSON.stringify(storedQuote.result), JSON.stringify(preview.quote.result));
  assert.equal(h.state.mutations, 0);
  assert.equal(preview.quote.skillPointsBefore, 3);
  assert.equal(preview.quote.skillPointsAfter, 2);

  const result = await h.confirm(preview);
  assert.deepEqual(result, { name: '技能', skillLevel: 5, specialization: 'overcharge', level: 2, cost: 1 });
  assert.deepEqual(h.specializationCalls, [true, true, false]);
  assert.deepEqual([h.state.skillPoints, h.state.skillLevel, h.state.specializationLevel, h.state.mutations], [2, 5, 2, 1]);
  assert.deepEqual(await h.confirm(preview), result);
  assert.deepEqual(h.specializationCalls, [true, true, false]);
  assert.equal(h.state.mutations, 1);
  assert.deepEqual([...new Set(h.driverReadTypes)], [driver]);
});

for (const action of ['learn', 'upgrade', 'appraisal'] as const) {
test(`${action} quote survives persisted JSON (${driver} driver) and settles once`, async () => {
  const h = harness(driver);
  const preview = await h.service.previewSkillAction('player', { action, skillId: 5, ...(action === 'appraisal' ? { direction: 'range' } : {}) });
  assert.equal(h.state.mutations, 0);
  const storedQuote = JSON.parse(h.requests.get(preview.token)!.snapshotJson).quote;
  assert.deepEqual(storedQuote, preview.quote);
  assert.notEqual(JSON.stringify(storedQuote), JSON.stringify(preview.quote));
  const result = await h.confirm(preview);
  const expected = action === 'learn' ? { name: '新技能', cost: 1 }
    : action === 'upgrade' ? { name: '技能', level: 5, cost: 1 }
      : { name: '鉴识', level: 5, cost: 1, direction: 'range', rangeLevel: 2, informationLevel: 1 };
  assert.deepEqual(result, expected);
  assert.deepEqual(await h.confirm(preview), result);
  assert.deepEqual([h.state.skillPoints, h.state.mutations], [2, 1]);
  assert.deepEqual([...new Set(h.driverReadTypes)], [driver]);
});
}

test(`nested JSON keys may reorder while array order is preserved (${driver} driver)`, async () => {
  const h = harness(driver, { details: { attack: 100, mana: 5 }, order: [{ target: 'enemy', priority: 2 }, 'self'] });
  const preview = await h.specializationPreview();
  const result = await h.confirm(preview);
  assert.deepEqual(result.details, { attack: 100, mana: 5 });
  assert.deepEqual(result.order, [{ target: 'enemy', priority: 2 }, 'self']);
  assert.deepEqual(await h.confirm(preview), result);
  assert.equal(h.state.mutations, 1);
});
}

test('a real skill point change still invalidates the persisted quote', async () => {
  const h = harness();
  const preview = await h.specializationPreview();
  h.state.skillPoints = 2;
  await assert.rejects(h.confirm(preview), /技能或技能点状态已变化/);
  assert.equal(h.state.mutations, 0);
  assert.equal(h.requests.get(preview.token)!.resultJson, null);
});

test('a real specialization level and cost change still invalidates the persisted quote', async () => {
  const h = harness();
  const preview = await h.specializationPreview();
  h.state.specializationLevel = 2;
  await assert.rejects(h.confirm(preview), /技能或技能点状态已变化/);
  assert.deepEqual([h.state.skillPoints, h.state.mutations], [3, 0]);
});

test('a real cost change with unchanged skill and specialization levels still invalidates the quote', async () => {
  const h = harness();
  const preview = await h.specializationPreview();
  h.state.costAdjustment = 1;
  await assert.rejects(h.confirm(preview), /技能或技能点状态已变化/);
  assert.deepEqual([h.state.skillPoints, h.state.skillLevel, h.state.specializationLevel, h.state.mutations], [3, 4, 1, 0]);
});

test('a real skill level change with unchanged points and cost still invalidates the quote', async () => {
  const h = harness();
  const preview = await h.specializationPreview();
  h.state.skillLevel++;
  await assert.rejects(h.confirm(preview), /技能或技能点状态已变化/);
  assert.deepEqual([h.state.skillPoints, h.state.specializationLevel, h.state.mutations], [3, 1, 0]);
});

for (const change of ['nested value', 'array order'] as const) {
test(`a real ${change} change still invalidates the persisted quote`, async () => {
  const h = harness('string', { details: { attack: 100, mana: 5 }, order: ['enemy', 'self'] });
  const preview = await h.specializationPreview();
  if (change === 'nested value') (h.state.resultExtra.details as { attack: number }).attack++;
  else (h.state.resultExtra.order as string[]).reverse();
  await assert.rejects(h.confirm(preview), /技能或技能点状态已变化/);
  assert.deepEqual([h.state.skillPoints, h.state.mutations], [3, 0]);
});
}

test('persisted quotes retain credential, owner, insufficient-point and battle protections', async () => {
  const h = harness();
  const preview = await h.specializationPreview();
  await assert.rejects(h.service.confirmSkillAction('player', preview.token, h.uuid()), /凭据不匹配/);
  await assert.rejects(h.service.confirmSkillAction('other-player', preview.token, preview.idempotencyKey), /Invalid request/);
  await assert.rejects(h.service.confirmSkillAction('player', 'invalid', preview.idempotencyKey), /凭据无效/);
  h.state.fighting = true;
  await assert.rejects(h.confirm(preview), /战斗中/);
  await assert.rejects(h.specializationPreview(), /战斗中/);
  h.state.fighting = false;
  h.state.skillPoints = 0;
  await assert.rejects(h.confirm(preview), /技能点不足/);
  await assert.rejects(h.specializationPreview(), /技能点不足/);
  assert.equal(h.requests.size, 1);
  assert.equal(h.state.mutations, 0);
});
