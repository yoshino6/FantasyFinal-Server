import { downloadPortrait, normalizePortrait, portraitMaxBytes, removePortrait, writePortrait } from "./automaton-portrait-image.js";
import { retryPortraitUpload, submitPortraitReview } from "./automaton-portrait.service.js";
import { logger } from "alemonjs";
import { randomBytes } from "node:crypto";

//#region src/game/automaton-portrait-upload.ts
const cleanupPortrait = async (key) => {
	if (!key) return;
	try {
		await removePortrait(key);
	} catch (error) {
		logger.warn({ err: error }, "机巧旧形象文件清理失败");
	}
};
const acceptPortraitImage = async (user, upload, media) => {
	let savedKey;
	try {
		if (media.length !== 1) throw new Error("请一次只发送一张图片。");
		const item = media[0];
		if (!(item.Type === "image" || item.MimeType?.startsWith("image/")) || !item.Url) throw new Error("请直接发送一张静态 JPG、PNG 或 WebP 图片。");
		if (Number(item.FileSize) > 5242880) throw new Error("图片不能超过 5 MB。");
		const image = await normalizePortrait(await downloadPortrait(item.Url));
		const key = randomBytes(16).toString("hex") + ".webp";
		await writePortrait(key, image.data);
		savedKey = key;
		const result = await submitPortraitReview(user, upload, {
			key,
			width: image.width,
			height: image.height
		});
		savedKey = void 0;
		return {
			name: result.name,
			id: upload.id
		};
	} catch (error) {
		await cleanupPortrait(savedKey);
		try {
			await retryPortraitUpload(upload);
		} catch (retryError) {
			logger.warn({ err: retryError }, "机巧图片上传等待状态恢复失败");
		}
		throw error;
	}
};

//#endregion
export { acceptPortraitImage, cleanupPortrait };