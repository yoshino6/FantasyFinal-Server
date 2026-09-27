//#region \0lvy-asset:15
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/floor-1-evening-C3is365K.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };