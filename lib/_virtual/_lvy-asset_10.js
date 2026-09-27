//#region \0lvy-asset:10
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/wolfhide-carpet-front-IyzeQPyT.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };