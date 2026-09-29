# FantasyFinal 网页端更新与 Nginx 部署指南

Server 和 QQBot 在同一台 TencentOS 云服务器运行。当前约定的临时测试入口是公网 IP 的 18080 端口；网页包的日常更新只需按第二章操作。域名 HTTPS 和管理后台的部署步骤保留在后续章节，只有准备重新开放域名入口时才使用。

临时测试入口及预留的域名入口：

~~~text
临时网页游戏： http://1.12.245.238:18080/
临时入口不开放管理后台：/admin 返回 404
预留的域名入口： https://fantasyfinal.net/ （当前更新 Web 包不依赖它）
服务器公网 IP：1.12.245.238
~~~

## 一、当前端口关系

临时测试时，腾讯云安全组仅给自己的公网 IP 放行入站 TCP 18080；按关闭域名入口的安排，80 和 443 保持关闭。17118、17119、17200 等后端服务继续绑定 127.0.0.1，不加入公网安全组。将来恢复域名 HTTPS 时，再按第四、五章处理 80 和 443。

| 端口 | 服务 | Nginx 路由 |
| --- | --- | --- |
| 18080 | Nginx 临时 IP 网页入口 | /、/api/；/admin 返回 404 |
| 17117 | Server/CBP 通信 | 不代理网页请求 |
| 17118 | 管理后台 Koa 服务 | 仅域名 HTTPS 配置代理 /admin、/api/admin/ |
| 17119 | 网页游戏、桌宠和 WebSocket API | /api/ |
| 17200 | Server Core API，QQBot 使用 | 不代理 |
| 17210 | QQBot 自身端口 | 不代理 |

当前网页 API 必须使用 17119。17117 是 Server 的 Alemon/CBP 端口，不能把网页 API 配置回 17117。

生产 Server 配置应包含：

~~~yaml
login: "server"
port: 17117

FantasyFinal:
  appApiServer:
    enabled: true
    listenHost: "127.0.0.1"
    port: 17119
  adminWeb:
    enabled: true
    listenHost: "127.0.0.1"
    port: 17118
    publicBaseUrl: "https://fantasyfinal.net"
    allowInsecurePublicHttp: false
  coreApi:
    enabled: true
    listenHost: "127.0.0.1"
    port: 17200
~~~

publicBaseUrl 只写 https://fantasyfinal.net，不要写成 https://fantasyfinal.net/admin。后台会按这个值校验 Host、HTTPS 转发头和 Cookie。

## 二、以后更新 Web 端的固定流程

只修改 `web/src`、`web/public` 或网页样式时，按 2.2～2.4 更新；发布出问题再按 2.5 恢复。网页文件由 Nginx 从 `/var/www/fantasyfinal` 读取，`/api/` 由 Nginx 转发到本机 `127.0.0.1:17119`。此类更新不需要重启 Server、QQBot，也不需要重载 Nginx；修改后端源码时另按第三章发布。

### 2.1 仅首次使用 IP 入口时配置

先把 `server/nginx-fantasyfinal-ip-18080.conf` 安装为 `/etc/nginx/conf.d/fantasyfinal-ip-18080.conf`，确认 Nginx 在监听 18080。腾讯云安全组为自己的公网 IP 放行入站 TCP 18080，并按临时方案保持 80、443 关闭。17119 仍只监听 `127.0.0.1`，不要直接对公网放行。后续仅更新 Web 包时跳过本节。

Windows PowerShell 上传配置：

~~~powershell
scp 'E:\猫拉瑞亚\FantasyFinal\server\nginx-fantasyfinal-ip-18080.conf' root@1.12.245.238:/tmp/
~~~

TencentOS 服务器安装并启动：

~~~bash
(
  set -e
  sudo install -m 644 /tmp/nginx-fantasyfinal-ip-18080.conf /etc/nginx/conf.d/fantasyfinal-ip-18080.conf
  sudo nginx -t
  if systemctl is-active --quiet nginx; then sudo systemctl reload nginx; else sudo systemctl start nginx; fi
  sudo ss -ltnp | grep ':18080'
)
~~~

如果 Nginx 原本已关闭，只有在确认 80、443 的公网安全组仍关闭后才启动它，因为服务器上可能还保留域名的 Nginx 配置。若 `nginx -t` 因旧域名配置引用失效证书而失败，先检查并停用该域名配置，再重新测试；不要跳过语法检查强行启动。上述步骤是首次配置或修改 Nginx 配置时使用；日常更新静态包不重复执行。

### 2.2 Windows 构建和打包（每次更新）

在 Windows PowerShell 中执行。第一次构建或 `package-lock.json` 变更后，先在 `web` 目录运行一次 `npm.cmd ci`；平时直接运行以下命令。使用 `npm.cmd` 可避开 PowerShell 对 `npm.ps1` 的执行策略限制。

~~~powershell
Set-Location 'E:\猫拉瑞亚\FantasyFinal\web'
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Web 构建失败，停止发布' }
if (-not (Test-Path .\dist\index.html)) { throw '构建结果缺少 dist/index.html' }

$release = Get-Date -Format 'yyyyMMdd-HHmmss'
$package = "fantasyfinal-web-dist-$release.tar.gz"
tar.exe -czf ".\$package" -C .\dist .
if ($LASTEXITCODE -ne 0) { throw 'Web 打包失败，停止发布' }
tar.exe -tzf ".\$package" > $null
if ($LASTEXITCODE -ne 0) { throw 'Web 压缩包校验失败，停止发布' }
scp ".\$package" 'root@1.12.245.238:/tmp/fantasyfinal-web-dist.tar.gz'
if ($LASTEXITCODE -ne 0) { throw '上传失败，停止发布' }
~~~

每次会在本地留下带时间戳的包，服务器上的上传文件统一为 `/tmp/fantasyfinal-web-dist.tar.gz`，所以 2.3 的命令可以原样重复。只上传构建后的 `dist` 内容，不上传 `node_modules`、`src` 或 Vite 开发服务。使用 `tar.exe` 可避免之前 ZIP 在 Linux 解压时出现反斜杠路径警告。

临时 `http://公网IP:18080` 入口不是浏览器的安全上下文，不会注册 Service Worker，但浏览器的普通 HTTP 文件缓存仍可用于再次打开。首次下载后，Nginx 让 `index.html` 每次重新验证、Vite 生成的带哈希 JS/CSS/字体缓存一年、`web/public/assets` 下原文件名的图片和音频缓存一天并可后台重新验证一周；`/api/` 仍由后端实时处理。更新了同名公开图片而又需要玩家立即看到时，改用新文件名并修改页面引用，或者让玩家清除此站点缓存；仅重新上传同名文件可能继续显示旧图直到缓存过期。修改 Nginx 缓存配置本身时，按 2.1 重新安装配置并通过 `nginx -t` 后重载，不是只上传网页包。

网页进入时只预载标题、登录图、加载动画和底部导航等关键图片；首次下载完成后才显示登录页，背包道具与角色等大量图片仍在使用时按需加载。将来恢复 HTTPS 域名入口后，Service Worker 会对页面入口优先请求网络、对带哈希的构建资源优先读取缓存；修改 Service Worker 的缓存规则时递增 `web/public/sw.js` 的 `VERSION` 再构建。关键图片自身的缓存版本由构建时的内容指纹自动更新。

### 2.3 TencentOS 服务器发布（每次更新）

登录服务器，整段执行。先解压和检查新包，再备份当前网页目录，最后复制新文件。任何检查失败都会在覆盖线上目录前退出。

~~~bash
(
  set -e
  package=/tmp/fantasyfinal-web-dist.tar.gz
  stage=$(mktemp -d /tmp/fantasyfinal-web.XXXXXX)
  trap 'rm -r -- "$stage"' EXIT

  tar -xzf "$package" -C "$stage"
  if [ ! -f "$stage/index.html" ]; then
    echo '网页包缺少 index.html，停止发布。' >&2
    exit 1
  fi

  sudo install -d -m 755 /var/www/fantasyfinal
  sudo install -d -m 700 /var/backups/fantasyfinal-web
  if [ -f /var/www/fantasyfinal/index.html ]; then
    release_stamp=$(date +%Y%m%d-%H%M%S)
    sudo tar -czf "/var/backups/fantasyfinal-web/before-$release_stamp.tar.gz" -C /var/www/fantasyfinal .
  fi

  sudo cp -a "$stage"/. /var/www/fantasyfinal/
  sudo chown -R root:root /var/www/fantasyfinal
  sudo find /var/www/fantasyfinal -type d -exec chmod 755 {} +
  sudo find /var/www/fantasyfinal -type f -exec chmod 644 {} +
  test -f /var/www/fantasyfinal/index.html
)
~~~

TencentOS 不一定有 `www-data` 用户；这里使用 `root:root`、目录 755、文件 644。复制新文件会保留旧的哈希资源文件，不影响新 `index.html` 使用新资源；不要为清理旧文件而直接删除线上目录。

### 2.4 验证（每次更新）

服务器执行，首页与 API 都应返回 HTTP 200，API 内容应包含 `"ok":true`：

~~~bash
curl -i http://127.0.0.1:18080/
curl -i http://127.0.0.1:18080/api/web/v1/health
tar -xOf /tmp/fantasyfinal-web-dist.tar.gz ./index.html | grep '/assets/index-'
curl -fsS http://127.0.0.1:18080/ | grep '/assets/index-'
~~~

后两条命令显示的 JS、CSS 文件名应一致，用来确认 Nginx 已读到新包的首页。健康接口只证明 API 可达，不能代替注册、登录验收。

首次安装或修改 18080 的缓存配置后，检查响应头。`index.html` 应为 `no-cache, must-revalidate`，带哈希的 JS 应为一年且 `immutable`，原文件名的 Logo 图片应为一天；静态资源不存在时应返回 404，不应回退为首页：

~~~bash
asset_path=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' /var/www/fantasyfinal/index.html | head -n 1)
test -n "$asset_path"
curl -sI http://127.0.0.1:18080/index.html | grep -iE 'HTTP/|Cache-Control'
curl -sI "http://127.0.0.1:18080$asset_path" | grep -iE 'HTTP/|Cache-Control'
curl -sI http://127.0.0.1:18080/assets/hero/fantasy-dimension-title.png | grep -iE 'HTTP/|Cache-Control'
curl -sI http://127.0.0.1:18080/assets/missing-resource.png | grep -iE 'HTTP/|Cache-Control'
~~~

Windows PowerShell 从公网验证：

~~~powershell
curl.exe -i --max-time 15 http://1.12.245.238:18080/api/web/v1/health
~~~

最后在浏览器打开 `http://1.12.245.238:18080/`，检查新页面及注册、登录。若页面能打开但 API 返回 502，先在服务器检查 `curl -i http://127.0.0.1:17119/api/web/v1/health` 和 Server 进程；若本机 18080 正常而公网连不上，检查腾讯云安全组的 TCP 18080 放行规则。临时 IP 入口的 `/admin` 返回 404 是预期结果。该入口使用未加密的 HTTP，只供限制来源 IP 的短期测试，登录时使用测试账号。

### 2.5 恢复上一版页面

2.3 会在 `/var/backups/fantasyfinal-web/` 保存发布前的网页目录。若更新有问题，先用 `sudo ls -lt /var/backups/fantasyfinal-web/` 找到本次发布前的 `before-*.tar.gz` 备份，再把下面文件名替换为实际名称后恢复：

~~~bash
sudo tar -xzf /var/backups/fantasyfinal-web/before-YYYYMMDD-HHMMSS.tar.gz -C /var/www/fantasyfinal
~~~

恢复静态文件同样无需重启 Server、QQBot 或 Nginx。复制式恢复会保留新版本多出的资源文件，但旧版 `index.html` 会重新引用旧版资源。此流程只适用于 Web 静态文件更新；后端接口、配置或数据库结构变化需另行部署和验证。

## 三、哪些改动需要重启后端

| 修改内容 | 构建 | 重启 |
| --- | --- | --- |
| web/src、web/public、网页 CSS | web 的 npm.cmd run build | 不需要 |
| server/src/app-api、聊天、队伍、WebSocket | server 的 npm run build | 需要 Server |
| server/src 中 Core、游戏规则、管理后台 | server 的 npm run build | 需要 Server |
| qqbot/src/qq-gateway | 重新生成并部署 qqbot/lib/qq-gateway | 需要 QQBot |
| Nginx 配置、证书 | 不需要 Node 构建 | nginx -t 后 reload |

server/index.js 加载 server/lib/index.js。只修改 server/src 或只刷新网页，不会让旧进程读取新服务端代码。

ALX、PM2、手动 node index.js 只能选一种进程管理方式。不要在 ALX 或 PM2 已经运行时再次手动启动同一个 Server/QQBot，否则会出现 EADDRINUSE。

Server 源码发布后：

~~~bash
cd /root/alx/workspace/bots/FantasyFinal-Server
npm run build
~~~

构建成功后，通过正在使用的 ALX 或 PM2 重启。使用 PM2 时可执行 npm run start；不要再执行 node index.js。

## 四、恢复域名 HTTPS 时的一次性准备

### 4.1 DNS

域名商处设置：

~~~text
fantasyfinal.net       A       1.12.245.238
www.fantasyfinal.net  A       1.12.245.238
~~~

Windows 检查：

~~~powershell
nslookup fantasyfinal.net
nslookup www.fantasyfinal.net
~~~

两个域名都应解析到当前服务器 IP。www 解析不正确时，证书申请会失败。

### 4.2 腾讯云安全组（仅域名 HTTPS 方案）

恢复域名 HTTPS 时放行入站 TCP 80、443。若仍保留临时 IP 测试入口，18080 继续只对自己的公网 IP 放行；停止使用时关闭 18080。17117、17118、17119、17200、17210 和 MySQL 3306 不需要公网规则。

服务器执行：

~~~bash
systemctl is-active firewalld
~~~

firewalld 为 inactive 时，系统防火墙不是当前阻断来源；仍要检查腾讯云安全组是否绑定到公网 IP 为 1.12.245.238 的实例。不要为了排查而全部放开端口。

### 4.3 TencentOS 软件包

TencentOS 不使用 apt：

~~~bash
cat /etc/os-release
command -v dnf || command -v yum
~~~

有 dnf 时：

~~~bash
sudo dnf makecache
sudo dnf install -y nginx certbot unzip tar
~~~

只有 yum 时：

~~~bash
sudo yum makecache
sudo yum install -y nginx certbot unzip tar
~~~

检查 Certbot 的 Nginx 插件：

~~~bash
certbot plugins
~~~

如果没有 nginx 插件，按当前 TencentOS 版本安装对应插件；不要改用 apt。

## 五、Nginx 和 HTTPS 初次配置

仓库中的配置文件：

- server/nginx-fantasyfinal-http.conf：申请证书前的临时 HTTP 配置。
- server/nginx-fantasyfinal-final.conf：证书成功后的最终 HTTPS 配置。

最终配置中的代理关系是：

~~~text
/                         -> /var/www/fantasyfinal
/api/                     -> 127.0.0.1:17119
/api/web/v1/realtime      -> 127.0.0.1:17119，保留 WebSocket Upgrade
/admin、/api/admin/       -> 127.0.0.1:17118
~~~

### 5.1 临时 HTTP 配置

Windows PowerShell：

~~~powershell
scp 'E:\猫拉瑞亚\FantasyFinal\server\nginx-fantasyfinal-http.conf' root@1.12.245.238:/tmp/nginx-fantasyfinal-http.conf
~~~

服务器：

~~~bash
sudo install -m 644 /tmp/nginx-fantasyfinal-http.conf /etc/nginx/conf.d/fantasyfinal.conf
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
~~~

证书申请前只要求 80 监听。不要提前启用最终配置，否则证书文件不存在时 nginx -t 会失败。

### 5.2 申请或检查证书

已有证书且文件可读时不要重复申请：

~~~bash
ls -l /etc/letsencrypt/live/fantasyfinal.net/
test -r /etc/letsencrypt/live/fantasyfinal.net/fullchain.pem && echo fullchain-ok
test -r /etc/letsencrypt/live/fantasyfinal.net/privkey.pem && echo privkey-ok
~~~

首次申请：

~~~bash
sudo certbot certonly --nginx -d fantasyfinal.net -d www.fantasyfinal.net
~~~

必须存在：

~~~text
/etc/letsencrypt/live/fantasyfinal.net/fullchain.pem
/etc/letsencrypt/live/fantasyfinal.net/privkey.pem
~~~

### 5.3 启用最终 HTTPS 配置

Windows PowerShell：

~~~powershell
scp 'E:\猫拉瑞亚\FantasyFinal\server\nginx-fantasyfinal-final.conf' root@1.12.245.238:/tmp/fantasyfinal.conf
~~~

服务器：

~~~bash
sudo cp -a /etc/nginx/conf.d/fantasyfinal.conf \
  /etc/nginx/conf.d/fantasyfinal.conf.http-only.bak
sudo install -m 644 /tmp/fantasyfinal.conf /etc/nginx/conf.d/fantasyfinal.conf

sudo nginx -t
sudo systemctl reload nginx
sudo ss -ltnp | grep -E ':(80|443)\b'
~~~

必须看到 0.0.0.0:443。nginx -t 只表示语法正确，必须再用 ss 确认监听。

域名的临时 HTTP 配置和最终 HTTPS 配置只能加载其中一种；独立的 `fantasyfinal-ip-18080.conf` 可以与域名配置并存。备份文件使用 .bak 或 .disabled 后缀，不会被常见的 include /etc/nginx/conf.d/*.conf 加载。

### 5.4 HTTPS 验证

~~~bash
curl -k -i --resolve fantasyfinal.net:443:127.0.0.1 https://fantasyfinal.net/
curl -k -i --resolve fantasyfinal.net:443:127.0.0.1 https://fantasyfinal.net/admin
curl -k -I --resolve www.fantasyfinal.net:443:127.0.0.1 https://www.fantasyfinal.net/
~~~

首页和后台应返回 200，www 应返回 301 跳转到 https://fantasyfinal.net/。

## 六、后台 404 的正确判断

生产配置的 publicBaseUrl 是 HTTPS，后台会拒绝没有正确 Host 和 HTTPS 转发头的直连请求。因此下面的命令返回 404 可能是正常的：

~~~bash
curl -i http://127.0.0.1:17118/admin
~~~

正确验证方式：

~~~bash
curl -k -i --resolve fantasyfinal.net:443:127.0.0.1 https://fantasyfinal.net/admin
~~~

也可以模拟 Nginx 转发头：

~~~bash
curl -i http://127.0.0.1:17118/admin \
  -H 'Host: fantasyfinal.net' \
  -H 'X-Forwarded-Proto: https'
~~~

如果 HTTPS 仍返回 404，检查最终 Nginx 配置是否把 /admin、/api/admin/ 转到 17118，并保留 Host、X-Forwarded-Proto、X-Forwarded-For。

## 七、证书续期

~~~bash
sudo certbot renew --dry-run
sudo certbot renew
sudo systemctl reload nginx
sudo openssl x509 -in /etc/letsencrypt/live/fantasyfinal.net/fullchain.pem \
  -noout -subject -dates
~~~

证书续期后要 reload Nginx，进程才会读取新的证书。

## 八、Server、QQBot 配置和进程

生产 Server 配置使用 server/服务器配置-server-Linux修正版.txt 的端口结构。不要把本机测试用的 server/alemon.config.yaml 直接覆盖到生产服务器，其中可能仍是测试数据库或 17117 网页 API 端口。

当前目录：

~~~text
Server：/root/alx/workspace/bots/FantasyFinal-Server
QQBot：/root/alx/workspace/bots/FantasyFinal-QQbot
~~~

QQBot 只配置 QQ App、Core URL 和与 Server 一致的 Core service token，不配置 MySQL、Redis 或 adminWeb。

同机检查：

~~~bash
sudo ss -ltnp | grep -E ':(17117|17118|17119|17200|17210)\b'
~~~

正常端口：

~~~text
17117  Server/CBP
17118  管理后台
17119  网页 App API
17200  Core API
17210  QQBot
~~~

出现 EADDRINUSE 时，先检查重复进程。不要把网页 API 改回 17117，也不要同时运行 ALX、PM2 和手动 node index.js。

## 九、域名 HTTPS 的完整验收清单（恢复域名入口时使用）

服务器内部：

~~~bash
nginx -t
systemctl is-active nginx
sudo ss -ltnp | grep -E ':(80|443)\b'
sudo ss -ltnp | grep -E ':(17117|17118|17119|17200|17210)\b'

curl -i http://127.0.0.1:17119/api/web/v1/health
curl -i http://127.0.0.1:17200/api/qqbot/v1/health
curl -k -i --resolve fantasyfinal.net:443:127.0.0.1 https://fantasyfinal.net/
curl -k -i --resolve fantasyfinal.net:443:127.0.0.1 https://fantasyfinal.net/admin
~~~

后台应通过 HTTPS 域名验证，不要用没有 Host/HTTPS 头的 17118 直连结果判断后台状态。

Windows 外部验证：

~~~powershell
nslookup fantasyfinal.net
nslookup www.fantasyfinal.net
Test-NetConnection fantasyfinal.net -Port 80
Test-NetConnection fantasyfinal.net -Port 443
~~~

两个端口都应显示 TcpTestSucceeded : True。浏览器访问：

~~~text
https://fantasyfinal.net/
https://fantasyfinal.net/admin
~~~

网页聊天建立实时连接后，在浏览器 Network 中确认 /api/web/v1/realtime 为 101 Switching Protocols。

## 十、常见错误

| 现象 | 处理 |
| --- | --- |
| apt: command not found | TencentOS 使用 dnf 或 yum。 |
| npm.ps1 被禁止 | Windows 使用 npm.cmd ci、npm.cmd run build。 |
| www-data 用户不存在 | 使用 root:root，目录 755，文件 644。 |
| unzip 反斜杠警告 | 推荐 tar.exe -czf；ZIP 解压后检查 index.html。 |
| nginx -t 成功但 443 拒绝 | 只加载了 HTTP 配置；启用最终配置并用 ss 检查 0.0.0.0:443。 |
| HTTP 返回 302 且 Location 指向 dnspod.qcloud.com/static/webblock.html，HTTPS 连接被重置 | 腾讯云域名访问拦截的典型表现。检查 fantasyfinal.net 的 ICP 备案或腾讯云接入备案状态；服务器本机 API 正常也不能解除公网拦截。 |
| /admin 直接 404 | IP:18080 入口返回 404 是预期结果；恢复管理后台后，应使用 HTTPS 域名或带正确 Host、X-Forwarded-Proto 的测试。 |
| 502 Bad Gateway | 检查 17118/17119 后端和 proxy_pass 端口。 |
| 17117 已占用 | Server 重复启动，或网页 API 错配到 17117。 |
| 17210 已占用 | QQBot 重复启动，检查 ALX、PM2、手动进程。 |
| 网站仍显示旧版本 | 临时 IP 入口先对比 2.4 的首页资源文件名并刷新浏览器；HTTPS 域名入口还要递增 web/public/sw.js 的 VERSION，重新构建并更新 Service Worker。 |
| 网页接口 404 | 检查 /api/web/v1/*、Nginx 的 /api/→17119，以及 Server 是否重新 build 并重启。 |

## 十一、域名 HTTPS 排查时收集的信息

不要直接放开所有端口。服务器执行：

~~~bash
cat /etc/os-release
nginx -t
systemctl status nginx --no-pager -l
sudo ss -ltnp | grep -E ':(80|443|17117|17118|17119|17200|17210)\b'
sudo nginx -T 2>/dev/null | grep -nE 'listen (80|443)|server_name|ssl_certificate|proxy_pass'
sudo journalctl -u nginx -n 100 --no-pager
sudo tail -n 50 /var/log/nginx/error.log
~~~

Windows 执行：

~~~powershell
nslookup fantasyfinal.net
Test-NetConnection fantasyfinal.net -Port 80
Test-NetConnection fantasyfinal.net -Port 443
~~~

这些结果可以区分 DNS、云安全组、Nginx 监听、证书、静态文件和后端端口问题。

如果网页能显示但注册或登录报 Failed to fetch，再执行：

~~~powershell
curl.exe -v http://fantasyfinal.net/api/web/v1/health
curl.exe -v https://fantasyfinal.net/api/web/v1/health
~~~

这里要用 GET（不要加 -I）；当前环境中 HEAD 曾返回 Nginx 的 301，但 GET 被拦截。GET 响应如果出现 Location: https://dnspod.qcloud.com/static/webblock.html?d=fantasyfinal.net，说明请求没有到达 Nginx。页面能显示可能是浏览器 Service Worker 缓存，注册登录接口不会被它缓存。先到腾讯云 ICP 备案控制台检查该域名的备案和接入状态；未备案需办理备案，已在其他厂商备案需办理腾讯云接入备案。备案已经完成仍被拦截时，带上上述命令输出联系腾讯云支持。
