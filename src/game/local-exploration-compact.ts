import type { LocalMapPosition } from './local-exploration-route';

type StepCharacter = { current_region_id: number; pos_x: number; pos_y: number; pos_z: number; region_name: string;
  current_hp: number; current_mp: number; stamina: number; activity_status: string;
  enteredTown?: boolean; talentScavengeNotice?: string };
type StepResult = { kind: string; character: StepCharacter; companionFindNotice?: boolean; targets?: readonly unknown[] };

/** Only an ordinary, same-region step can omit the full action panel. */
export const compactLocalStepAllowed = (result: StepResult, from: LocalMapPosition) => result.kind === 'event'
  && Number(result.character.current_region_id) === from.regionId && Number(result.character.pos_z) === from.z
  && Math.abs(Number(result.character.pos_x) - from.x) + Math.abs(Number(result.character.pos_y) - from.y) === 1
  && !result.character.enteredTown && !result.character.talentScavengeNotice && !result.companionFindNotice
  && !result.targets?.length;

/** Current values only: derived maxima and unrelated inventory/quest state stay with the full panel. */
export const compactLocalStepVitals = (character: StepCharacter, position: LocalMapPosition) => {
  const hp = Number(character.current_hp), mp = Number(character.current_mp), stamina = Number(character.stamina);
  if (character.activity_status !== 'active' || ![hp, mp, stamina].every(Number.isFinite) || hp <= 0 || mp < 0 || stamina < 0
    || Number(character.current_region_id) !== position.regionId || Number(character.pos_x) !== position.x
    || Number(character.pos_y) !== position.y || Number(character.pos_z) !== position.z) return undefined;
  return { position: { ...position }, region: character.region_name, hp: Math.round(hp), mp: Math.round(mp), stamina: Math.round(stamina) };
};
