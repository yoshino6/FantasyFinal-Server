import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createStoryIllustrationRegistry, type StoryIllustration } from '../src/game/story-illustrations';

const server = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(server, '..');
const directory = resolve(server, 'src/assets/game/story/illustrations');
const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8')) as { scenes: StoryIllustration[] };
const census = JSON.parse(await readFile(resolve(directory, 'census.json'), 'utf8')) as {
  groups: { storyGroupKey: string; status: string; sceneKeys: string[] }[];
  scenes: { sceneKey: string }[];
};
// Construction also rejects duplicate exact aliases and ambiguous group fallbacks.
const registry = createStoryIllustrationRegistry(manifest.scenes);
const knownKeys = new Set(census.scenes.map(scene => scene.sceneKey));
const assets = [];
let totalBytes = 0;
for (const scene of manifest.scenes) {
  const [serverBytes, webBytes] = await Promise.all([
    readFile(resolve(directory, scene.file)),
    readFile(resolve(root, 'web/public/assets/story', scene.file))
  ]);
  if (!serverBytes.equals(webBytes)) throw new Error(`两端图片不一致：${scene.sceneKey}`);
  if (webBytes.length > 2 * 1024 * 1024) throw new Error(`QQ 图片超过 2 MiB：${scene.sceneKey}`);
  const metadata = await sharp(webBytes).metadata();
  if (metadata.format !== 'webp' || metadata.width !== scene.width || metadata.height !== scene.height) {
    throw new Error(`实际图片格式或尺寸不符：${scene.sceneKey}`);
  }
  const exactKeys = [...new Set([scene.sceneKey, ...(scene.sceneKeys ?? [])])].filter(key => knownKeys.has(key));
  if (!exactKeys.length) throw new Error(`图片没有对应实际剧情页：${scene.sceneKey}`);
  for (const key of exactKeys) {
    if (registry.appImage(key)?.path !== `/assets/story/${scene.file}`) throw new Error(`剧情页匹配错误：${key}`);
  }
  totalBytes += webBytes.length;
  assets.push({ sceneKey: scene.sceneKey, file: scene.file, bytes: webBytes.length,
    sha256: createHash('sha256').update(webBytes).digest('hex'), exactSceneCount: exactKeys.length,
    galleryConfigured: Boolean(scene.qqUrl) });
}
const groups = census.groups.map(group => ({
  groupKey: group.storyGroupKey, historical: !['active', 'new-player'].includes(group.status),
  imageScenes: group.sceneKeys.filter(key => registry.appImage(key))
}));
const current = groups.filter(group => !group.historical);
const historical = groups.filter(group => group.historical);
const missingGroups = current.filter(group => !group.imageScenes.length).map(group => group.groupKey);
const report = { generatedAt: new Date().toISOString(), images: assets.length, totalBytes,
  currentGroups: current.length, coveredCurrentGroups: current.filter(group => group.imageScenes.length).length,
  historicalGroups: historical.length, coveredHistoricalGroups: historical.filter(group => group.imageScenes.length).length,
  galleryEntries: assets.filter(asset => asset.galleryConfigured).length, missingGroups, groups, assets };
const output = resolve(root, 'artwork/story/review/story-illustrations-verification.json');
await mkdir(resolve(root, 'artwork/story/review'), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ ...report, groups: undefined, assets: undefined, report: output }));
if (process.argv.includes('--require-complete') && missingGroups.length) throw new Error('仍有完整剧情未配图。');
if (process.argv.includes('--require-complete') && report.coveredHistoricalGroups) throw new Error('发布清单仍包含历史或已退出剧情图片。');
if (process.argv.includes('--require-gallery') && report.galleryEntries !== report.images) throw new Error('仍有图片未回填图库地址。');
