//#region \0lvy-asset:31
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/slime-bed-back-H9QQCYQI.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };