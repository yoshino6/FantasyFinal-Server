//#region \0lvy-asset:11
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/storage-chest-side-BFTpENNk.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };