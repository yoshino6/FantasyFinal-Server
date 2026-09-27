//#region \0lvy-asset:27
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/storage-chest-front-CWQ8H7DO.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };