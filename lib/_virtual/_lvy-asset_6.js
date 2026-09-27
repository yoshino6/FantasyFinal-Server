//#region \0lvy-asset:6
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/floor-3-evening-BxlFT75u.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };