//#region \0lvy-asset:17
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/floor-2-evening-ChCQWVdX.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };