import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import sharp from 'sharp';

const [source, sceneKey, alt, prompt = '', version = ''] = process.argv.slice(2);
if (!source || !sceneKey || !alt || !/^[a-zA-Z0-9_.-]+$/.test(sceneKey)) {
  throw new Error('Usage: node scripts/save-story-illustration.mjs SOURCE SCENE_KEY ALT [PROMPT]');
}
const base = resolve(import.meta.dirname, '../src/assets/game/story/illustrations');
const manifestPath = resolve(base, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (version && !/^v\d+$/.test(version)) throw new Error('Version must be v2, v3, etc.');
const previous = manifest.scenes.find(scene => scene.sceneKey === sceneKey);
if (previous && !version) throw new Error(`Scene already exists: ${sceneKey}`);
const suffix = version ? `-${version}` : '';
const file = `${sceneKey.replaceAll('.', '-')}${suffix}.webp`;
const webPath = resolve(base, '../../../../../../web/public/assets/story', file);
await mkdir(dirname(webPath), { recursive: true });
await mkdir(resolve(base, 'originals'), { recursive: true });
await mkdir(resolve(base, 'prompts'), { recursive: true });
await copyFile(source, resolve(base, 'originals', `${sceneKey}${suffix}.png`));
const encoded = await sharp(source).resize({ width: 1672, withoutEnlargement: true }).webp({ quality: 88, effort: 6 }).toBuffer({ resolveWithObject: true });
await writeFile(webPath, encoded.data);
await copyFile(webPath, resolve(base, file));
await writeFile(resolve(base, 'prompts', `${sceneKey}${suffix}.txt`), prompt, 'utf8');
const record = { ...previous, sceneKey, file, width: encoded.info.width, height: encoded.info.height, alt,
  original: `server/src/assets/game/story/illustrations/originals/${sceneKey}${suffix}.png` };
delete record.qqUrl;
if (previous) manifest.scenes[manifest.scenes.indexOf(previous)] = record;
else manifest.scenes.push(record);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ sceneKey, webPath, width: encoded.info.width, height: encoded.info.height, bytes: encoded.data.length }));
