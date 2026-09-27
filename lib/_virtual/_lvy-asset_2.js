//#region \0lvy-asset:2
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/warm-hearth-side-CEvhp1H0.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };