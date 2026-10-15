# online.fantasyfinal.net 部署与后续更新

适用环境：TencentOS，Server、QQBot 在同一台机器上由 ALX 管理，Web 静态文件由 Nginx 提供。以下三个源码仓库各自独立，均使用 `main` 分支：

| 项目 | Git 仓库 | 服务器目录 |
| --- | --- | --- |
| Server | `git@github.com:yoshino6/FantasyFinal-Server.git` | `/root/alx/workspace/bots/FantasyFinal-Server` |
| QQBot | `git@github.com:yoshino6/FantasyFinal-QQbot.git` | `/root/alx/workspace/bots/FantasyFinal-QQbot` |
| Web | `git@github.com:yoshino6/FantasyFinal-Web.git` | `/root/FantasyFinal-Web`（首次部署时新建） |

对外入口为 `https://online.fantasyfinal.net/` 和 `https://online.fantasyfinal.net/admin`。Nginx 将网页游戏 API、实时连接转到本机 `17119`，管理后台转到 `17118`。`17117` 是 Server/CBP、`17200` 是 QQ Core、`17210` 是 QQBot；这些端口无需对公网开放。不要把网页 API 代理到 `17117`。

## 一、首次启用域名

1. 先在腾讯云控制台核对这台服务器当前公网 IP；若仍是此前使用的 `1.12.245.238`，就在域名 DNS 控制台把 `online` 的 A 记录指向该地址，否则使用控制台显示的新地址。如果还有 `online` 的 AAAA 记录，应确认 IPv6 服务也已配置；否则移除这条 AAAA 记录。Windows 上运行 `nslookup online.fantasyfinal.net`，结果应与控制台显示的公网 IP 一致。
2. 在这台腾讯云服务器绑定的安全组放通入站 TCP 80、443。Server 的 `17118`、`17119` 仍只监听 `127.0.0.1`。若 `firewalld` 正在运行，还需确认它允许 80、443。
3. 检查软件：`nginx -v`、`certbot --version`。TencentOS 使用 `dnf` 或 `yum`，不使用 `apt`。未安装时，按系统实际包管理器安装 `nginx`、`certbot`。
4. 先按第二、三节更新 Server 和 Web，并确认 `/var/www/fantasyfinal/index.html` 已存在；随后执行下面的证书步骤。

服务器上先安装仅提供证书验证的 HTTP 配置。该文件是 `server/nginx-fantasyfinal-online-http.conf`，证书签发前不要安装 HTTPS 文件：

~~~bash
(
  set -e
  server_dir=/root/alx/workspace/bots/FantasyFinal-Server
  sudo install -d -m 755 /var/www/letsencrypt
  sudo install -m 644 "$server_dir/nginx-fantasyfinal-online-http.conf" /etc/nginx/conf.d/fantasyfinal-online.conf
  sudo nginx -t
  sudo systemctl enable --now nginx
  sudo systemctl reload nginx
  sudo ss -ltnp | grep -E ':(80|443)\b'
)
~~~

此时看到 80 监听即可。先检查 `sudo certbot certificates`；如果尚无 `online.fantasyfinal.net` 的证书，再申请：

~~~bash
sudo certbot certonly --webroot -w /var/www/letsencrypt -d online.fantasyfinal.net
sudo test -r /etc/letsencrypt/live/online.fantasyfinal.net/fullchain.pem
sudo test -r /etc/letsencrypt/live/online.fantasyfinal.net/privkey.pem
~~~

签发成功后安装 `server/nginx-fantasyfinal-online.conf`。它同时提供 80→443 跳转和 80 端口的续期验证路径；旧域名配置可以共存，只要各自 `server_name` 不冲突且证书路径有效。

~~~bash
(
  set -e
  server_dir=/root/alx/workspace/bots/FantasyFinal-Server
  sudo cp -a /etc/nginx/conf.d/fantasyfinal-online.conf /etc/nginx/conf.d/fantasyfinal-online.conf.http.bak
  sudo install -m 644 "$server_dir/nginx-fantasyfinal-online.conf" /etc/nginx/conf.d/fantasyfinal-online.conf
  if sudo nginx -t; then
    sudo systemctl reload nginx
  else
    sudo cp -a /etc/nginx/conf.d/fantasyfinal-online.conf.http.bak /etc/nginx/conf.d/fantasyfinal-online.conf
    sudo nginx -t
    echo 'HTTPS 配置未启用；已恢复 HTTP 配置。' >&2
    exit 1
  fi
  sudo ss -ltnp | grep -E ':(80|443)\b'
)
~~~

必须看到 `:443` 正在监听。证书续期验证用 `sudo certbot renew --dry-run`；证书实际续期后需重载 Nginx。若 `nginx -t` 因旧域名配置中的失效证书报错，先备份并停用那份旧配置，再重新测试；不要跳过语法检查。

## 二、Server 和 QQBot 从 Git 更新

以下命令在服务器的 root shell 中执行。第一次操作时，先核对两个现有目录确实是对应 Git 仓库、当前分支为 `main`，并检查本机修改。已有改动不要直接覆盖或丢弃：

~~~bash
server_dir=/root/alx/workspace/bots/FantasyFinal-Server
qq_dir=/root/alx/workspace/bots/FantasyFinal-QQbot
git -C "$server_dir" remote -v
git -C "$server_dir" branch --show-current
git -C "$server_dir" status --short
git -C "$server_dir" diff --name-only
git -C "$server_dir" diff --cached --name-only
git -C "$qq_dir" remote -v
git -C "$qq_dir" branch --show-current
git -C "$qq_dir" status --short
git -C "$qq_dir" diff --name-only
git -C "$qq_dir" diff --cached --name-only
~~~

如果目录不是 Git 仓库、远程仓库不匹配、分支不是 `main`，或除运行文件外还有未确认的跟踪文件改动，先停下核对。**首次更新清理版时，不要直接 `git pull`**：旧仓库曾跟踪实际 `alemon.config.yaml`、根目录的 `lib/` 等运行文件；新提交停止跟踪它们。旧配置有本地改动时，直接拉取可能失败，配置也会在拉取后消失。

### 2.1 首次迁移旧仓库的运行文件

先在 ALX 停止 Server、QQBot，等待进程退出。检查 `/root` 所在磁盘有足够空间；备份会保存运行配置、状态以及旧版根 `lib/`。`packages/*/lib/` 是 Server 的平台依赖，不属于这里的运行 `lib/`，不要删除。以下备份仅保存在服务器的 root 私有目录，不上传 Git：

~~~bash
(
  set -e
  umask 077
  server_dir=/root/alx/workspace/bots/FantasyFinal-Server
  qq_dir=/root/alx/workspace/bots/FantasyFinal-QQbot
  backup_root=/root/fantasyfinal-backups
  backup_dir="$backup_root/migration-$(date +%Y%m%d-%H%M%S)"
  install -d -m 700 "$backup_dir"
  backup_one() {
    local dir="$1" name="$2" path
    local state=()
    test -f "$dir/alemon.config.yaml"
    for path in alemon.config.yaml alemon.yaml .alemonx-id .alemon .data logs \
      '服务器配置-server.txt' '服务器配置-server-Linux修正版.txt' '服务器配置-QQBot.txt'; do
      if [ -e "$dir/$path" ]; then state+=("$path"); fi
    done
    tar -czf "$backup_dir/$name-state.tar.gz" -C "$dir" "${state[@]}"
    tar -tzf "$backup_dir/$name-state.tar.gz" >/dev/null
    if [ -d "$dir/lib" ]; then
      tar -czf "$backup_dir/$name-old-lib.tar.gz" -C "$dir" lib
      tar -tzf "$backup_dir/$name-old-lib.tar.gz" >/dev/null
    fi
  }
  backup_one "$server_dir" server
  backup_one "$qq_dir" qqbot
  printf '%s\n' "$backup_dir" > "$backup_root/last-migration-path"
  echo "运行文件已备份到：$backup_dir"
)
~~~

确认两份 `*-state.tar.gz` 存在且上一步无报错。Server 更新可能涉及数据库结构或旧存档迁移，重启前还应按正在使用的 MySQL 备份流程导出数据库，或创建云数据库快照。

下面只对**已备份的旧运行路径**执行定向 `git restore`，让旧仓库的本地跟踪改动回到当前提交，随后快进拉取并恢复真实运行状态。若还存在其他跟踪文件改动，命令会停在 `git diff --quiet`，不会执行全仓重置。第一次迁移只运行一次：

~~~bash
(
  set -e
  server_dir=/root/alx/workspace/bots/FantasyFinal-Server
  qq_dir=/root/alx/workspace/bots/FantasyFinal-QQbot
  backup_dir=$(cat /root/fantasyfinal-backups/last-migration-path)
  test -f "$backup_dir/server-state.tar.gz"
  test -f "$backup_dir/qqbot-state.tar.gz"
  migrate_one() {
    local dir="$1" name="$2" path
    for path in alemon.config.yaml alemon.yaml .alemonx-id lib .alemon .data logs \
      '服务器配置-server.txt' '服务器配置-server-Linux修正版.txt' '服务器配置-QQBot.txt'; do
      if git -C "$dir" ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
        git -C "$dir" restore --staged --worktree -- "$path"
      fi
    done
    git -C "$dir" diff --quiet
    git -C "$dir" diff --cached --quiet
    git -C "$dir" pull --ff-only origin main
    git -C "$dir" check-ignore -q alemon.config.yaml
    tar -xzf "$backup_dir/$name-state.tar.gz" -C "$dir"
    test -f "$dir/alemon.config.yaml"
  }
  migrate_one "$server_dir" server
  migrate_one "$qq_dir" qqbot
  echo '两个仓库已更新，实际配置与运行状态已恢复；旧 lib 备份保留在私有目录。'
)
~~~

若拉取中途失败，先用以下命令恢复备份的实际配置与状态，再检查 Git 报错；不要执行 `git reset --hard` 或再次启动缺配置的项目：

~~~bash
backup_dir=$(cat /root/fantasyfinal-backups/last-migration-path)
tar -xzf "$backup_dir/server-state.tar.gz" -C /root/alx/workspace/bots/FantasyFinal-Server
tar -xzf "$backup_dir/qqbot-state.tar.gz" -C /root/alx/workspace/bots/FantasyFinal-QQbot
~~~

恢复后用 `stat -c '%U:%G %a %n' /root/alx/workspace/bots/FantasyFinal-{Server,QQbot}/alemon.config.yaml` 确认运行用户能读取配置。

### 2.2 后续正常更新

以后更新前，停止 ALX 中的 Server/QQBot，复用 2.1 的备份命令保存两份实际 YAML 和运行状态，并先备份数据库；无需再执行 2.1 的 `git restore`。然后按下面命令拉取；**首次已执行 2.1 时跳过这两条拉取命令**：

~~~bash
git -C /root/alx/workspace/bots/FantasyFinal-Server pull --ff-only origin main
git -C /root/alx/workspace/bots/FantasyFinal-QQbot pull --ff-only origin main
~~~

首次迁移或正常拉取后，均执行构建和 QQBot 编译产物同步：

~~~bash
(
  set -e
  server_dir=/root/alx/workspace/bots/FantasyFinal-Server
  qq_dir=/root/alx/workspace/bots/FantasyFinal-QQbot

  cd "$server_dir"
  npm ci
  npm run build
  test -f lib/index.js
  test -f lib/qq-gateway/index.js

  cd "$qq_dir"
  npm ci
  install -d lib/qq-gateway
  cp -a "$server_dir/lib/qq-gateway/." lib/qq-gateway/
  test -f lib/qq-gateway/index.js
)
~~~

QQBot 仓库当前没有独立的 `build` 脚本；其运行入口需要 `lib/qq-gateway/index.js`，上一步由 Server 构建产物提供。

### 管理后台地址（首次切换域名时）

在服务器现有的 `$server_dir/alemon.config.yaml` 中，仅核对和修改下列字段，保留数据库密码、Core 令牌、后台账号及其他现有值：

~~~yaml
FantasyFinal:
  appApiServer:
    enabled: true
    listenHost: "127.0.0.1"
    port: 17119
  adminWeb:
    enabled: true
    listenHost: "127.0.0.1"
    port: 17118
    publicBaseUrl: "https://online.fantasyfinal.net"
    allowInsecurePublicHttp: false
~~~

`publicBaseUrl` 不带 `/admin`。Nginx 与 Server 同机时，后台默认信任 `127.0.0.1` 的代理转发头；正式配置已转发 `Host` 和 `X-Forwarded-Proto`。

完成构建和配置后，通过**现有 ALX 管理界面**依次重启 Server、QQBot。不要同时用 ALX、PM2 和手动 `node index.js` 启动同一服务，以免出现 `EADDRINUSE`。若当前实际使用 PM2，则只通过 PM2 重启，勿再用 ALX 启动。

在 Server 已正常启动后检查：

~~~bash
curl -i http://127.0.0.1:17119/api/web/v1/health
curl -i http://127.0.0.1:17200/api/qqbot/v1/health
sudo ss -ltnp | grep -E ':(17117|17118|17119|17200|17210)\b'
~~~

两个健康接口应返回 HTTP 200 和 `"ok":true`。`17118` 的 `/admin` 不能用裸 `127.0.0.1` 请求判断：后台要求正确的域名 Host 和 HTTPS 转发头。

## 三、Web 从 Git 更新并发布静态文件

首次在服务器上建立独立 Web 源码目录：

~~~bash
git clone git@github.com:yoshino6/FantasyFinal-Web.git /root/FantasyFinal-Web
~~~

如果 `/root/FantasyFinal-Web` 已经存在，不要覆盖或直接拉取：旧 Web 仓库曾跟踪 `dist/` 和实际 `alemon.config.yaml`，新提交停止跟踪它们。先把旧目录中的配置和定制的 `dist/` 备份到 root 私有目录，或将新仓库克隆到另一个空目录并同步修改下文的 `web_dir`。线上 `/var/www/fantasyfinal` 与源码检出目录分离，不会因 Git 拉取而删除。

以后每次 Web 更新：

~~~bash
(
  set -e
  web_dir=/root/FantasyFinal-Web
  git -C "$web_dir" remote -v
  git -C "$web_dir" branch --show-current
  git -C "$web_dir" status --short
  git -C "$web_dir" pull --ff-only origin main
  cd "$web_dir"
  npm ci
  npm run build
  test -f dist/index.html
  test -f dist/game-assets.json
)
~~~

若远程、分支或未提交改动不符合预期，先停下核对。Web 仓库中的剧情插画 manifest 是 Server 版本的快照；今后若 Server 新增、移除剧情插画，发布前需同步该快照及对应 Web 资源，再构建 Web。

构建成功后备份并复制整个 `dist`。此操作不会修改 Server/QQBot，也不需要重启它们或 Nginx：

~~~bash
(
  set -e
  web_dir=/root/FantasyFinal-Web
  test -f "$web_dir/dist/index.html"
  sudo install -d -m 755 /var/www/fantasyfinal
  sudo install -d -m 700 /var/backups/fantasyfinal-web
  stamp=$(date +%Y%m%d-%H%M%S)
  if [ -f /var/www/fantasyfinal/index.html ]; then
    sudo tar -czf "/var/backups/fantasyfinal-web/before-$stamp.tar.gz" -C /var/www/fantasyfinal .
  fi
  sudo cp -a "$web_dir/dist/." /var/www/fantasyfinal/
  sudo chown -R root:root /var/www/fantasyfinal
  sudo find /var/www/fantasyfinal -type d -exec chmod 755 {} +
  sudo find /var/www/fantasyfinal -type f -exec chmod 644 {} +
  test -f /var/www/fantasyfinal/index.html
)
~~~

`dist` 中的 `index.html`、`assets/`、`game-assets.json`、`sw.js` 都要一并发布。复制方式保留旧版哈希资源，便于仍缓存旧首页的浏览器读取。发布失败时，用 `sudo ls -lt /var/backups/fantasyfinal-web/` 找到本次更新前的备份，再将以下文件名替换为实际备份名：

~~~bash
sudo tar -xzf /var/backups/fantasyfinal-web/before-YYYYMMDD-HHMMSS.tar.gz -C /var/www/fantasyfinal
~~~

## 四、验收与排查

服务器上测试 Nginx、静态页、后台和 API：

~~~bash
sudo nginx -t
sudo ss -ltnp | grep -E ':(80|443|17118|17119)\b'
curl -i --resolve online.fantasyfinal.net:443:127.0.0.1 https://online.fantasyfinal.net/
curl -i --resolve online.fantasyfinal.net:443:127.0.0.1 https://online.fantasyfinal.net/admin
curl -i --resolve online.fantasyfinal.net:443:127.0.0.1 https://online.fantasyfinal.net/api/web/v1/health
~~~

首页、后台、Web 健康接口应返回 200；健康响应含 `"ok":true`。再从 Windows PowerShell 检查公网并在浏览器实际注册、登录：

~~~powershell
nslookup online.fantasyfinal.net
Test-NetConnection online.fantasyfinal.net -Port 443
curl.exe -i --max-time 15 https://online.fantasyfinal.net/api/web/v1/health
~~~

| 现象 | 先检查 |
| --- | --- |
| 公网 443 连接失败，本机 443 正常 | DNS、腾讯云安全组、`firewalld`、备案接入状态 |
| `nginx -t` 成功，但 443 没有监听 | 是否启用了 HTTPS 配置、是否执行 reload/start |
| 首页 200，注册/登录为 502 | `127.0.0.1:17119` 健康接口和 Server 进程 |
| `/admin` 返回 404 | `publicBaseUrl` 是否为新域名；Nginx 是否转发到 `17118` 并设置 HTTPS 转发头 |
| 浏览器仍显示旧版 | 核对线上 `index.html` 的 `/assets/index-*.js`、清除该站点缓存，必要时检查 Service Worker |

浏览器实时连接成功后，开发工具中 `/api/web/v1/realtime` 应显示 `101 Switching Protocols`。若仅页面打开而登录失败，健康接口 200 仍不足以证明登录成功，需要检查实际请求与 Server 日志。
