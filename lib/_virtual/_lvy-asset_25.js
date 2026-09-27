//#region \0lvy-asset:25
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/floor-1-morning-wDYMLduM.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };