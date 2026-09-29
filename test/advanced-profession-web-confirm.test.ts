import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

test('web world tree profession chain previews, rechecks and confirms each step once', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/app-api/advanced-profession.service.ts', import.meta.url)), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const professions = [
    { code: 'war_lord', name: '战旗使', baseProfession: '战士', role: '增益',
      mentor: { code: 'mentor_warlord', name: '旌岚', title: '战旗领唱', x: -6, y: -8 },
      route: { regionCode: 'dark_forest_deep', name: '幽暗密林深处', x: 0, y: -220,
        materialCode: 'goblin_ear', materialName: '哥布林耳' },
      passive: { name: '旗语', description: '强化队伍' },
      first: { title: '见闻', story: '调查战鼓', targetText: '战鼓手', requiredKills: 3 },
      second: { title: '凭证', story: '带回凭证', targetText: '盾卫', requiredKills: 5, materialCount: 2 },
      trial: { name: '战旗导师', description: '导师战' } },
    { code: 'elementalist', name: '元素使', baseProfession: '法师', role: '魔法输出',
      mentor: { code: 'mentor_elementalist', name: '澜烬', title: '四相调律师', x: 6, y: 8 },
      route: { regionCode: 'rediron_pass', name: '赤铁山道', x: 0, y: 161,
        materialCode: 'fire_crystal', materialName: '炉心赤晶' },
      passive: { name: '四相', description: '强化元素' },
      first: { title: '见闻', story: '调查矿灵', targetText: '矿灵', requiredKills: 3 },
      second: { title: '凭证', story: '带回样本', targetText: '甲虫', requiredKills: 5, materialCount: 2 },
      trial: { name: '元素导师', description: '导师战' } }
  ];
  const requests = new Map<string, { owner: number; kind: string; snapshot: any; result: any }>();
  let sequence = 0;
  let level = 24;
  let baseProfession: string | null = 'warrior';
  let x = -6;
  let y = -8;
  let hiddenQuest = false;
  let retrainRemainingSeconds = 0;
  let quest: { profession_code: string; stage: number; story_kills: number; proof_kills: number } | null = null;
  let material = 2;
  let writes = 0;
  const uuid = () => `00000000-0000-0000-0000-${String(++sequence).padStart(12, '0')}`;
  const candidate = (code: string) => professions.find(item => item.code === code)!;
  const atMentor = (code: string) => x === candidate(code).mentor.x && y === candidate(code).mentor.y;
  const core = {
    advancedProfessionOverview: async () => ({
      character: { level, profession: baseProfession, region_code: 'world_tree', pos_x: x, pos_y: y },
      activeQuest: quest, completed: null, hiddenQuest: hiddenQuest ? 'hidden' : null,
      retrainRemainingSeconds, materialQuantities: { goblin_ear: material, fire_crystal: 0 }, professions
    }),
    beginAdvancedProfessionInTransaction: async (_connection: unknown, _user: string, code: string, replace: boolean, preview: boolean) => {
      if (!atMentor(code)) throw new Error('请前往世界树导师处。');
      if (level < 25) throw new Error('二转试炼将在 Lv.25 开放。');
      if (hiddenQuest) throw new Error('你正在进行地图隐藏二转任务。');
      const other = quest?.profession_code !== code ? quest : null;
      if (other && !replace) throw new Error('确认中断当前进度后，才能开启新的试炼。');
      const quote = { action: replace ? 'switch_quest' : 'accept', professionCode: code,
        stageBefore: quest?.stage ?? 0, stageAfter: 1, replacedQuestCode: other?.profession_code ?? null,
        replacedQuestStage: other?.stage ?? null, storyKills: quest?.story_kills ?? 0 };
      if (!preview) { quest = { profession_code: code, stage: 1, story_kills: 0, proof_kills: 0 }; writes++; }
      return quote;
    },
    advanceAdvancedProfessionStageInTransaction: async (_connection: unknown, _user: string, code: string, preview: boolean) => {
      if (!atMentor(code)) throw new Error('请前往世界树导师处。');
      if (!quest || quest.profession_code !== code || quest.stage !== 1) throw new Error('当前不能提交第一段见闻。');
      if (quest.story_kills < 3) throw new Error('见闻尚未完成。');
      const quote = { action: 'submit_story', professionCode: code, stageBefore: 1, stageAfter: 2, storyKills: quest.story_kills };
      if (!preview) { quest.stage = 2; writes++; }
      return quote;
    },
    submitAdvancedProfessionProofInTransaction: async (_connection: unknown, _user: string, code: string, preview: boolean) => {
      if (!atMentor(code)) throw new Error('请前往世界树导师处。');
      if (!quest || quest.profession_code !== code || quest.stage !== 2) throw new Error('当前不能提交第二段凭证。');
      if (quest.proof_kills < 5 || material < 2) throw new Error('凭证尚未齐备。');
      const quote = { action: 'submit_proof', professionCode: code, stageBefore: 2, stageAfter: 3,
        proofKills: quest.proof_kills, materialOwnedBefore: material, materialCount: 2 };
      if (!preview) { quest.stage = 3; material -= 2; writes++; }
      return quote;
    }
  };
  const modules: Record<string, unknown> = {
    'node:crypto': { randomUUID: uuid },
    '../database/pool': { withTransaction: async (work: (connection: unknown) => Promise<unknown>) => work({}) },
    '../game/alchemy-journal.service': {
      craftCharacterId: async (_connection: unknown, user: string) => user === 'intruder' ? 8 : 7,
      createCraftRequest: async (_connection: unknown, owner: number, kind: string, snapshot: any) => {
        assert.ok(kind.length <= 24, 'request kind must fit player_craft_requests.kind');
        const token = uuid(); requests.set(token, { owner, kind, snapshot, result: null }); return token;
      },
      craftRequestFor: async (_connection: unknown, owner: number, kind: string, token: string) => {
        const row = requests.get(token);
        if (!row || row.owner !== owner || row.kind !== kind) throw new Error('确认凭据已失效。');
        return { snapshot: row.snapshot, result: row.result };
      },
      completeCraftRequest: async (_connection: unknown, _owner: number, token: string, result: any) => {
        requests.get(token)!.result = result;
      }
    },
    '../game/advanced-profession.config': { registeredAdvancedProfessionByCode: (code: string) => candidate(code) },
    '../game/advanced-profession.service': core
  };
  const loaded = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  const service = loaded.exports;

  assert.deepEqual((await service.advancedProfessionStatus('player')).candidates[0].availableActions, []);
  x = 0;
  assert.match((await service.advancedProfessionStatus('player')).candidates[0].blockedReason, /Lv\.25/);
  level = 25;
  baseProfession = null;
  assert.match((await service.advancedProfessionStatus('player')).candidates[0].blockedReason, /初始职业/);
  baseProfession = 'warrior';
  hiddenQuest = true;
  assert.match((await service.advancedProfessionStatus('player')).candidates[0].blockedReason, /隐藏二转任务/);
  hiddenQuest = false;
  retrainRemainingSeconds = 3600;
  assert.match((await service.advancedProfessionStatus('player')).candidates[0].blockedReason, /冷却中/);
  retrainRemainingSeconds = 0;
  assert.deepEqual((await service.advancedProfessionStatus('player')).candidates[0].availableActions, []);
  assert.match((await service.advancedProfessionStatus('player')).candidates[0].blockedReason, /请前往世界树/);
  x = -6;
  assert.deepEqual((await service.advancedProfessionStatus('player')).candidates[0].availableActions, ['accept']);
  const accepted = await service.previewAdvancedProfessionAction('player', 'war_lord', 'accept');
  assert.equal(quest, null);
  await assert.rejects(service.confirmAdvancedProfessionAction('intruder', accepted.token, accepted.idempotencyKey), /失效/);
  await assert.rejects(service.confirmAdvancedProfessionAction('player', accepted.token, uuid()), /不匹配/);
  assert.equal(writes, 0);
  x = 0;
  await assert.rejects(service.confirmAdvancedProfessionAction('player', accepted.token, accepted.idempotencyKey), /导师处/);
  x = -6;
  await service.confirmAdvancedProfessionAction('player', accepted.token, accepted.idempotencyKey);
  await service.confirmAdvancedProfessionAction('player', accepted.token, accepted.idempotencyKey);
  assert.deepEqual([quest?.stage, writes], [1, 1]);

  quest!.story_kills = 3;
  const story = await service.previewAdvancedProfessionAction('player', 'war_lord', 'submit_story');
  quest!.story_kills = 4;
  await assert.rejects(service.confirmAdvancedProfessionAction('player', story.token, story.idempotencyKey), /已变化/);
  quest!.story_kills = 3;
  await service.confirmAdvancedProfessionAction('player', story.token, story.idempotencyKey);
  assert.deepEqual([quest!.stage, writes], [2, 2]);

  quest!.proof_kills = 5;
  const proof = await service.previewAdvancedProfessionAction('player', 'war_lord', 'submit_proof');
  material = 3;
  await assert.rejects(service.confirmAdvancedProfessionAction('player', proof.token, proof.idempotencyKey), /已变化/);
  material = 2;
  await service.confirmAdvancedProfessionAction('player', proof.token, proof.idempotencyKey);
  await service.confirmAdvancedProfessionAction('player', proof.token, proof.idempotencyKey);
  assert.deepEqual([quest!.stage, material, writes], [3, 0, 3]);
  assert.deepEqual((await service.advancedProfessionStatus('player')).candidates[0].availableActions, []);

  x = 6; y = 8;
  hiddenQuest = true;
  assert.deepEqual((await service.advancedProfessionStatus('player')).candidates[1].availableActions, []);
  await assert.rejects(service.previewAdvancedProfessionAction('player', 'elementalist', 'switch_quest'), /地图隐藏二转/);
  hiddenQuest = false;
  const switched = await service.previewAdvancedProfessionAction('player', 'elementalist', 'switch_quest');
  assert.equal(switched.quote.replacedQuestCode, 'war_lord');
  await service.confirmAdvancedProfessionAction('player', switched.token, switched.idempotencyKey);
  assert.deepEqual([quest!.profession_code, quest!.stage, writes], ['elementalist', 1, 4]);
});
