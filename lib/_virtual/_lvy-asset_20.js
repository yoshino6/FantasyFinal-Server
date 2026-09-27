//#region \0lvy-asset:20
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/training-dummy-side-DBg2a63M.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };