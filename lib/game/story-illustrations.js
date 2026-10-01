import { scenes } from "../assets/game/story/illustrations/manifest.js";

//#region src/game/story-illustrations.ts
const validSceneKey = (value) => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,160}$/.test(value);
const publicImageUrl = (value) => {
	if (typeof value !== "string" || /[\u0000-\u001f]/.test(value)) return false;
	try {
		const url = new URL(value);
		return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
	} catch {
		return false;
	}
};
const createStoryIllustrationRegistry = (records) => {
	const entries = /* @__PURE__ */ new Map();
	const groups = /* @__PURE__ */ new Map();
	for (const record of records) {
		if (!validSceneKey(record.sceneKey) || !/^[a-zA-Z0-9_-]+\.(?:png|webp|jpe?g)$/.test(record.file) || !Number.isInteger(record.width) || record.width <= 0 || !Number.isInteger(record.height) || record.height <= 0) throw new Error(`剧情插图记录无效：${record.sceneKey}`);
		const keys = [.../* @__PURE__ */ new Set([record.sceneKey, ...record.sceneKeys ?? []])];
		if (keys.some((key) => !validSceneKey(key))) throw new Error(`剧情插图别名无效：${record.sceneKey}`);
		if (keys.some((key) => entries.has(key))) throw new Error(`剧情插图编号重复：${record.sceneKey}`);
		if (record.groupKey && (!validSceneKey(record.groupKey) || groups.has(record.groupKey))) throw new Error(`剧情插图分组无效或重复：${record.groupKey}`);
		if (record.qqUrl && !publicImageUrl(record.qqUrl)) throw new Error(`剧情插图图库地址无效：${record.sceneKey}`);
		const image = { ...record };
		for (const key of keys) entries.set(key, image);
		if (record.groupKey) groups.set(record.groupKey, image);
	}
	return {
		get: (sceneKey) => entries.get(sceneKey) ?? groups.get(sceneKey),
		appImage: (sceneKey) => {
			const image = entries.get(sceneKey) ?? groups.get(sceneKey);
			return image ? {
				sceneKey,
				path: `/assets/story/${image.file}`,
				width: image.width,
				height: image.height,
				alt: image.alt || "剧情插图"
			} : void 0;
		}
	};
};
const registry = createStoryIllustrationRegistry(scenes);
const storyIllustrationFor = registry.get;
const appStoryIllustrationFor = registry.appImage;
/** The title carries a scene identity through Core's JSON capture, without adding a visible placeholder or a fake QQ URL. */
const addStoryIllustration = (markdown, sceneKey, resolveImage = storyIllustrationFor) => {
	if (!validSceneKey(sceneKey)) return markdown;
	const title = markdown.value.value.find((node) => node.type === "MD.title");
	if (title) title.options = {
		...title.options,
		storySceneKey: sceneKey
	};
	const image = resolveImage(sceneKey);
	if (image?.qqUrl) {
		const width = Math.min(image.width, 640);
		markdown.addImage(image.qqUrl, {
			width,
			height: Math.round(width * image.height / image.width)
		}).addNewline().addNewline();
	}
	return markdown;
};
const storySceneKeyFromFormat = (format) => {
	if (!Array.isArray(format)) return void 0;
	for (const raw of format) {
		if (!raw || typeof raw !== "object") continue;
		const node = raw;
		if (validSceneKey(node.options?.storySceneKey)) return node.options.storySceneKey;
		const nested = storySceneKeyFromFormat(node.value);
		if (nested) return nested;
	}
};
const appStoryIllustrationFromFormat = (format) => {
	const key = storySceneKeyFromFormat(format);
	return key ? appStoryIllustrationFor(key) : void 0;
};

//#endregion
export { addStoryIllustration, appStoryIllustrationFor, appStoryIllustrationFromFormat, createStoryIllustrationRegistry, storyIllustrationFor, storySceneKeyFromFormat };