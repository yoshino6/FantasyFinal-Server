import { start } from 'alemonjs';

// 游戏本体独立后端入口：固定以 login=server 启动。
// @alemonjs/server 只是本地占位平台，不建立 QQ 连接；游戏本体仍提供
// 桌宠、网页 API、管理后台和 Core API。
const serverConfig = process.env.FANTASYFINAL_SERVER_CONFIG ?? process.env.FANTASYFINAL_CORE_CONFIG;
if (serverConfig) process.env.CFG_PATH = serverConfig;
const port = process.env.FANTASYFINAL_SERVER_PORT
  ? Number(process.env.FANTASYFINAL_SERVER_PORT)
  : 17117;
start({ input: 'src/index.ts', login: 'server', port });
