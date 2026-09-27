//#region \0lvy-asset:1
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/alchemy-shelf-front-Cnc_5HJD.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };