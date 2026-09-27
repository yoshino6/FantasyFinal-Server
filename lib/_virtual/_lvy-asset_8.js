//#region \0lvy-asset:8
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/floor-2-morning-Bumr8eM5.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };