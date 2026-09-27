//#region \0lvy-asset:21
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/training-dummy-back-DI9qwvxX.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };