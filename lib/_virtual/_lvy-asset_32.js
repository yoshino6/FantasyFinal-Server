//#region \0lvy-asset:32
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/floor-2-noon-glS1R9T3.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };