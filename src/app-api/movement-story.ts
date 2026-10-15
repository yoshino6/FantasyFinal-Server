import { openingStatus } from '../game/opening.service';
import { floatingTourState } from '../game/floating-leaf.service';
import { worldtreeWitnessState } from '../game/worldtree-witness.service';

/** A grid click must pass the same opening/tour middleware as a QQ move. */
export const appMovementNeedsStory = async (user: string) => {
  const opening = await openingStatus(user);
  if (opening && opening.state !== 'completed') return true;
  const leaf = await floatingTourState(user);
  if (leaf && (leaf.stage >= 1 && leaf.stage < 6 || leaf.stage === 0 && leaf.ready && leaf.atGuild)) return true;
  const tree = await worldtreeWitnessState(user);
  return Boolean(tree && (tree.tour >= 1 && tree.tour < 6 || tree.tour === 0 && tree.ready && tree.atGuild));
};
