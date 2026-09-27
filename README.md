# server

这是 ALX 可直接识别的游戏本体项目。使用本目录的 `alemon.config.yaml`，填好 MySQL、Redis 和 Core 配置后，在 ALX 中添加本目录。新部署且配置不存在时，复制 `alemon.config.yaml.example` 为 `alemon.config.yaml`；不要覆盖已填写的配置。

默认读取项目目录的 `alemon.config.yaml`。原来的 `alemon.yaml` 不再作为默认配置；若 ALX 环境变量还设有 `FANTASYFINAL_SERVER_CONFIG` 或 `CFG_PATH` 指向旧文件，请移除该设置，再保存并应用后台配置。

`index.js` 会优先加载本目录已构建的 `lib/index.js`，因此 ALX 不会直接用原生 Node 解析 `src` 中的无扩展名 TypeScript 导入或 PNG 资源。前台运行选择 `app` 脚本，后台运行使用 `./index.js` 并开启自动重启。配置中的 `login` 固定为 `server`，默认 `port` 为 `17117`。`lib/` 缺失时不要只复制单个源码文件，应先用项目构建配置重新执行 `lvy build`。

需要内部 QQ API 时，`FantasyFinal.coreApi.serviceToken` 必须和 QQ Gateway 使用的令牌一致；当前 `alemon.config.yaml` 已写入一份本地令牌。也可以用 ALX 环境变量 `FANTASYFINAL_CORE_SERVICE_TOKEN` 或 `FANTASYFINAL_CORE_TOKEN` 覆盖配置。QQ Gateway 通过 `http://127.0.0.1:17200` 访问 Core；跨服务器部署时改成 Core 服务器的 HTTPS 地址。源码更新后，在本目录执行 `npm run build`，再重启 ALX；运行时只需要 `lib/`，不需要让 ALX 直接执行 `src/`。

Core API 会把游戏本体的 `Format.value` 原始节点树、Markdown 回退正文和按钮一起返回。这样 QQ Gateway 可以重新构造原有 Alemon Markdown 消息；桌宠继续使用 `text` 与结构化按钮字段。修改格式相关源码后必须重新执行 `npm run build`，再同时重启 server 和 qqbot。

当前接口前缀为：管理后台 `/api/admin/v1/*`（端口 17118）、桌宠 `/api/desktop/v1/*`（端口 17117）、QQ Core `/api/qqbot/v1/*`（端口 17200）。旧的 `/api/admin/*`、`/app-api/v1/*`、`/internal/v1/qq/*` 和 `/healthz`、`/readyz` 仍保留为兼容入口。
