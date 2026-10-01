import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = path.join(repo, 'server/src/assets/game/story/illustrations');
const [source, groupKey, promptFile, version = ''] = process.argv.slice(2);
if (!source || !groupKey || !promptFile) throw new Error('source groupKey promptFile required');
const census = JSON.parse(await fs.readFile(path.join(base, 'census.json'), 'utf8'));
let group = census.groups.find(g => g.storyGroupKey === groupKey);
const legacy = groupKey.startsWith('lamplight.historical.');
if (legacy) {
  const audit = JSON.parse(await fs.readFile(path.join(base, 'legacy-reuse-audit.json'), 'utf8'));
  const item = audit.pending.find(g => g.illustrationGroupKey === groupKey);
  if (item) group = { recommendedSceneKey: item.sceneKeys[0], displaySceneKeys: item.sceneKeys, recommendedScene: item.sourceScenes[0] };
}
if (!group) throw new Error(`Unknown group ${groupKey}`);
const batchFile = path.join(base, legacy ? 'batch-legacy.json' : 'batch-lamplight.json');
let batch = { schemaVersion: 1, illustrations: [] };
try { batch = JSON.parse(await fs.readFile(batchFile, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
const existing = batch.illustrations.findIndex(item => item.groupKey === groupKey);
if (existing >= 0 && !version) throw new Error(`Already saved ${groupKey}; use explicit version to preserve originals`);
const name = groupKey.replaceAll('.', '-') + (version ? `-${version}` : '');
const pngDir = path.join(repo, 'artwork/story');
const webDir = path.join(repo, 'web/public/assets/story');
const promptsDir = path.join(base, 'prompts');
await Promise.all([fs.mkdir(pngDir, { recursive: true }), fs.mkdir(webDir, { recursive: true }), fs.mkdir(promptsDir, { recursive: true })]);
const png = path.join(pngDir, `${name}.png`);
try { await fs.access(png); throw new Error(`Version already exists ${png}`); } catch (err) { if (err.code !== 'ENOENT') throw err; }
await fs.copyFile(source, png);
const image = await sharp(source).resize({ width: 1672, withoutEnlargement: true }).webp({ quality: 88, effort: 6 }).toBuffer();
await Promise.all([fs.writeFile(path.join(base, `${name}.webp`), image), fs.writeFile(path.join(webDir, `${name}.webp`), image)]);
const prompt = await fs.readFile(promptFile, 'utf8');
await fs.writeFile(path.join(promptsDir, `${name}.txt`), prompt, 'utf8');
const metadata = await sharp(image).metadata();
const entry = { sceneKey: group.recommendedSceneKey, groupKey, sceneKeys: group.displaySceneKeys, file: `${name}.webp`, alt: group.recommendedScene.title, width: metadata.width, height: metadata.height, original: `artwork/story/${name}.png`, prompt: `prompts/${name}.txt`, styleVersion: 'bright-2d-cel-anime' };
if (existing >= 0) batch.illustrations[existing] = entry;
else batch.illustrations.push(entry);
batch.reviewStatus = 'generation-in-progress';
batch.note = 'New bright 2D cel anime assets only. Previous versions remain on disk as identity reference; main manifest is managed by root.';
await fs.writeFile(batchFile, `${JSON.stringify(batch, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ png, file: entry.file, groupKey, count: batch.illustrations.length, width: metadata.width, height: metadata.height }));
