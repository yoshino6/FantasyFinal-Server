import { randomUUID } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import { withTransaction } from '../database/pool';
import { craftCharacterId, createCraftRequest, craftRequestFor, completeCraftRequest } from '../game/alchemy-journal.service';
import { recalculateCharacterStats } from '../game/character.service';
import { acceptEvolutionObservationInTransaction, claimEvolutionObservationInTransaction,
  evolutionBusinessDate, injectEvolutionInTransaction, previewEvolutionInjectionInTransaction,
  requireEvolutionLabTarget, toggleShapingTraitInTransaction,
  type BodyPart, type InjectionCode, type SymbiosisTraitCode, type EvolutionObservationType } from '../game/evolution.service';

export type EvolutionProgressionAction =
  | { kind: 'inject'; code: InjectionCode; part?: BodyPart; symbiosisTrait?: SymbiosisTraitCode }
  | { kind: 'accept_observation'; type: EvolutionObservationType }
  | { kind: 'claim_observation' }
  | { kind: 'select_trait'; mutationId: number };
type Snapshot = { action: EvolutionProgressionAction; quote: Record<string, unknown>; idempotencyKey: string };
const requestKind = 'web_evolution_growth';
const validCredential = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const includes = (values: readonly string[], value: unknown) => typeof value === 'string' && values.includes(value);

export const evolutionProgressionAction = (body: Record<string, unknown>): EvolutionProgressionAction => {
  if (body.kind === 'inject') {
    if (!includes(['conservative', 'aggressive', 'harmonic', 'perception', 'symbiosis', 'metamorphosis', 'shaping'], body.code)) throw new Error('针剂类型无效。');
    if (body.part !== undefined && !includes(['eye', 'nerve', 'skin', 'chest', 'bone', 'organ'], body.part)) throw new Error('注射部位无效。');
    if (body.symbiosisTrait !== undefined && !includes(['shared_guard', 'mana_circulation', 'healing_resonance'], body.symbiosisTrait)) throw new Error('共生微被动无效。');
    return { kind: 'inject', code: body.code as InjectionCode,
      ...(body.part === undefined ? {} : { part: body.part as BodyPart }),
      ...(body.symbiosisTrait === undefined ? {} : { symbiosisTrait: body.symbiosisTrait as SymbiosisTraitCode }) };
  }
  if (body.kind === 'accept_observation' && includes(['behavior', 'sample', 'adaptation', 'resonance', 'containment'], body.type)) return { kind: body.kind, type: body.type as EvolutionObservationType };
  if (body.kind === 'claim_observation') return { kind: body.kind };
  if (body.kind === 'select_trait' && Number.isSafeInteger(body.mutationId) && Number(body.mutationId) > 0) return { kind: body.kind, mutationId: Number(body.mutationId) };
  throw new Error('进化操作无效。');
};

const previewInTransaction = async (connection: PoolConnection, user: string, action: EvolutionProgressionAction) => {
  if (action.kind === 'inject') return previewEvolutionInjectionInTransaction(connection, user, action.code, action.part, action.symbiosisTrait);
  if (action.kind === 'accept_observation') return { kind: action.kind, businessDate: evolutionBusinessDate(),
    ...await acceptEvolutionObservationInTransaction(connection, user, action.type, true) };
  if (action.kind === 'claim_observation') return { kind: action.kind, businessDate: evolutionBusinessDate(),
    ...await claimEvolutionObservationInTransaction(connection, user, true) };
  const draft = await toggleShapingTraitInTransaction(connection, user, action.mutationId, true);
  return { kind: action.kind, name: draft.traits.find(trait => Number(trait.id) === action.mutationId)!.mutation_name,
    mutationId: action.mutationId, selectedIds: draft.selectedIds, required: draft.required };
};

export const previewEvolutionProgression = (user: string, input: Record<string, unknown>) => withTransaction(async connection => {
  const action = evolutionProgressionAction(input);
  const { characterId, target } = await requireEvolutionLabTarget(connection, user, true);
  const quote = await previewInTransaction(connection, user, action);
  const idempotencyKey = randomUUID();
  const token = await createCraftRequest(connection, characterId, requestKind, { action, quote, idempotencyKey } satisfies Snapshot, 2);
  return { token, idempotencyKey, expiresAt: new Date(Date.now() + 120_000).toISOString(), target, quote };
});

export const confirmEvolutionProgression = (user: string, token: string, idempotencyKey: string) => withTransaction(async connection => {
  if (!validCredential(token) || !validCredential(idempotencyKey)) throw new Error('确认凭据无效，请重新预览进化操作。');
  const characterId = await craftCharacterId(connection, user, true);
  const request = await craftRequestFor<Snapshot>(connection, characterId, requestKind, token);
  if (request.snapshot.idempotencyKey !== idempotencyKey) throw new Error('确认凭据不匹配，请重新预览进化操作。');
  if (request.result) return request.result;
  await requireEvolutionLabTarget(connection, user, true);
  const action = evolutionProgressionAction(request.snapshot.action);
  const fresh = await previewInTransaction(connection, user, action);
  if (JSON.stringify(fresh) !== JSON.stringify(request.snapshot.quote)) throw new Error('进化条件或材料消耗已变化，请重新预览。');
  const result = action.kind === 'inject' ? await injectEvolutionInTransaction(connection, user, action.code, action.part, action.symbiosisTrait)
    : action.kind === 'accept_observation' ? await acceptEvolutionObservationInTransaction(connection, user, action.type)
      : action.kind === 'claim_observation' ? await claimEvolutionObservationInTransaction(connection, user)
        : await toggleShapingTraitInTransaction(connection, user, action.mutationId);
  if (action.kind === 'inject') await recalculateCharacterStats(connection, characterId);
  const completed = { kind: action.kind, ...result };
  await completeCraftRequest(connection, characterId, token, completed);
  return completed;
});
