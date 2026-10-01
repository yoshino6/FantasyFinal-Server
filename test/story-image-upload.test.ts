import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeStoryImageBatch, mergeStoryImageUrl, validateStoryImageManifest, verifyPublicStoryImage, withStoryManifestLock } from '../scripts/upload-story-images';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const scene = { sceneKey: 'opening.F01.A.branch.2', file: 'opening-F01-A-branch-2.webp', width: 1672, height: 941, alt: '原有说明' };

test('upload manifests reject duplicate scenes and path traversal before uploading', () => {
  assert.equal(validateStoryImageManifest({ version: 1, scenes: [scene] }).scenes.length, 1);
  assert.throws(() => validateStoryImageManifest({ version: 1, scenes: [scene, scene] }), /重复/);
  assert.throws(() => validateStoryImageManifest({ version: 1, scenes: [{ ...scene, file: '../outside.webp' }] }), /WebP 文件名/);
});

test('URL merge preserves freshly added scenes, NPC notes, and existing dimensions', () => {
  const second = { ...scene, sceneKey: 'forest.first', file: 'forest-first.webp' };
  const manifest = { version: 1 as const, scenes: [scene, second] };
  const merged = mergeStoryImageUrl(manifest, scene.sceneKey, 'https://images.example/story.webp');
  assert.equal(merged.scenes.length, 2);
  assert.deepEqual(merged.scenes[1], second);
  assert.deepEqual(merged.scenes[0], { ...scene, qqUrl: 'https://images.example/story.webp' });
  assert.throws(() => mergeStoryImageUrl(manifest, scene.sceneKey, 'http://images.example/story.webp'), /HTTPS/);
});

test('public URL verification rejects HTML and accepts real WebP headers', async context => {
  context.mock.method(globalThis, 'fetch', async () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(verifyPublicStoryImage('https://images.example/story.webp'), /不能公开读取/);
  context.mock.restoreAll();
  context.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('RIFF0000WEBP'), { status: 206, headers: { 'content-type': 'image/webp' } }));
  await verifyPublicStoryImage('https://images.example/story.webp');
});

test('batch merge keeps unrelated scenes and clears QQ URL when the file is redrawn', () => {
  const previous = { ...scene, qqUrl: 'https://images.example/old.webp' };
  const second = { ...scene, sceneKey: 'forest.first', file: 'forest-first.webp' };
  const merged = mergeStoryImageBatch({ version: 1, scenes: [previous, second] }, {
    version: 1, scenes: [{ ...scene, file: 'opening-F01-A-branch-2-v3.webp' }]
  });
  assert.equal(merged.scenes.length, 2);
  assert.equal(merged.scenes[0]?.qqUrl, undefined);
  assert.deepEqual(merged.scenes[1], second);
});

test('manifest locks serialize competing writes and leave no stale lock on completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ff-story-lock-'));
  try {
    const manifest = join(directory, 'manifest.json');
    const completed: number[] = [];
    await Promise.all([1, 2, 3].map(value => withStoryManifestLock(manifest, async () => {
      const before = completed.length;
      await new Promise<void>(accept => setTimeout(accept, 20));
      assert.equal(completed.length, before);
      completed.push(value);
    })));
    assert.equal(completed.length, 3);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(basename(directory), /^ff-story-lock-/);
    await rm(directory, { recursive: true, force: true });
  }
});
