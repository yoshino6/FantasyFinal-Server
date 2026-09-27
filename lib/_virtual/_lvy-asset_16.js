//#region \0lvy-asset:16
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/floor-1-noon-txvRovDT.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };