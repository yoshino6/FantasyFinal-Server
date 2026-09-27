//#region \0lvy-asset:14
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/wooden-bed-back-6cAkstly.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };