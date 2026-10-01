import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export type StoryImageSource = {
  sceneKey: string;
  file: string;
  qqUrl?: string;
  alt?: string;
  width?: number;
  height?: number;
};
export type StoryImageManifest = { version: 1; scenes: StoryImageSource[] };
type UploadReceipt = { sha256: string; url: string; width: number; height: number; uploadedAt: string; verifiedAt?: string };
type UploadReceipts = { version: 1; images: Record<string, UploadReceipt> };

const serverDirectory = fileURLToPath(new URL('..', import.meta.url));
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export const validateStoryImageManifest = (value: unknown): StoryImageManifest => {
  const manifest = value as StoryImageManifest | null;
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.scenes)) {
    throw new Error('剧情图片清单必须为 { version: 1, scenes: [...] }。');
  }
  const keys = new Set<string>();
  for (const image of manifest.scenes) {
    if (!image || !/^[a-zA-Z0-9_.-]{1,160}$/.test(image.sceneKey)) throw new Error('剧情图片 sceneKey 无效。');
    if (keys.has(image.sceneKey)) throw new Error(`剧情图片 sceneKey 重复：${image.sceneKey}`);
    keys.add(image.sceneKey);
    if (typeof image.file !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.webp$/.test(image.file)) {
      throw new Error(`剧情图片 ${image.sceneKey} 必须指定 WebP 文件名。`);
    }
    for (const dimension of ['width', 'height'] as const) {
      if (image[dimension] !== undefined && (!Number.isInteger(image[dimension]) || image[dimension]! <= 0)) {
        throw new Error(`剧情图片 ${image.sceneKey} 的 ${dimension} 无效。`);
      }
    }
  }
  return manifest;
};

export const mergeStoryImageUrl = (manifest: StoryImageManifest, sceneKey: string, url: string): StoryImageManifest => {
  const scene = manifest.scenes.find(image => image.sceneKey === sceneKey);
  if (!scene) throw new Error(`当前清单中没有剧情图片：${sceneKey}`);
  return { ...manifest, scenes: manifest.scenes.map(image => image.sceneKey === sceneKey ? { ...image, qqUrl: verifiedImageUrl(url) } : image) };
};

export const mergeStoryImageBatch = (current: StoryImageManifest, incoming: StoryImageManifest): StoryImageManifest => {
  validateStoryImageManifest(current);
  validateStoryImageManifest(incoming);
  const scenes = new Map(current.scenes.map(scene => [scene.sceneKey, scene]));
  for (const scene of incoming.scenes) {
    const previous = scenes.get(scene.sceneKey);
    const merged = { ...previous, ...scene };
    // 重绘文件变化时，不让新网页图误搭配旧 QQ 图。
    if (previous && previous.file !== scene.file && !scene.qqUrl) delete merged.qqUrl;
    scenes.set(scene.sceneKey, merged);
  }
  return { ...current, scenes: [...scenes.values()] };
};

export const verifiedImageUrl = (value: string) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('图库必须返回公开 HTTPS 图片地址。');
  return url.href;
};

const readJson = async <T>(path: string, fallback?: T): Promise<T> => {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`不能读取 JSON 文件：${path}`);
  }
};
const atomicJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(temporary, path);
};

export const withStoryManifestLock = async <T>(manifestPath: string, update: () => Promise<T>): Promise<T> => {
  const lockPath = `${manifestPath}.lock`;
  await mkdir(dirname(manifestPath), { recursive: true });
  const deadline = Date.now() + 20_000;
  let lock: Awaited<ReturnType<typeof open>>;
  for (;;) {
    try { lock = await open(lockPath, 'wx'); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('剧情图清单正在写入；若进程已退出，请检查 manifest.json.lock 后重试。');
      await new Promise<void>(accept => setTimeout(accept, 50));
    }
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await update();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
};

export const verifyPublicStoryImage = async (address: string) => {
  let url = verifiedImageUrl(address);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(url, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20_000),
      headers: { Range: 'bytes=0-63', Accept: 'image/webp,image/*' }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects === 3) throw new Error('图片公开地址重定向无效。');
      url = verifiedImageUrl(new URL(location, url).href);
      continue;
    }
    if (![200, 206].includes(response.status) || !response.headers.get('content-type')?.toLowerCase().startsWith('image/')) {
      await response.body?.cancel();
      throw new Error('图库地址不能公开读取图片。');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('图库地址返回空图片。');
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (size < 12) {
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(Buffer.from(chunk.value));
        size += chunk.value.byteLength;
      }
    } finally { await reader.cancel(); }
    const bytes = Buffer.concat(chunks);
    if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') {
      throw new Error('图库公开地址返回的内容不是上传的 WebP 图片。');
    }
    return;
  }
};

const option = (args: string[], name: string, fallback: string) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error(`${name} 缺少值。`);
  return args[index + 1]!;
};

