import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { withTransaction } from '../database/pool';
import { craftCharacterId, craftJson } from '../game/alchemy-journal.service';
import { advancedProfessionByCode } from '../game/advanced-profession.config';
import { beginAdvancedProfessionTrialInTransaction } from '../game/advanced-profession.service';
import { chooseTargetInTransaction } from '../game/adventure.service';

type TrialStartResult = { professionCode: string; spawnId: number; sessionId: string };
type RequestRow = RowDataPacket & { character_id: number; kind: string; state: string; snapshot_json: unknown; result_json: unknown };
type ActiveTrialRow = RowDataPacket & { session_id: string; spawn_id: number };
const requestKind = 'web_advanced_trial';
const validKey = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const activeTrialFor = async (connection: PoolConnection, characterId: number, code: string) => {
  const [rows] = await connection.execute<ActiveTrialRow[]>(`SELECT cs.id AS session_id,s.id AS spawn_id
    FROM combat_members cm JOIN combat_sessions cs ON cs.id=cm.session_id
    JOIN combat_targets ct ON ct.session_id=cs.id JOIN monster_spawns s ON s.id=ct.spawn_id
    WHERE cm.character_id=? AND cs.state='active'
      AND JSON_CONTAINS(COALESCE(s.traits_json,JSON_ARRAY()),
        JSON_OBJECT('code','advanced_profession_trial','owner_character_id',?,'profession_code',?))
    LIMIT 1 FOR UPDATE`, [characterId, characterId, code]);
  return rows[0] ?? null;
};

/** 导师生成、Core 入战和幂等结果同事务提交；入战失败时不会留下新生成的导师。 */
export const startWebAdvancedProfessionTrial = (qqUserId: string, code: string, idempotencyKey: string) =>
  withTransaction(async connection => {
    if (!validKey(idempotencyKey)) throw new Error('试炼请求编号无效，请刷新后重试。');
    if (!advancedProfessionByCode(code)) throw new Error('这条世界树二转传承尚未开放。');
    const characterId = await craftCharacterId(connection, qqUserId, true);
    const [requests] = await connection.execute<RequestRow[]>(
      'SELECT character_id,kind,state,snapshot_json,result_json FROM player_craft_requests WHERE token=? FOR UPDATE',
      [idempotencyKey]);
    const previous = requests[0];
    if (previous) {
      if (Number(previous.character_id) !== characterId || previous.kind !== requestKind
        || craftJson<{ professionCode: string }>(previous.snapshot_json)?.professionCode !== code
        || previous.state !== 'complete' || !previous.result_json) {
        throw new Error('试炼请求编号已被使用，请刷新后重新发起。');
      }
      return { kind: 'battle_recovered' as const, ...craftJson<TrialStartResult>(previous.result_json) };
    }

    const active = await activeTrialFor(connection, characterId, code);
    let result: TrialStartResult;
    let kind: 'battle_started' | 'battle_recovered';
    if (active) {
      result = { professionCode: code, spawnId: Number(active.spawn_id), sessionId: String(active.session_id) };
      kind = 'battle_recovered';
    } else {
      const trial = await beginAdvancedProfessionTrialInTransaction(connection, qqUserId, code);
      const battle = await chooseTargetInTransaction(connection, qqUserId, trial.spawnId);
      result = { professionCode: code, spawnId: trial.spawnId, sessionId: battle.sessionId };
      kind = 'battle_started';
    }
    await connection.execute(`INSERT INTO player_craft_requests
      (token,character_id,kind,state,snapshot_json,result_json,expires_at)
      VALUES (?,?,?,'complete',?,?,DATE_ADD(NOW(),INTERVAL 30 DAY))`,
      [idempotencyKey, characterId, requestKind, JSON.stringify({ professionCode: code }), JSON.stringify(result)]);
    return { kind, ...result };
  });
