//#region \0lvy-asset:28
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/alchemy-shelf-side-CjTI6Gwn.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };