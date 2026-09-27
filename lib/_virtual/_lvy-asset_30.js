//#region \0lvy-asset:30
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/moonlight-lamp-side-mesGT4uy.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };