# 部署指南

> 目标拓扑：
>
> ```
> 浏览器 ──HTTPS/WSS──▶ nginx ──▶ relay (5081)
>                        ▲
>                        │ Agent 主动出站 WSS
>                        │
>              本地 Windows 主机（agent + autojs + 手机）
> ```
>
> 所有流量都走 443，**5081 不需要对公网开放**。

---

## 0. 先选节点：大陆还是香港（这一步决定后面全部）

**大陆节点上，域名必须 ICP 备案才能访问。** 这不是建议，是硬约束：
未备案域名解析到境内服务器，云厂商会阻断域名访问，被查到还可能要求整改
甚至关停。而备案本身有两道时间门槛：

1. **境外注册商的域名不能直接备案**，必须先把域名转入国内注册商；
2. 域名**注册未满 60 天不能转移**。

所以「境外买的域名 + 大陆服务器 + 想马上用域名」这个组合是无解的，
只能三选一：

| 方案 | 域名可用时间 | 说明 |
| --- | --- | --- |
| **香港 / 海外节点** | 立刻 | 免备案，直接 A 记录 + Let's Encrypt。大陆访客延迟略高，视频上传跨境 |
| **国内注册商新买域名 + 备案** | 约 2~4 周 | 不用等转移（新注册可立即备案），但备案本身要 7~20 工作日 |
| **先只用 IP** | — | 零风险，等域名能备案了再上 |

`deploy/bootstrap.sh` 对大陆与香港节点都适用；下文不区分。

> 判断当前节点：`curl -s https://ipinfo.io/<你的IP>/json | grep country`，
> `CN` 就是大陆，需要备案。

---

## 1. 服务器准备

一台干净的 Ubuntu 22.04 / 24.04，然后一条命令装齐：

```bash
sudo bash deploy/bootstrap.sh
```

它做四件事，可重复执行：

1. 装 `nginx` / `certbot` / `sqlite3` / `git` / `curl` / `build-essential`
2. 装 **Node 20**（NodeSource），已装对版本就跳过
3. 装 `pm2`
4. 建好 `/var/www/certbot`（ACME 校验）与 `/var/www/remote-phone-control`（前端产物）

> ⚠️ **Node 版本别乱升。** 本机开发时用 Node 24 选了 `node:sqlite`，
> 部署到 Node 20 直接 `ERR_UNKNOWN_BUILTIN_MODULE`；`better-sqlite3@13`
> 又要求 Node ≥22。现在是 `better-sqlite3@12` + `process.loadEnvFile`，
> 在 Node 20 上都成立。换大版本前先跑一遍 relay 的测试套件。

<details>
<summary>手工安装（不用脚本时）</summary>

```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx sqlite3 build-essential python3
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```
</details>

---

## 2. 拉代码并安装依赖

```bash
cd ~/remote-phone-control
git pull

# 部署用 npm ci：严格按 lock 安装，且不会改动 package-lock.json
npm ci
```

> ⚠️ **服务器上始终用 `npm ci`，不要用 `npm install`。**
> `npm install` 会改写 `package-lock.json`，导致下次 `git pull` 报
> 「local changes would be overwritten」。

---

## 3. 启动 relay

**先起 relay 再配域名**：relay 会建库并创建管理员，而
`deploy.sh` 只会 `pm2 restart`、**不会 `pm2 start`** —— 顺序反了会得到一个
根本没起来的进程，后面所有验证都失败。

变量已经有五六个（管理员密码、`AGENT_SECRET`、`SMTP_*`、`NODE_ENV`），
全塞在命令行里很容易漏，推荐直接写进 `relay/.env`（已被 `.gitignore` 忽略）：

```bash
cd ~/remote-phone-control

cat > relay/.env <<'ENV'
# 初始管理员；只在首次启动（库里还没有管理员时）生效
ADMIN_PASSWORD=<你的强密码>
# 「发视频」用的共享密钥，必须与本机 agent 上的完全一致
AGENT_SECRET=<openssl rand -hex 32 的输出>
# 生产必须设：不设时 relay 会把注册验证码直接放进接口响应里方便调试
NODE_ENV=production
ENV

pm2 start npm --name remote-phone-relay -- run relay:start
```

> 加载用的是 Node 内建的 `process.loadEnvFile`（需 Node 20.12+），
> **真实环境变量优先于 `.env`**，所以「生产用 pm2 注入、本地用 `.env` 调试」
> 可以共存，部署时也不会被磁盘上遗留的 `.env` 覆盖。
>
> ⚠️ 别用 `AGENT_SECRET=xxx pm2 restart` 这种写法：pm2 重启用的是
> **它自己存下来的一份环境变量**，不会读你当前 shell 的，所以改不上去。
> 写 `.env` 再 `pm2 restart` 才是有效的（relay 每次启动都会重读 `.env`）。

### 视频下发用的共享密钥

`AGENT_SECRET` 是 relay 与设备主机之间一条**独立于账号体系**的下载通道
（设备主机没有用户会话）。两端不一致的表现是：视频下载全部 401，
客户侧看到「发视频失败」，但 relay 一切正常。

不设它 relay 不会崩，只是 `/api/agent/videos/:id` 返回 503。

另外确认 `RELAY_MEDIA_DIR` 所在分区**有足够空间**：每个视频都会在服务器
留一份，且目前不做自动清理。默认是 relay 工作目录下的 `data/videos`。

### 日志里应该有

```
[relay] server ready at http://0.0.0.0:5081
[relay] database: data/relay.db
[relay] env file: /home/ubuntu/remote-phone-control/relay/.env   ← 有这行才说明 .env 被读到
[relay] mail: console（验证码只打印在日志里，不会真正发出）
[relay] api: /api/auth/*, /api/admin/*, /api/my/devices
```

**记得 `pm2 save`**，否则重启服务器后不会自动拉起：

```bash
pm2 save
pm2 startup     # 按提示执行输出的那行命令
```

---

## 4. 构建前端并发布

一键脚本把「构建 + 发布 + 重启」都做了：

```bash
bash deploy/deploy.sh
```

它做的事：`git pull` → `npm ci` → 构建 → 复制到 `/var/www/remote-phone-control`
→ `chown www-data` → `pm2 restart`。

手工做的话是：

```bash
npm run build --workspace web

sudo mkdir -p /var/www/remote-phone-control
sudo rm -rf /var/www/remote-phone-control/*
sudo cp -r web/dist/. /var/www/remote-phone-control/
sudo chown -R www-data:www-data /var/www/remote-phone-control
```

### ⚠️ 为什么必须复制到 /var/www，不能让 nginx 读仓库？

Ubuntu 的家目录是 `0750`（`drwxr-x---`），**nginx 以 `www-data` 运行，根本进不去
`/home/ubuntu`**，会直接返回 403。错误日志里长这样：

```
[crit] stat() "/home/ubuntu/remote-phone-control/web/dist/" failed (13: Permission denied)
[error] open() "/home/ubuntu/remote-phone-control/web/dist/index.html" failed (13: Permission denied)
```

另一种"解决"是给家目录开遍历权限，但那是**把整个家目录暴露给 nginx 进程**，
不值得。标准做法就是产物发布到 `/var/www`。

**不需要设置任何构建时变量** —— 前端会按页面来源自动判断：

| 打开地址 | 行为 |
|---|---|
| `localhost:5173`（开发） | 本地直连模式，连本机 Agent 5071 |
| 任何其它域名 | 同源中继模式，`/api` 与 `/ws` 都打到当前域名 |

所以同一份 `dist` 部署到哪个域名都能用，换域名也不用重新构建。

---

## 5. 配域名 + HTTPS 证书

一条命令搞定（含「证书还没签时 nginx -t 过不了」的先后顺序）：

```bash
sudo bash deploy/setup-nginx-domain.sh jyglobal.top you@example.com
```

第三个参数 `--no-www` 表示不签发 www（默认两个都签）。

它按四步走：

1. 先装一份**只有 80 端口**的配置（不引用证书，所以 `nginx -t` 能过），
   并删掉 Ubuntu 自带的 `sites-enabled/default`
2. `certbot certonly --webroot` 签证书
3. 再把 `deploy/nginx.conf.example` 里的 `your-domain.com` 全部替换成你的域名，
   装成 80 + 443 的完整配置
4. 自查：打印证书到期时间，并 `curl https://<域名>/health`

可重复执行：证书已存在就跳过申请（避免撞 Let's Encrypt 限流）。

### 为什么不能直接把 nginx.conf.example 拷过去

```bash
# ✗ 这样做会失败
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/remote-phone-control
sudo nginx -t      # nginx: [emerg] cannot load certificate ... No such file or directory
```

配置里引用了 `/etc/letsencrypt/live/<域名>/fullchain.pem`，而证书还不存在；
可 certbot 的 webroot 校验又需要 nginx 已经在 80 端口提供
`/.well-known/acme-challenge/` —— 于是死锁。脚本的第一步就是打破它。

### 手工操作（万一要排查）

```bash
sudo rm -f /etc/nginx/sites-enabled/default          # 不删它会把你的配置盖住
sudo nginx -t && sudo systemctl restart nginx
sudo certbot certonly --webroot -w /var/www/certbot -d <域名> -d www.<域名> \
  --email <邮箱> --agree-tos --no-eff-email --non-interactive
```

> ⚠️ **`reload` 有时不生效**（旧 worker 继续用旧配置）。
> 改完配置行为没变就用 `sudo systemctl restart nginx` —— restart 会彻底
> 换掉 master 和所有 worker，是确定的。这个坑排查了很久。

### 云控制台还要做两件事

1. **安全组放行 80 与 443**。只放行 443 是不够的：certbot 续期要走 80
2. **5081 不要对公网开放** —— 浏览器和 Agent 都只走 443

### 配置里几个容易漏的点

1. **`/ws/` 必须带 `Upgrade` 与 `Connection` 头** —— 缺了 WebSocket 握手直接失败
2. **`proxy_read_timeout 3600s`** —— 视频流是长连接，nginx 默认 60 秒无数据就掐断
3. **`client_max_body_size 512m`** —— 默认 1MB 会让所有视频上传直接 413，
   这个值要与 relay 的 `VIDEO_MAX_BYTES` 对齐
4. **`proxy_request_buffering off`** —— 否则 nginx 先把整个请求体缓冲到临时文件
   再转发，512MB 的视频等于写两遍磁盘

证书自动续期由 apt 装的 `certbot.timer` 负责，可自查：

```bash
systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

---

## 6. 配置邮件发送（注册验证码）

**不做这一步，线上就没有人能注册成功**——验证码发不出去，注册流程走不完。

```bash
MAIL_TRANSPORT=smtp \
SMTP_HOST='smtp.exmail.qq.com' \
SMTP_PORT='465' \
SMTP_USER='noreply@your-domain.com' \
SMTP_PASS='<授权码>' \
SMTP_FROM='noreply@your-domain.com' \
NODE_ENV=production \
pm2 start npm --name remote-phone-relay -- run relay:start
```

要点：

- 不设 `MAIL_TRANSPORT` 时默认 `console`：验证码只打印进 pm2 日志。
  内网 demo 够用（`pm2 logs` 里能看到码），但**不能对外提供服务**
- `NODE_ENV=production` 不只是性能开关，它同时关掉「验证码随接口回显」这一调试行为。
  只要不是生产，relay 会把 `devCode` 放进发码响应里方便前端调试——
  对外服务时那就是个取码后门
- 多数邮箱服务商要的是**授权码**而不是登录密码，且 `SMTP_FROM` 必须与
  `SMTP_USER` 一致——用别的地址当发件人会被直接拒收
- 6 位数字验证码非常像营销邮件，**发信域名务必配好 SPF / DKIM / DMARC**，
  否则大概率进垃圾箱。量大时建议改用阿里云邮件推送 / 腾讯云 SES
- `nodemailer` 已经在 `relay` 的 dependencies 里（也就是 `package-lock.json` 里），
  第 2 步的 `npm ci` 会一并装好，**不需要额外安装**
- `SMTP_SECURE` 不设时按端口推断（465 = 隐式 TLS，587 = STARTTLS）；
  填错的表现是发信报 SSL 握手错误，注册接口返回 502
- 也可以把变量写进 **`relay/.env`**（复制 `relay/.env.example` 改成 `.env` 即可，
  该文件已被 `.gitignore` 忽略）。加载用的是 Node 内建的 `process.loadEnvFile`，
  **真实环境变量优先于 `.env`**——所以「生产用 pm2 注入、本地用 .env 调试」可以共存，
  部署时也不会被磁盘上遗留的 `.env` 覆盖。需要 Node 20.12+

启动日志会打印当前邮件通道；配置写错时 relay **拒绝启动**，而不是悄悄退回 console：

```
[relay] mail: smtp（smtp.exmail.qq.com:465）
[relay] env file: /srv/remote-phone-control/relay/.env（真实环境变量优先于它）
```

（第二行只在确实存在 `.env` 时出现，用来确认它真的被读到了。）

---

## 7. 本地 Agent 连接

在**本地 Windows 主机**上（接手机那台），起一个新窗口：

```powershell
# 只需设一次，持久生效
setx ADB_PATH           "C:\path\to\platform-tools\adb.exe"
setx SCRCPY_PATH        "C:\path\to\scrcpy.exe"
setx SCRCPY_SERVER_PATH "C:\path\to\scrcpy-server"
setx DEVICE_TCP_RANGE   "10.0.0.41-60:5555"

# 发视频用：必须与服务器上的 AGENT_SECRET 完全一致
setx AGENT_SECRET       "<与服务器同一个密钥>"
# 可选：视频在本机的暂存目录，默认 %TEMP%\remote-phone-media。
# 放到系统盘之外更稳妥——每个视频都会在本机也留一份。
setx MEDIA_DIR          "D:\remote-phone-media"
```

推荐用仓库里的启动脚本，它会把上面这些**逐项检查并打印就绪状态**，
缺什么就直接告诉你该设哪一条：

```powershell
cd D:\projects\remote-phone-control
.\scripts\start-agent.ps1 -RelayUrl "wss://your-domain.com/ws/agent" -AgentId "pc-01"
```

输出长这样（`AGENT_SECRET` 缺失时会明确警告，而不是让你等到客户
下发视频才发现）：

```
  [就绪] ADB_PATH
  [就绪] RELAY_SERVER_WS_URL = wss://your-domain.com/ws/agent
  [就绪] DEVICE_TCP_RANGE = 10.0.0.41-60:5555
  [缺失] AGENT_SECRET —— 发视频会失败（下载视频时报 401/503）
  [就绪] MEDIA_DIR = D:\remote-phone-media
```

也可以临时覆盖而不动持久变量：`-Secret "<密钥>"`、`-MediaDir "D:\..."`。

想直接 `npm run agent:server` 也可以，那就自己把环境变量设好。

启动日志里能直接确认视频通道是否就绪：

```
[agent] media dir: D:\remote-phone-media
[agent] video download: http://your-domain.com / secret configured
```

`secret MISSING` 或 `video download: disabled` 就说明 `AGENT_SECRET` /
`RELAY_SERVER_WS_URL` 没设上，此时所有发视频任务都会在下载那一步失败。

> **从「IP 访问」换成「域名 + HTTPS」时，地址协议要一起改：**
>
> | 之前 | 之后 |
> |---|---|
> | `ws://1.2.3.4/ws/agent` | `wss://your-domain.com/ws/agent` |
>
> 少了这个 `s` 会连不上（nginx 在 80 上是 301 跳转，WebSocket 握手不跟跳转）。
> 视频下载地址不用单独配，它由中继地址自动推导：
> `wss://` → `https://`，`ws://` → `http://`。
> 改完必须重启 agent —— `setx` 只对新窗口生效。

> `setx` 只对新开的窗口生效 —— 设完必须**关掉当前窗口重开**，
> 或者用 `$env:XXX = "..."` 在当前窗口临时设。

---

## 8. 验证清单

```bash
# 1) relay 活着
curl https://your-domain.com/health

# 2) Agent 已连上、设备已上报
curl https://your-domain.com/health
# 期望 {"ok":true,"agents":1,"devices":20}
```

| 检查项 | 期望 |
|---|---|
| `agents` | `1`（本地 agent 已连上） |
| `devices` | 手机台数，例如 `20` |
| 浏览器打开 `https://your-domain.com` | 出现登录页 |
| 用管理员登录 | 顶栏出现「控制台 / 管理」 |
| 进「管理」 | 看到全部设备，全部为空闲 |
| 给客户开 `can_upload_video` + `can_send_video` + 设 `maxStorageBytes` | 「自动化 → 发视频」里能上传素材、选设备、下发 |
| 下发后看 agent 日志 | `[agent] video <id> -> <路径>` 然后 autojs 的 script_run_id |

### nginx 的两个视频相关设置

见第 5 节「配置里几个容易漏的点」：`client_max_body_size 512m` 与
`proxy_request_buffering off`，两条都是大文件上传必须的。

---

## 9. 日常运维

```bash
pm2 logs remote-phone-relay          # 看日志
pm2 restart remote-phone-relay       # 重启
```

**更新代码** —— 用 `deploy.sh`，它把「拉取 → 装依赖 → 构建 → 发布 → 重启」
做成固定动作，避免漏掉某一步（忘发布是这里最常见的失误）：

```bash
cd ~/remote-phone-control
bash deploy/deploy.sh
```

**备份 / 搬迁数据** —— 用 `deploy/relay-data.sh`：

```bash
# 备份（含数据库 + 视频素材），产出 relay-data-<时间戳>.tar.gz
bash deploy/relay-data.sh export

# 恢复到另一台机器
bash deploy/relay-data.sh import ~/relay-data-20260916-120000.tar.gz
```

它比手工 `sqlite3 .backup` 多做两件必要的事：

1. **用 SQLite 在线备份接口生成自包含的库**，不需要停 relay，并把结果
   数一遍表——读不出表就直接失败。
   ⚠️ **别用 `cp relay.db` 备份**：relay 跑在 WAL 模式，最新事务都还在
   `.db-wal` 里，`.db` 本身可能只有 4KB 的文件头。裸拷 + 只还原 `.db`
   会得到一张表都没有的空库，而全过程没有任何报错。
2. **导入前先 `pm2 stop`**，并把现有数据改名留档（`*.bak-<时间戳>`），
   出问题可以退回去。

搬家到新服务器的完整顺序（以从大陆迁到香港为例）：

```bash
# 旧服务器
bash deploy/relay-data.sh export
scp relay-data-*.tar.gz ubuntu@<新IP>:~/

# 新服务器（先按第 1~3 节把代码和 relay 跑起来）
bash deploy/relay-data.sh import ~/relay-data-*.tar.gz
bash deploy/deploy.sh                       # 发布前端
sudo bash deploy/setup-nginx-domain.sh <域名> <邮箱>
```

搬完记得把**本机 agent 的中继地址**改到新域名（见第 7 节），
并让客户用新地址登录——`.env` 里的 `ADMIN_PASSWORD` 只在首次建库时生效，
导入的库里已经带着原管理员账号，不需要重设。

---

## 10. 安全加固（上线前建议逐条处理）

| # | 事项 | 现状 |
|---|---|---|
| 1 | **关闭安全组的 5081** | 走 nginx 后不再需要；5081 只应监听本机 |
| 2 | **`/ws/agent` 鉴权** | ⚠️ **目前无鉴权**，任何人能连上就能冒充 Agent 塞假设备 |
| 3 | **全链路加密** | 用 `wss://` 后已解决（走 nginx + TLS） |
| 4 | `RELAY_HOST=127.0.0.1` | relay 只需被 nginx 访问，不必绑 `0.0.0.0` |
| 5 | 令牌存储改 httpOnly Cookie | 现为 localStorage，无法抵御 XSS |
| 6 | agent 与 relay 之间的密钥 | 配合第 2 条一起做 |

> 第 1 和第 4 条是**立刻能做**的：改完 relay 只监听本机，
> 外部只能通过 nginx 的 443 进来，攻击面小很多。
