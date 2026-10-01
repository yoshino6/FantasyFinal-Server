//#region \0lvy-asset:35
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/system-status-background-DztjYQYw.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };