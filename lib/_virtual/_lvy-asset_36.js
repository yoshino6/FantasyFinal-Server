//#region \0lvy-asset:36
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/adventurer-card-background-DNkAmUVY.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };