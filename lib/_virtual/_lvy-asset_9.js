//#region \0lvy-asset:9
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/moonlight-lamp-back-DuqP7CS5.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };