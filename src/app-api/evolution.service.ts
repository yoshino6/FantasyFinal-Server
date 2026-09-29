import { randomUUID } from 'node:crypto';
import { getPool, withTransaction } from '../database/pool';
import { craftCharacterId, createCraftRequest, craftRequestFor, completeCraftRequest } from '../game/alchemy-journal.service';
import { recalculateCharacterStats } from '../game/character.service';
import { bodyPartNames, evolutionLabSite, evolutionPanel, mutationDetail, requireEvolutionLabTarget,
  setMutationPausedInTransaction } from '../game/evolution.service';

type MutationAction = 'pause' | 'resume';
type Snapshot = { mutationId: number; action: MutationAction; quote: Record<string, unknown>; idempotencyKey: string };
const requestKind = 'web_evolution_mutation';
const quoteMinutes = 2;
const validCredential = (value: string) => /^[0-9a-f-]{36}$/i.test(value);
const pausedForAction = (action: MutationAction) => {
  if (action === 'pause') return true;
  if (action === 'resume') return false;
  throw new Error('当前网页仅支持暂停或恢复偏差型变异。');
};
const jsonValue = (value: unknown): unknown => {
  if (typeof value !== 'string') return value ?? {};
  try { return JSON.parse(value); } catch { return {}; }
};
const actionsFor = (state: string): MutationAction[] => state === 'deviation' ? ['pause'] : state === 'paused' ? ['resume'] : [];

export const evolutionStatus = async (qqUserId: string) => {
  const panel = await evolutionPanel(qqUserId);
  const lab = await evolutionLabSite(qqUserId);
  if (!panel) return { profileOpened: false, lab, character: null, profile: null, materials: [], injections: [], mutations: [], history: [] };
  return {
    profileOpened: true, lab,
    character: { level: Number(panel.character.level), experience: Number(panel.character.experience), realmStage: Number(panel.character.realm_stage) },
    profile: { unlockedLevel: Number(panel.profile.unlocked_level), injectionCount: Number(panel.profile.injection_count),
      evolutionScale: Number(panel.profile.evolution_scale), adaptationPressure: Number(panel.profile.adaptation_pressure),
      stability: Number(panel.profile.stability), symbiosisTraitCode: panel.profile.symbiosis_trait_code,
      lineageMarks: jsonValue(panel.profile.lineage_marks_json), finalTraitIds: jsonValue(panel.profile.final_traits_json) },
    materials: panel.materials, injections: panel.injections.map(item => ({ ...item, name: panel.injectionNames[item.code] })),
    mutations: panel.mutations.map(mutation => ({ id: Number(mutation.id), name: mutation.mutation_name,
      bodyPart: mutation.body_part, bodyPartName: bodyPartNames[mutation.body_part], state: mutation.mutation_state,
      tier: Number(mutation.tier), sourceInjection: mutation.source_injection,
      ...(lab.atSite ? { effect: jsonValue(mutation.effect_json), description: mutation.description } : {}),
      availableActions: lab.atSite ? actionsFor(mutation.mutation_state) : [] })),
    history: panel.history.map(record => ({ eventType: record.event_type, payload: jsonValue(record.payload), createdAt: record.created_at }))
  };
};

export const evolutionMutation = async (qqUserId: string, mutationId: number) => {
  const { target } = await requireEvolutionLabTarget(await getPool(), qqUserId);
  const mutation = await mutationDetail(qqUserId, mutationId);
  return { target, mutation: { id: Number(mutation.id), name: mutation.mutation_name,
    bodyPart: mutation.body_part, bodyPartName: bodyPartNames[mutation.body_part], state: mutation.mutation_state,
    tier: Number(mutation.tier), sourceInjection: mutation.source_injection, effect: jsonValue(mutation.effect_json),
    description: mutation.description, availableActions: actionsFor(mutation.mutation_state) } };
};

export const previewEvolutionMutation = (qqUserId: string, mutationId: number, action: MutationAction) => withTransaction(async connection => {
  const { characterId, target } = await requireEvolutionLabTarget(connection, qqUserId, true);
  const { characterId: quoteCharacterId, ...quote } = await setMutationPausedInTransaction(connection, qqUserId, mutationId, pausedForAction(action), true);
  if (quoteCharacterId !== characterId) throw new Error('变异记录所属角色已变化。');
  const idempotencyKey = randomUUID();
  const token = await createCraftRequest(connection, characterId, requestKind,
    { mutationId, action, quote, idempotencyKey } satisfies Snapshot, quoteMinutes);
  return { token, idempotencyKey, expiresAt: new Date(Date.now() + quoteMinutes * 60_000).toISOString(), target, quote };
});

export const confirmEvolutionMutation = (qqUserId: string, token: string, idempotencyKey: string) => withTransaction(async connection => {
  if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error('确认凭据无效，请重新查看变异记录。');
  const characterId = await craftCharacterId(connection, qqUserId, true);
  const request = await craftRequestFor<Snapshot>(connection, characterId, requestKind, token);
  if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error('确认凭据不匹配，请重新查看变异记录。');
  if (request.result) return request.result;
  await requireEvolutionLabTarget(connection, qqUserId, true);
  const snapshot = request.snapshot;
  const { characterId: quoteCharacterId, ...fresh } = await setMutationPausedInTransaction(connection, qqUserId,
    snapshot.mutationId, pausedForAction(snapshot.action), true);
  if (quoteCharacterId !== characterId || JSON.stringify(fresh) !== JSON.stringify(snapshot.quote))
    throw new Error('变异状态已变化，请重新查看记录。');
  const { characterId: resultCharacterId, ...result } = await setMutationPausedInTransaction(connection, qqUserId,
    snapshot.mutationId, pausedForAction(snapshot.action), false);
  await recalculateCharacterStats(connection, resultCharacterId);
  await completeCraftRequest(connection, characterId, token, result);
  return result;
});
