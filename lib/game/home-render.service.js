import { backfillHomeFloorLayout, furnitureDimensions, roomForHouseLevel } from "./home-layout.service.js";
import { getPool, withTransaction } from "../database/pool.js";
import fileUrl from "../_virtual/_lvy-asset_25.js";
import fileUrl$1 from "../_virtual/_lvy-asset_16.js";
import fileUrl$2 from "../_virtual/_lvy-asset_15.js";
import fileUrl$3 from "../_virtual/_lvy-asset_8.js";
import fileUrl$4 from "../_virtual/_lvy-asset_32.js";
import fileUrl$5 from "../_virtual/_lvy-asset_17.js";
import fileUrl$6 from "../_virtual/_lvy-asset_26.js";
import fileUrl$7 from "../_virtual/_lvy-asset_19.js";
import fileUrl$8 from "../_virtual/_lvy-asset_6.js";
import fileUrl$9 from "../_virtual/_lvy-asset_33.js";
import fileUrl$10 from "../_virtual/_lvy-asset_3.js";
import fileUrl$11 from "../_virtual/_lvy-asset_14.js";
import fileUrl$12 from "../_virtual/_lvy-asset_4.js";
import fileUrl$13 from "../_virtual/_lvy-asset_18.js";
import fileUrl$14 from "../_virtual/_lvy-asset_31.js";
import fileUrl$15 from "../_virtual/_lvy-asset_27.js";
import fileUrl$16 from "../_virtual/_lvy-asset_11.js";
import fileUrl$17 from "../_virtual/_lvy-asset_12.js";
import fileUrl$18 from "../_virtual/_lvy-asset_7.js";
import fileUrl$19 from "../_virtual/_lvy-asset_20.js";
import fileUrl$20 from "../_virtual/_lvy-asset_21.js";
import fileUrl$21 from "../_virtual/_lvy-asset_22.js";
import fileUrl$22 from "../_virtual/_lvy-asset_2.js";
import fileUrl$23 from "../_virtual/_lvy-asset_5.js";
import fileUrl$24 from "../_virtual/_lvy-asset_10.js";
import fileUrl$25 from "../_virtual/_lvy-asset_23.js";
import fileUrl$26 from "../_virtual/_lvy-asset_13.js";
import fileUrl$27 from "../_virtual/_lvy-asset_1.js";
import fileUrl$28 from "../_virtual/_lvy-asset_28.js";
import fileUrl$29 from "../_virtual/_lvy-asset_24.js";
import fileUrl$30 from "../_virtual/_lvy-asset_29.js";
import fileUrl$31 from "../_virtual/_lvy-asset_30.js";
import fileUrl$32 from "../_virtual/_lvy-asset_9.js";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

//#region src/game/home-render.service.ts
const HOME_ASSET_VERSION = "cozy-pixel-home-v13-furniture-render-insets";
const assetPath = (asset) => decodeURIComponent(asset).replace(/^([a-zA-Z]):(?![\\/])/, "$1:\\");
const backgrounds = {
	1: {
		morning: assetPath(fileUrl),
		noon: assetPath(fileUrl$1),
		evening: assetPath(fileUrl$2)
	},
	2: {
		morning: assetPath(fileUrl$3),
		noon: assetPath(fileUrl$4),
		evening: assetPath(fileUrl$5)
	},
	3: {
		morning: assetPath(fileUrl$6),
		noon: assetPath(fileUrl$7),
		evening: assetPath(fileUrl$8)
	}
};
const directionalAssets = (front, side, back) => ({
	front: assetPath(front),
	side: assetPath(side),
	back: assetPath(back)
});
const furnitureAssets = {
	wooden_bed: directionalAssets(fileUrl$9, fileUrl$10, fileUrl$11),
	slime_bed: directionalAssets(fileUrl$12, fileUrl$13, fileUrl$14),
	storage_chest: directionalAssets(fileUrl$15, fileUrl$16, fileUrl$17),
	training_dummy: directionalAssets(fileUrl$18, fileUrl$19, fileUrl$20),
	warm_hearth: directionalAssets(fileUrl$21, fileUrl$22, fileUrl$23),
	wolfhide_carpet: directionalAssets(fileUrl$24, fileUrl$25, fileUrl$26),
	alchemy_shelf: directionalAssets(fileUrl$27, fileUrl$28, fileUrl$29),
	moonlight_lamp: directionalAssets(fileUrl$30, fileUrl$31, fileUrl$32)
};
const cachePathFor = (homeId, floor, hash) => resolve(process.cwd(), ".data", "qq-bot", "home-renders", String(homeId), `${floor}-${hash}.webp`);
const shadowSvg = (width, height) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><filter id="blur"><feGaussianBlur stdDeviation="${Math.max(1, Math.min(width, height) * .025)}"/></filter></defs><ellipse cx="${width / 2}" cy="${height * .86}" rx="${Math.max(3, width * .32)}" ry="${Math.max(2, height * .07)}" fill="#3b2215" opacity=".2" filter="url(#blur)"/></svg>`);
const furnitureAssetFor = (code, rotation) => {
	const assets = furnitureAssets[code];
	if (!assets) return null;
	const edgeCleanup = code === "storage_chest" ? "detached" : "none";
	const insetRatio = code === "wooden_bed" && (rotation === 90 || rotation === 270) ? .052 : 0;
	const drawShadow = ![
		"wooden_bed",
		"slime_bed",
		"storage_chest",
		"warm_hearth",
		"alchemy_shelf"
	].includes(code);
	if (rotation === 90) return {
		asset: assets.side,
		mirror: false,
		edgeCleanup,
		insetRatio,
		drawShadow
	};
	if (rotation === 180) return {
		asset: assets.back,
		mirror: false,
		edgeCleanup,
		insetRatio,
		drawShadow
	};
	if (rotation === 270) return {
		asset: assets.side,
		mirror: true,
		edgeCleanup,
		insetRatio,
		drawShadow
	};
	return {
		asset: assets.front,
		mirror: false,
		edgeCleanup,
		insetRatio,
		drawShadow
	};
};
const cleanFurnitureAsset = async (asset, width, height, mirror, edgeCleanup, insetRatio) => {
	let source = sharp(await readFile(asset));
	if (mirror) source = source.flop();
	const insetX = Math.round(width * insetRatio);
	const insetY = Math.round(height * insetRatio * .75);
	const innerWidth = Math.max(1, width - insetX * 2);
	const innerHeight = Math.max(1, height - insetY * 2);
	const resized = await source.resize(innerWidth, innerHeight, {
		fit: "contain",
		withoutEnlargement: false,
		background: {
			r: 0,
			g: 0,
			b: 0,
			alpha: 0
		}
	}).ensureAlpha().png().toBuffer();
	const rendered = await sharp({ create: {
		width,
		height,
		channels: 4,
		background: {
			r: 0,
			g: 0,
			b: 0,
			alpha: 0
		}
	} }).composite([{
		input: resized,
		left: insetX,
		top: insetY
	}]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const pixels = rendered.data;
	const channels = rendered.info.channels;
	const alphaAt = (x, y) => pixels[(y * width + x) * channels + 3];
	const clearColumn = (x) => {
		for (let y = 0; y < height; y++) pixels[(y * width + x) * channels + 3] = 0;
	};
	const clearRow = (y) => {
		for (let x = 0; x < width; x++) pixels[(y * width + x) * channels + 3] = 0;
	};
	const edgeColumns = Math.max(1, Math.ceil(width * .15));
	const edgeRows = Math.max(1, Math.ceil(height * .15));
	for (let x = 0; x < width; x++) {
		if (x >= edgeColumns && x < width - edgeColumns) continue;
		let visible = 0;
		for (let y = 0; y < height; y++) if (alphaAt(x, y) > 32) visible++;
		if (visible >= height * .9) clearColumn(x);
	}
	for (let y = 0; y < height; y++) {
		if (y >= edgeRows && y < height - edgeRows) continue;
		let visible = 0;
		for (let x = 0; x < width; x++) if (alphaAt(x, y) > 32) visible++;
		if (visible >= width * .9) clearRow(y);
	}
	if (edgeCleanup !== "none") {
		const visibleColumns = Array.from({ length: width }, (_, x) => {
			let visible = 0;
			for (let y = 0; y < height; y++) if (alphaAt(x, y) > 32) visible++;
			return visible;
		});
		const runs = [];
		for (let x = 0; x < width;) {
			if (visibleColumns[x] === 0) {
				x++;
				continue;
			}
			const start = x;
			while (x + 1 < width && visibleColumns[x + 1] > 0) x++;
			runs.push({
				start,
				end: x
			});
			x++;
		}
		const body = runs.sort((a, b) => b.end - b.start - (a.end - a.start))[0];
		if (body) {
			if (edgeCleanup === "detached") {
				for (let x = 0; x < body.start; x++) clearColumn(x);
				for (let x = body.end + 1; x < width; x++) clearColumn(x);
			}
		}
	}
	return sharp(pixels, { raw: {
		width,
		height,
		channels
	} }).png().toBuffer();
};
const floorLabelSvg = (size, floor, level) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect x="18" y="18" width="164" height="39" rx="19" fill="#4d2d1c" opacity=".72"/><text x="100" y="44" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="19" font-weight="bold" fill="#fff5dd">第 ${floor} 层 · 小屋 Lv.${level}</text></svg>`);
const homePeriod = () => {
	const hour = Number(new Intl.DateTimeFormat("en-GB", {
		timeZone: "Asia/Shanghai",
		hour: "2-digit",
		hourCycle: "h23"
	}).format(/* @__PURE__ */ new Date()));
	if (hour >= 5 && hour < 11) return "morning";
	if (hour >= 11 && hour < 17) return "noon";
	return "evening";
};
const backgroundForFloor = (floor, period) => backgrounds[floor]?.[period] ?? backgrounds[1][period];
const homeFloorImage = async (qqUserId, floor) => {
	if (!Number.isInteger(floor) || floor < 1 || floor > 3) throw new Error("楼层不存在。");
	const home = await withTransaction(async (connection) => {
		const [rows] = await connection.execute(`SELECT h.id,h.house_level,h.floor_count FROM player_homes h
      JOIN characters c ON c.id=h.character_id JOIN players p ON p.id=c.player_id
      WHERE p.qq_user_id=? AND h.status='active' LIMIT 1 FOR UPDATE`, [qqUserId]);
		const current = rows[0];
		if (!current) throw new Error("你还没有小屋。");
		if (floor > Number(current.floor_count)) throw new Error(`第 ${floor} 层尚未扩建。`);
		await backfillHomeFloorLayout(connection, Number(current.id), floor, Number(current.house_level));
		return current;
	});
	const pool = await getPool();
	const [furnitureRows] = await pool.execute(`SELECT f.id,f.furniture_code,d.name,f.floor_no,f.grid_x,f.grid_y,f.rotation,d.grid_width,d.grid_height,d.layer_order
    FROM player_home_furniture f JOIN home_furniture_definitions d ON d.code=f.furniture_code
    WHERE f.home_id=? AND f.floor_no=? AND f.grid_x IS NOT NULL AND f.grid_y IS NOT NULL
    ORDER BY d.layer_order,f.grid_y,f.grid_x,f.id`, [home.id, floor]);
	const room = roomForHouseLevel(Number(home.house_level));
	const period = homePeriod();
	const layoutHash = createHash("sha256").update(JSON.stringify({
		asset: HOME_ASSET_VERSION,
		home: Number(home.id),
		floor,
		period,
		level: Number(home.house_level),
		furniture: furnitureRows.map((item) => [
			item.id,
			item.furniture_code,
			item.grid_x,
			item.grid_y,
			item.grid_width,
			item.grid_height,
			item.rotation,
			item.layer_order
		])
	})).digest("hex");
	const [cached] = await pool.execute("SELECT layout_hash,image_path FROM player_home_floor_renders WHERE home_id=? AND floor_no=? LIMIT 1", [home.id, floor]);
	const cache = cached[0];
	if (cache?.layout_hash === layoutHash) try {
		await access(cache.image_path);
		return {
			image: await readFile(cache.image_path),
			floor,
			level: Number(home.house_level),
			furniture: furnitureRows,
			cached: true
		};
	} catch {}
	const size = room.canvasPixels;
	const background = await readFile(backgroundForFloor(floor, period));
	const resizedBackground = await sharp(background).resize(size, size, { fit: "fill" }).png().toBuffer();
	const composites = [];
	for (const item of furnitureRows) {
		const rotation = [
			0,
			90,
			180,
			270
		].includes(Number(item.rotation)) ? Number(item.rotation) : 0;
		const selectedAsset = furnitureAssetFor(item.furniture_code, rotation);
		if (!selectedAsset) continue;
		const footprint = furnitureDimensions(Number(item.grid_width), Number(item.grid_height), rotation);
		const left = Math.round(room.floorLeft + Number(item.grid_x) * room.cellWidth);
		const top = Math.round(room.floorTop + Number(item.grid_y) * room.cellHeight);
		const right = Math.round(room.floorLeft + (Number(item.grid_x) + footprint.width) * room.cellWidth);
		const bottom = Math.round(room.floorTop + (Number(item.grid_y) + footprint.height) * room.cellHeight);
		const width = Math.max(1, right - left);
		const height = Math.max(1, bottom - top);
		const wallBleedX = Math.round(room.cellWidth * .18);
		const wallBleedY = Math.round(room.cellHeight * .18);
		const renderLeft = Number(item.grid_x) === 0 ? left - wallBleedX : Number(item.grid_x) + footprint.width === room.columns ? left + wallBleedX : left;
		const renderTop = Number(item.grid_y) === 0 ? top - wallBleedY : top;
		if (selectedAsset.drawShadow) composites.push({
			input: shadowSvg(width, height),
			left: renderLeft,
			top: renderTop
		});
		composites.push({
			input: await cleanFurnitureAsset(selectedAsset.asset, width, height, selectedAsset.mirror, selectedAsset.edgeCleanup, selectedAsset.insetRatio),
			left: renderLeft,
			top: renderTop
		});
	}
	const frontWallTop = Math.max(0, Math.round(room.floorBottom - size * .016));
	composites.push({
		input: await sharp(resizedBackground).extract({
			left: 0,
			top: frontWallTop,
			width: size,
			height: size - frontWallTop
		}).png().toBuffer(),
		left: 0,
		top: frontWallTop
	});
	composites.push({
		input: floorLabelSvg(size, floor, Number(home.house_level)),
		left: 0,
		top: 0
	});
	const image = await sharp(resizedBackground).composite(composites).webp({
		quality: 82,
		effort: 4
	}).toBuffer();
	const imagePath = cachePathFor(Number(home.id), floor, layoutHash);
	await mkdir(dirname(imagePath), { recursive: true });
	await writeFile(imagePath, image);
	await pool.execute(`INSERT INTO player_home_floor_renders (home_id,floor_no,layout_hash,image_path) VALUES (?,?,?,?)
    ON DUPLICATE KEY UPDATE layout_hash=VALUES(layout_hash),image_path=VALUES(image_path),rendered_at=NOW()`, [
		home.id,
		floor,
		layoutHash,
		imagePath
	]);
	return {
		image,
		floor,
		level: Number(home.house_level),
		furniture: furnitureRows,
		cached: false
	};
};

//#endregion
export { homeFloorImage };