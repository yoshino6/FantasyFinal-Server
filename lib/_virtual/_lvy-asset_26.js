//#region \0lvy-asset:26
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/floor-3-morning-De-qRY1E.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };