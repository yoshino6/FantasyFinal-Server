//#region \0lvy-asset:22
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/warm-hearth-front-G2vbVNEl.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };