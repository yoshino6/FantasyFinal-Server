//#region \0lvy-asset:7
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/training-dummy-front-lSQzV1-o.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };