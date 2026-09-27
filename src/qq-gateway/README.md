# FantasyFinal QQ Gateway

`src/qq-gateway/index.ts` 是只负责 QQ 收发消息的独立入口，由本目录 `index.js` 按原有 AlemonX 方式加载。它通过 `FANTASYFINAL_CORE_URL` 调用游戏本体 Core API，进程代码不导入 `src/game`、`src/database` 或 `mysql2`，也不执行本地游戏规则。

## 启动

1. 给 Gateway 进程设置 `FANTASYFINAL_CORE_URL` 和 `FANTASYFINAL_CORE_TOKEN`，可参考仓库根目录 `qq-gateway.env.example`。
2. 复制 `alemon.qq.yaml.example` 为独立的 QQ 配置文件，只填写 `qq-bot` 的 App ID/Secret；不要复制 Core 的 `mysql`、`redis` 配置。
3. 通过 `npm run app` 或 ALX 启动 `index.js`。设置 `FANTASYFINAL_QQ_CONFIG` 时会转换为 Alemon 的 `CFG_PATH`。

Gateway 收到文字或交互事件后，会携带 `requestId`、QQ 身份和会话上下文调用 `/api/qqbot/v1/commands`。Core 同时保留旧的 `/internal/v1/qq/*` 兼容入口。Core 不可用时只返回错误提示。Core 返回的所有按钮都由 QQ renderer 强制使用 `autoEnter: false`，需要用户手动确认。

通知由 `NotificationPoller` 每 5 秒向 Core 领取租约；QQ 适配层完成发送后回报 `sent`、`failed` 或 `uncertain`。发送失败不会在 Gateway 本地执行游戏逻辑。
