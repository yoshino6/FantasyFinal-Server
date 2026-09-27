//#region src/config/admin.ts
/**
* 主人密码配置。
* 修改为仅自己知道的密码，重启机器人后生效；通过“管理员登录 密码”可获得主人权限。
*/
const OWNER_PASSWORD = "afshun666666";
const unconfiguredPassword = ["请在这里", "设置主人密码"].join("");
const verifyOwnerPassword = (password) => {
	const configured = OWNER_PASSWORD.trim();
	if (configured === unconfiguredPassword) throw new Error("尚未在 src/config/admin.ts 配置主人密码。");
	return password === configured;
};

//#endregion
export { OWNER_PASSWORD, verifyOwnerPassword };