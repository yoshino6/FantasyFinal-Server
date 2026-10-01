import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = resolve(import.meta.dirname, '../src/assets/game/story/illustrations');
const manifestPath = resolve(base, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const census = JSON.parse(await readFile(resolve(base, 'census.json'), 'utf8'));
const primaryGroups = new Set();
for (const image of manifest.scenes) {
  const group = census.groups.find(group => group.sceneKeys.includes(image.sceneKey));
  if (!group) continue;
  // Additional branch-specific illustrations still resolve by their exact scene
  // keys; only the first image provides a group's explicit fallback.
  if (image.groupKey && primaryGroups.has(image.groupKey)) delete image.groupKey;
  if (!image.groupKey && !primaryGroups.has(group.storyGroupKey)) image.groupKey = group.storyGroupKey;
  if (image.groupKey) primaryGroups.add(image.groupKey);
  image.sceneKeys ??= group.recommendedSceneKey === image.sceneKey ? group.displaySceneKeys : [image.sceneKey];
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
const active = census.groups.filter(group => ['active', 'new-player'].includes(group.status));
const keys = new Set(manifest.scenes.flatMap(image => [image.sceneKey, ...(image.sceneKeys ?? [])]));
const covers = group => group.sceneKeys.some(key => keys.has(key));
const historical = census.groups.filter(group => !['active', 'new-player'].includes(group.status));
console.log(JSON.stringify({ images: manifest.scenes.length, currentGroups: active.length, coveredGroups: active.filter(covers).length, missingGroups: active.filter(group => !covers(group)).map(group => group.storyGroupKey), historicalGroups: historical.length, coveredHistoricalGroups: historical.filter(covers).length, missingHistoricalGroups: historical.filter(group => !covers(group)).map(group => group.storyGroupKey) }));
