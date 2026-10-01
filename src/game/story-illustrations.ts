import { Format } from 'alemonjs';
import manifest from '../assets/game/story/illustrations/manifest.json';

export type StoryIllustration = {
  sceneKey: string;
  /** One illustration can cover explicitly listed pages of the same complete story. */
  sceneKeys?: string[];
  groupKey?: string;
  file: string;
  width: number;
  height: number;
  qqUrl?: string;
  alt?: string;
};

export type AppStoryIllustration = {
  sceneKey: string;
  path: string;
  width: number;
  height: number;
  alt: string;
};

type FormatNode = { type?: string; value?: unknown; options?: Record<string, unknown> };
const validSceneKey = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,160}$/.test(value);
const publicImageUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || /[\u0000-\u001f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
};

export const createStoryIllustrationRegistry = (records: readonly StoryIllustration[]) => {
  const entries = new Map<string, StoryIllustration>();
  const groups = new Map<string, StoryIllustration>();
  for (const record of records) {
    if (!validSceneKey(record.sceneKey) || !/^[a-zA-Z0-9_-]+\.(?:png|webp|jpe?g)$/.test(record.file)
      || !Number.isInteger(record.width) || record.width <= 0 || !Number.isInteger(record.height) || record.height <= 0) {
      throw new Error(`剧情插图记录无效：${record.sceneKey}`);
    }
    const keys = [...new Set([record.sceneKey, ...(record.sceneKeys ?? [])])];
    if (keys.some(key => !validSceneKey(key))) throw new Error(`剧情插图别名无效：${record.sceneKey}`);
    if (keys.some(key => entries.has(key))) throw new Error(`剧情插图编号重复：${record.sceneKey}`);
    if (record.groupKey && (!validSceneKey(record.groupKey) || groups.has(record.groupKey))) throw new Error(`剧情插图分组无效或重复：${record.groupKey}`);
    if (record.qqUrl && !publicImageUrl(record.qqUrl)) throw new Error(`剧情插图图库地址无效：${record.sceneKey}`);
    const image = { ...record };
    for (const key of keys) entries.set(key, image);
    if (record.groupKey) groups.set(record.groupKey, image);
  }
  return {
    // Group lookup must be explicitly requested; never guess a branch from a
    // route prefix or reveal an unchosen branch's key scene on earlier pages.
    get: (sceneKey: string) => entries.get(sceneKey) ?? groups.get(sceneKey),
    appImage: (sceneKey: string): AppStoryIllustration | undefined => {
      const image = entries.get(sceneKey) ?? groups.get(sceneKey);
      return image ? { sceneKey, path: `/assets/story/${image.file}`, width: image.width, height: image.height, alt: image.alt || '剧情插图' } : undefined;
    }
  };
};

const registry = createStoryIllustrationRegistry(manifest.scenes as StoryIllustration[]);
export const storyIllustrationFor = registry.get;
export const appStoryIllustrationFor = registry.appImage;

/** The title carries a scene identity through Core's JSON capture, without adding a visible placeholder or a fake QQ URL. */
export const addStoryIllustration = (markdown: ReturnType<typeof Format.createMarkdown>, sceneKey: string, resolveImage = storyIllustrationFor) => {
  if (!validSceneKey(sceneKey)) return markdown;
  const title = ((markdown.value as FormatNode).value as FormatNode[]).find(node => node.type === 'MD.title');
  if (title) title.options = { ...title.options, storySceneKey: sceneKey };
  const image = resolveImage(sceneKey);
  if (image?.qqUrl) {
    const width = Math.min(image.width, 640);
    markdown.addImage(image.qqUrl, { width, height: Math.round(width * image.height / image.width) }).addNewline().addNewline();
  }
  return markdown;
};

export const storySceneKeyFromFormat = (format: unknown): string | undefined => {
  if (!Array.isArray(format)) return undefined;
  for (const raw of format) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as FormatNode;
    if (validSceneKey(node.options?.storySceneKey)) return node.options.storySceneKey;
    const nested = storySceneKeyFromFormat(node.value);
    if (nested) return nested;
  }
  return undefined;
};

export const appStoryIllustrationFromFormat = (format: unknown) => {
  const key = storySceneKeyFromFormat(format);
  return key ? appStoryIllustrationFor(key) : undefined;
};
