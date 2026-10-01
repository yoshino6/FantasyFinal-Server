import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, basename, extname } from 'node:path';

// Prepare the current release and a deletion ledger. This script never deletes.
const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, 'server/src/assets/game/story/illustrations');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const writeJson = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const census = await readJson(resolve(directory, 'census.json'));
const current = census.groups.filter(group => ['active', 'new-player'].includes(group.status));
const keys = new Set(current.flatMap(group => group.sceneKeys));
const groupKeys = new Set(current.map(group => group.storyGroupKey));
const manifest = await readJson(resolve(directory, 'manifest.json'));
const removed = manifest.scenes.filter(image => !keys.has(image.sceneKey));
manifest.scenes = manifest.scenes.filter(image => keys.has(image.sceneKey));
const originals = new Set();
for (const image of manifest.scenes) {
  image.sceneKeys = (image.sceneKeys ?? [image.sceneKey]).filter(key => keys.has(key));
  if (image.groupKey && !groupKeys.has(image.groupKey)) delete image.groupKey;
  const stem = basename(image.file, extname(image.file));
  const suffix = stem.slice(image.sceneKey.replaceAll('.', '-').length);
  const candidates = [resolve(root, 'artwork/story', stem + '.png'),
    resolve(directory, 'originals', image.sceneKey + suffix + '.png')];
  let original;
  for (const path of candidates) { try { await stat(path); original = path; break; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  if (!original) throw new Error(`Final PNG missing: ${image.sceneKey}`);
  originals.add(original);
  image.original = relative(root, original).replaceAll('\\', '/');
}
await writeJson(resolve(directory, 'manifest.json'), manifest);
for (const name of ['batch-professions.json', 'batch-side-stories.json', 'batch-prologue-neutral.json']) {
  const batch = await readJson(resolve(directory, name));
  batch.scenes = batch.scenes.map(image => manifest.scenes.find(final => final.sceneKey === image.sceneKey)).filter(Boolean);
  await writeJson(resolve(directory, name), batch);
}
const keepWebp = new Set(manifest.scenes.map(image => image.file));
const entries = new Map();
const add = async (path, reason) => {
  const resolved = resolve(path);
  if (!resolved.startsWith(root + '\\') && !resolved.startsWith(root + '/')) throw new Error('Path outside workspace');
  const bytes = await readFile(resolved);
  entries.set(resolved, { path: relative(root, resolved).replaceAll('\\', '/'), bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), reason });
};
const raster = /\.(?:png|webp|jpe?g)$/i;
for (const folder of [directory, resolve(root, 'web/public/assets/story')]) {
  for (const file of await readdir(folder)) if (raster.test(file) && !keepWebp.has(file)) await add(resolve(folder, file), '未进入当前剧情发布清单：已退出剧情或被替换旧版本');
}
for (const folder of [resolve(directory, 'originals'), resolve(root, 'artwork/story')]) {
  for (const file of await readdir(folder)) if (raster.test(file) && !originals.has(resolve(folder, file))) await add(resolve(folder, file), '历史剧情、未开放内容或未采用原画版本');
}
for (const file of await readdir(resolve(root, 'artwork/story/review'))) {
  if (raster.test(file) && /legacy|lamplight/i.test(file)) await add(resolve(root, 'artwork/story/review', file), '被排除剧情的旧联系表');
}
// These staging files can otherwise reintroduce retired assets on a later merge.
for (const name of ['batch-lamplight.json', 'batch-legacy-gallery.json', 'batch-legacy-wiring.json', 'legacy-reuse-audit.json']) {
  await add(resolve(directory, name), '被排除剧情的暂存批次或复用计划');
}
for (const folder of [resolve(directory, 'prompts'), resolve(root, 'artwork/story/prompts')]) {
  for (const file of await readdir(folder)) {
    if (/legacy|lamplight/.test(file)) await add(resolve(folder, file), '被排除剧情的绘图提示词');
  }
}
for (const file of await readdir(resolve(root, 'artwork/story'))) {
  if (/legacy|lamplight/.test(file) && !raster.test(file)) await add(resolve(root, 'artwork/story', file), '被排除剧情的生成或参考计划');
}
await writeJson(resolve(directory, 'release-scope.json'), {
  version: 1, groups: [...groupKeys], imageCount: manifest.scenes.length,
  excludedGroups: census.groups.filter(group => !groupKeys.has(group.storyGroupKey)).map(group => ({ key: group.storyGroupKey, status: group.status })),
  evidence: ['server/src/game/opening-world.config.ts: openingStartRouteCodes has 7 routes',
    'server/src/database/lamplight.ts: initializeLamplight disables all dedicated locations',
    'server/src/index.ts: no lamplight command registrations',
    'server/src/game/opening.service.ts: current F03 enters old forest_guide at stage 5']
});
const ledger = { generatedAt: new Date().toISOString(), deleted: false, releasedImages: manifest.scenes.length,
  currentGroups: current.length, removedManifestScenes: removed.map(image => image.sceneKey),
  files: [...entries.values()].sort((a,b) => a.path.localeCompare(b.path)) };
await writeJson(resolve(root, 'artwork/story/review/story-image-cleanup.json'), ledger);
console.log(JSON.stringify({ images: manifest.scenes.length, currentGroups: current.length, candidates: entries.size,
  candidateBytes: ledger.files.reduce((sum,file) => sum + file.bytes, 0), removedManifestScenes: ledger.removedManifestScenes }));