export const main = async (args: string[]) => {
  if (args.includes('--help')) {
    console.log('用法：node --import tsx scripts/upload-story-images.ts --check');
    console.log('检查：node --import tsx scripts/upload-story-images.ts --manifest src/assets/game/story/illustrations/manifest.json');
    console.log('上传：node --import tsx scripts/upload-story-images.ts --upload');
    console.log('合并：node --import tsx scripts/upload-story-images.ts --merge-batch <批次清单JSON>');
    console.log('可选：--config <YAML> --asset-dir <WebP目录> --receipts <断点记录> --scene <sceneKey> --verify（重新检查已上传图的公开地址）');
    return;
  }
  const manifestPath = resolve(option(args, '--manifest', resolve(serverDirectory, 'src/assets/game/story/illustrations/manifest.json')));
  if (args.includes('--merge-batch')) {
    const batchPath = resolve(option(args, '--merge-batch', ''));
    const batch = validateStoryImageManifest(await readJson(batchPath));
    await withStoryManifestLock(manifestPath, async () => {
      const current = validateStoryImageManifest(await readJson(manifestPath, { version: 1, scenes: [] }));
      const merged = mergeStoryImageBatch(current, batch);
      await atomicJson(manifestPath, merged);
      console.log(JSON.stringify({ status: 'merged', incoming: batch.scenes.length, total: merged.scenes.length, manifest: manifestPath }));
    });
    return;
  }
  const configPath = resolve(option(args, '--config', process.env.FANTASYFINAL_SERVER_CONFIG || resolve(serverDirectory, 'alemon.config.yaml')));
  process.env.CFG_PATH = configPath;
  // 仅恢复当前上传进程的 TLS 校验，不修改用户环境或配置文件。
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
  const { portraitHostConfig, uploadPortraitToHost } = await import('../src/game/automaton-portrait-host');
  const config = portraitHostConfig();
  console.log(JSON.stringify({ provider: config.provider, uploadHost: new URL(config.url).host, credentialsConfigured: Boolean(config.token) }));
  if (args.includes('--check') && !args.includes('--manifest')) return;

  const assetDirectory = resolve(option(args, '--asset-dir', resolve(serverDirectory, '../web/public/assets/story')));
  const receiptPath = resolve(option(args, '--receipts', resolve(dirname(manifestPath), 'upload-receipts.json')));
  const manifest = validateStoryImageManifest(await readJson(manifestPath));
  const selectedKey = option(args, '--scene', '');
  const selectedScenes = selectedKey ? manifest.scenes.filter(image => image.sceneKey === selectedKey) : manifest.scenes;
  if (selectedKey && selectedScenes.length === 0) throw new Error('清单中没有指定的剧情图片。');
  const receipts = await readJson<UploadReceipts>(receiptPath, { version: 1, images: {} });
  if (receipts.version !== 1 || !receipts.images || typeof receipts.images !== 'object') throw new Error('图库上传断点文件无效。');
  const shouldUpload = args.includes('--upload');
  const failures: string[] = [];
  let uploaded = 0, reused = 0, pending = 0;

  for (const image of selectedScenes) {
    try {
      const data = await readFile(resolve(assetDirectory, image.file));
      if (data.length === 0 || data.length > 2 * 1024 * 1024) throw new Error('WebP 文件必须在 2 MiB 以内。');
      const metadata = await sharp(data, { limitInputPixels: 25_000_000, failOn: 'error' }).metadata();
      if (metadata.format !== 'webp' || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height) {
        throw new Error('必须为有效的静态 WebP 图片。');
      }
      if ((image.width && image.width !== metadata.width) || (image.height && image.height !== metadata.height)) {
        throw new Error('清单尺寸与实际图片不一致。');
      }
      const hash = sha256(data);
      const saved = receipts.images[image.sceneKey];
      let receipt = saved?.sha256 === hash ? saved : Object.values(receipts.images).find(value => value.sha256 === hash);
      if (receipt) {
        verifiedImageUrl(receipt.url);
        if (args.includes('--verify') || !receipt.verifiedAt) {
          await verifyPublicStoryImage(receipt.url);
          receipt = { ...receipt, verifiedAt: new Date().toISOString() };
        }
        reused++;
      } else if (shouldUpload) {
        const url = await uploadPortraitToHost(data, `${hash.slice(0, 32)}.webp`);
        // 先记录上传结果，再检查公网读取，避免网络中断后重复上传。
        receipt = { sha256: hash, url, width: metadata.width, height: metadata.height, uploadedAt: new Date().toISOString() };
        receipts.images[image.sceneKey] = receipt;
        await atomicJson(receiptPath, receipts);
        await verifyPublicStoryImage(url);
        receipt.verifiedAt = new Date().toISOString();
        uploaded++;
      } else {
        pending++;
        console.log(JSON.stringify({ sceneKey: image.sceneKey, bytes: data.length, width: metadata.width, height: metadata.height, status: 'pending-upload' }));
        continue;
      }
      receipts.images[image.sceneKey] = receipt;
      if (shouldUpload) {
        await atomicJson(receiptPath, receipts);
        // 重新读取当前清单，保留生成阶段追加的场景和服装/人物说明。
        await withStoryManifestLock(manifestPath, async () => {
          const existing = validateStoryImageManifest(await readJson(manifestPath));
          const currentScene = existing.scenes.find(scene => scene.sceneKey === image.sceneKey);
          if (!currentScene || currentScene.file !== image.file) {
            throw new Error('上传期间清单图片已重绘，请为新版本重新上传。');
          }
          await atomicJson(manifestPath, mergeStoryImageUrl(existing, image.sceneKey, receipt.url));
        });
      }
      console.log(JSON.stringify({ sceneKey: image.sceneKey, status: saved?.sha256 === hash ? 'reused' : 'ready', publicHost: new URL(receipt.url).host }));
    } catch (error) {
      failures.push(image.sceneKey);
      // fetch 错误可能包含配置/凭据；仅输出本工具定义的本地诊断。
      const detail = error instanceof Error && /WebP|清单尺寸|静态|图库地址|公开地址|图片公开|图库公开|返回空|清单图片已重绘|清单正在写入/.test(error.message) ? error.message : '读取、上传或图片公开访问失败；检查文件和图库配置后重试。';
      console.error(JSON.stringify({ sceneKey: image.sceneKey, status: 'failed', message: detail }));
    }
  }
  console.log(JSON.stringify({ total: selectedScenes.length, uploaded, reused, pending, failed: failures.length, failures, manifest: shouldUpload ? manifestPath : null }));
  if (failures.length) throw new Error('部分剧情图未上传成功，重试时会复用已保存的图片。');
};

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(() => process.exit(0), () => {
    console.error('剧情图上传工具未完成，请检查上面的诊断信息。');
    process.exit(1);
  });
}
