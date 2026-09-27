//#region \0lvy-asset:3
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/wooden-bed-side-v2-DVGGOmVn.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };