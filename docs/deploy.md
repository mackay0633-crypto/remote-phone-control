# 部署手册（从零到可用）

> **本文命令里的 `jyglobal.top` 是当前使用的域名**，换域名时全局替换即可。
> 本机路径（adb / scrcpy / `DEVICE_TCP_RANGE`）也是按接手机那台机器实际填的。
>
> 目标拓扑：
>
> ```
> 客户浏览器 ──HTTPS/WSS──┐
>                          ▼
>                     nginx (80/443)
>                          │ 反代
>                          ▼
>                     relay (5081)  ←── 服务器，7×24
>                          ▲
>                          │ Agent 主动出站 WSS
>                          │
>          本地 Windows 主机（agent + 外贸易/autojs + 20 台手机）
> ```
>
> **只有 80/443 对外**。5081 和 5071 都不要对公网开放。

全程分三段，建议按顺序做，每段末尾都有验证动作：

| 段 | 在哪做 | 内容 | 首次耗时 |
| --- | --- | --- | --- |
| 一 | 服务器 | 装环境 → 起 relay → 域名 + HTTPS | 30~60 分钟 |
| 二 | 本机 | 配变量 → 起 agent → 手机上线 | 15 分钟 |
| 三 | 浏览器 | 建客户、分配设备、开权限 | 5 分钟 |

---

## 第 0 步：先决定服务器放哪（这一步决定后面全部）

**大陆节点上，域名必须 ICP 备案才能访问。** 这是硬约束：未备案域名解析到
境内服务器，云厂商会阻断域名访问，被查到还可能要求整改甚至关停。而备案本身
有两道时间门槛：

1. **境外注册商的域名不能直接备案**，必须先转入国内注册商；
2. 域名**注册未满 60 天不能转移**。

所以「境外买的域名 + 大陆服务器 + 想马上用域名」是无解的。三选一：

| 方案 | 域名可用 | 代价 |
| --- | --- | --- |
| **香港 / 海外节点** | 立刻 | 免备案。大陆访客延迟略高，视频上传跨境 |
| **国内注册商新买域名 + 备案** | 约 2~4 周 | 新注册的域名可立即备案，不用等转移 |
| **只用 IP 访问** | — | 零风险，但没 HTTPS、客户要记 IP |

下文两个方案都适用，只有第 5 步的域名部分不同。

> 查当前节点在大陆还是境外：
> `curl -s https://ipinfo.io/<你的IP>/json` → `country` 是 `CN` 就是大陆。

---

# 第一部分：服务器

## 1. 买机器 + 配安全组

腾讯云「轻量应用服务器」或「CVM」：

- 镜像：**Ubuntu 22.04 LTS**（24.04 也行）
- 规格：**2 核 4G 起**。`npm ci` 要给 `better-sqlite3` 编译兜底，
  1G 内存容易 OOM
- 磁盘：**50G 起**。每个客户上传的视频都在服务器留一份，且目前不做自动清理
- 地域：按第 0 步的决定选

**安全组 / 防火墙放行**：

| 端口 | 用途 | 是否必须 |
| --- | --- | --- |
| 22 | SSH | 必须 |
| 80 | HTTP，**certbot 续期要用** | 必须 |
| 443 | HTTPS / WSS | 必须 |
| 5081 | relay 直连 | **不要开** |
| 5071 | agent 本机接口 | **不要开** |

> ⚠️ 只放行 443 是不够的。certbot 每 60 天续期时要走 80 端口做校验，
> 关掉 80 会让证书在三个月后突然过期。

---

## 2. 初始化服务器

```bash
ssh ubuntu@<服务器IP>

# 克隆代码（仓库是公开的，不需要配密钥）
cd ~
git clone https://github.com/mackay0633-crypto/remote-phone-control.git
cd remote-phone-control

# 一条命令装齐环境
sudo bash deploy/bootstrap.sh
```

`bootstrap.sh` 做四件事，**可重复执行**：

1. 装 `nginx` / `certbot` / `sqlite3` / `git` / `curl` / `build-essential`
2. 装 **Node 20**（已装对版本就跳过）
3. 装 `pm2`
4. 建好 `/var/www/certbot`（ACME 校验）与 `/var/www/remote-phone-control`（前端产物）

**验证**：

```bash
node -v      # 期望 v20.x
nginx -v     # 期望 nginx/1.18 或更高
pm2 -v       # 期望 5.x 或更高
```

> ⚠️ **Node 版本别乱升。** 开发时用 Node 24 选了 `node:sqlite`，部署到 Node 20
> 直接 `ERR_UNKNOWN_BUILTIN_MODULE`；`better-sqlite3@13` 又要求 Node ≥22。
> 现在是 `better-sqlite3@12` + `process.loadEnvFile`，在 Node 20 上都成立。
> 换大版本前先跑一遍 relay 的测试套件。

---

## 3. 写 relay 配置

变量有五六个，全塞命令行很容易漏，统一写进 `relay/.env`
（已被 `.gitignore` 忽略，`git pull` 不会碰它）。

⚠️ **不要用 `cat > relay/.env` 覆盖** —— `>` 是截断写入。
配过一次 SMTP 之后再被模板覆盖，就只剩模板里那几行，relay 会直接
拒绝启动（`MAIL_TRANSPORT=smtp 时必须设置环境变量 SMTP_HOST`），
而你会以为是自己没配。**用编辑器改**：

```bash
cd ~/remote-phone-control

# 先生成视频通道的共享密钥，抄下这个值，本机要用同一个
openssl rand -hex 32

nano relay/.env      # 不存在会自动新建
```

要写入的内容：

```ini
# 初始管理员。只在「库里还没有管理员」时生效
ADMIN_PASSWORD=换成你的强密码

# 视频下发通道的共享密钥，必须与本机 agent 上的完全一致
AGENT_SECRET=把上面 openssl 的输出贴这里

# 生产必须设：不设时 relay 会把注册验证码直接放进接口响应里方便调试
NODE_ENV=production

# 邮件通道，见第 6 步；先留 console 也能跑，但客户无法自助注册
MAIL_TRANSPORT=console
```

核对：

```bash
grep -v '^#' relay/.env | grep .
```

> 只在**全新机器**上才可以用下面这种写法（文件已存在时它会清空内容）：
>
> ```bash
> [ -f relay/.env ] && echo "已存在，请用 nano 编辑" || cat > relay/.env <<'ENV'
> ...内容...
> ENV
> ```

> **优先级**：真实环境变量 > `relay/.env`。加载用的是 Node 内建的
> `process.loadEnvFile`（需 Node 20.12+），所以「pm2 注入」和「.env」可以共存。
>
> ⚠️ **别用 `AGENT_SECRET=xxx pm2 restart`** —— pm2 重启用的是它自己存下来的
> 一份环境变量，不读你当前 shell 的，改不上去。写 `.env` 再 `pm2 restart`
> 才有效（relay 每次启动都重读 `.env`）。

---

## 4. 一键部署

```bash
bash deploy/deploy.sh
```

五个动作：`git pull` → `npm ci` → 构建前端 → 发布到 `/var/www` → 启动/重启 relay。

首次会自动 `pm2 start`（不用再手动起），最后做健康检查并最多等 20 秒。

**验证**：

```bash
pm2 logs remote-phone-relay --lines 30 --nostream
```

必须能看到这四行（**第二行是关键**，没有它就说明 `.env` 没被读到）：

```
[relay] server ready at http://0.0.0.0:5081
[relay] env file: /home/ubuntu/remote-phone-control/relay/.env
[relay] database: data/relay.db
[relay] api: /api/auth/*, /api/admin/*, /api/my/devices
```

再直接打一次（绕过 nginx，确认 relay 本身活着）：

```bash
curl -s http://127.0.0.1:5081/health
# 期望 {"ok":true,"agents":0,"devices":0}
```

> ⚠️ **服务器上永远用 `npm ci`，不要用 `npm install`。**
> 后者会改写 `package-lock.json`，下次 `git pull` 就报
> 「local changes would be overwritten」。
>
> ⓘ `npm ci` 会先删 `node_modules`，期间站点可能短暂 502，属正常。

**首次启动会创建管理员**：`ADMIN_USERNAME` 默认 `admin`，
密码取自 `.env` 的 `ADMIN_PASSWORD`；没设就随机生成并**只在日志里出现一次**。
忘了密码就改 `.env` 再 `pm2 restart`（只在无管理员时生效），
或用另一个管理员在后台重置。

现在先设开机自启：

```bash
pm2 save
pm2 startup      # 按它输出的那行命令再执行一次
```

---

## 5. 配域名 + HTTPS

**前提：DNS 已经指向这台服务器。** 在域名商（如 NameSilo）的 DNS Records 里：

| Type | Host | Value | TTL |
| --- | --- | --- | --- |
| A | `@` | 服务器 IP | 3600 |
| A | `www` | 服务器 IP | 3600 |

确认生效（**必须先生效，否则证书校验一定失败**）：

```bash
nslookup jyglobal.top 8.8.8.8
```

然后一条命令搞定域名 + 证书：

```bash
sudo bash deploy/setup-nginx-domain.sh jyglobal.top <你的邮箱>
# 不想要 www 就加 --no-www
```

脚本按四步走，其中第一步是**必要的绕路**：

1. 先装一份**只有 80 端口**的配置（不引用证书，所以 `nginx -t` 能过），
   并删掉 Ubuntu 自带的 `sites-enabled/default`
2. `certbot certonly --webroot` 签证书
3. 把 `deploy/nginx.conf.example` 里的域名替换成你的，装成 80 + 443 完整配置
4. 自查：打印证书到期时间，并 `curl https://jyglobal.top/health`

**验证**：

```bash
curl -s https://jyglobal.top/health
# 期望 {"ok":true,"agents":0,"devices":0}
```

`agents` 还是 0 是对的 —— 本机 agent 还没连（第二部分做）。

> **为什么不能直接把 `nginx.conf.example` 拷过去？**
> 它引用了 `/etc/letsencrypt/live/jyglobal.top/fullchain.pem`，而证书还不存在，
> `nginx -t` 直接失败；可 certbot 的 webroot 校验又需要 nginx 已经在 80
> 端口提供服务 —— 死锁。脚本的第一步就是打破它。

> ⚠️ **`reload` 有时不生效**（旧 worker 继续用旧配置）。
> 改完配置行为没变就用 `sudo systemctl restart nginx`。这个坑排查了很久。

---

## 6. 配置邮件发送（否则客户无法自助注册）

第 3 步里 `MAIL_TRANSPORT=console` 时，验证码只打印进 relay 日志，
**对外服务时注册流程走不完**。换成真实 SMTP：

```bash
cd ~/remote-phone-control
# 编辑 relay/.env，把 MAIL_TRANSPORT 改成 smtp 并补上这几项
nano relay/.env
```

```ini
MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.exmail.qq.com
SMTP_PORT=465
SMTP_USER=noreply@your-domain.com
SMTP_PASS=<授权码，不是邮箱登录密码>
SMTP_FROM=noreply@your-domain.com
# SMTP_SECURE 不填时按端口推断：465 = 隐式 TLS，587 = STARTTLS
```

```bash
pm2 restart remote-phone-relay
pm2 logs remote-phone-relay --lines 20 --nostream
# 期望看到 [relay] mail: smtp（smtp.exmail.qq.com:465）
```

要点：

- 多数邮箱服务商要的是**授权码**，不是登录密码
- `SMTP_FROM` 必须与 `SMTP_USER` 一致，否则被直接拒收
- 6 位数字验证码非常像营销邮件，**发信域名务必配好 SPF / DKIM / DMARC**，
  否则大概率进垃圾箱
- 配置写错时 relay **拒绝启动**，而不是悄悄退回 console —— 这是有意的
- 不配 SMTP 也能用：管理员在后台直接建客户，邮箱留空即可（第 10 步）

### 让收件箱显示「外贸易」而不是光秃秃的邮箱地址

邮件标题是 `【外贸易】注册验证码`，但**客户在收件箱列表里第一眼看到的是发件人**，
默认会显示成 `noreply@your-domain.com`。加个显示名就能变成「外贸易」：

```ini
SMTP_FROM=外贸易 <noreply@your-domain.com>
```

`Name <addr>` 是标准写法，nodemailer 直接支持。地址部分必须与 `SMTP_USER`
一致（163 等会校验），但显示名可以是任意文字。改完 `pm2 restart`。

---

# 第二部分：本机（接手机的 Windows 主机）

## 7. 前置：三个东西必须先跑起来

| 组件 | 作用 | 检查方式 |
| --- | --- | --- |
| **adb** | 连接手机 | `adb devices` 能看到 20 台 |
| **scrcpy-server** | 实时画面与触控 | 文件存在即可 |
| **外贸易（autojs-controller）** | 养号 / 发视频脚本 | `curl http://127.0.0.1:5000/health` 返回 200 |

> ⚠️ **外贸易必须已完成激活**。未激活时它对几乎所有接口返回 403，
> 自动化面板会报「autojs 未激活，请先在这台主机上完成激活」。
>
> ⚠️ **手机上的 TikTok 账号要已登录**。「发视频」的账号下拉列表是从外贸易
> 的 `/api/accounts` 读的，读不到就发不出去。
>
> ⓘ 本项目**从不修改** `autojs-controller` 的任何文件；所有输入校验都在
> agent 侧完成（见 `docs/autojs-input-validation.md`）。

---

## 8. 配环境变量（只做一次）

```powershell
# 工具路径
setx ADB_PATH           "C:\Program Files\Laixi\tools\platform-tools\adb.exe"
setx SCRCPY_PATH        "C:\Users\admin\Desktop\scrcpy-win64-v3.3.4\scrcpy.exe"
setx SCRCPY_SERVER_PATH "C:\Users\admin\Desktop\scrcpy-win64-v3.3.4\scrcpy-server"

# 手机：ADB over TCP 的地址范围，格式 <起始IP>-<结束IP>:<端口>
setx DEVICE_TCP_RANGE   "192.168.9.41-60:65535"

# 中继地址。有 HTTPS 就是 wss，没有就是 ws
setx RELAY_SERVER_WS_URL "wss://jyglobal.top/ws/agent"

# 视频通道：必须与服务器 relay/.env 里的 AGENT_SECRET 完全一致
setx AGENT_SECRET       "<第 3 步生成的密钥>"

# 视频在本机的暂存目录。默认 %TEMP%\remote-phone-media，
# 每个视频都会在本机也留一份，建议放到非系统盘
setx MEDIA_DIR          "D:\remote-phone-media"

# 多台主机时才需要区分；单机可以不设（默认 agent-local）
setx AGENT_ID           "pc-01"
```

> ⚠️ **`setx` 只对新开的窗口生效** —— 设完必须**关掉当前 PowerShell 重开**。

**验证**（新窗口里）：

```powershell
echo $env:DEVICE_TCP_RANGE
echo $env:AGENT_SECRET.Length    # 期望 64；输出 0 说明没设上
echo $env:RELAY_SERVER_WS_URL
```

---

## 9. 启动 agent

```powershell
cd D:\projects\remote-phone-control
git pull
.\scripts\start-agent.ps1
```

启动脚本会**逐项检查并打印就绪状态**，缺什么就直接告诉你该设哪一条：

```
  [就绪] ADB_PATH
  [就绪] SCRCPY_PATH
  [就绪] SCRCPY_SERVER_PATH
  [就绪] RELAY_SERVER_WS_URL = wss://jyglobal.top/ws/agent
  [就绪] AGENT_ID = pc-01
  [就绪] DEVICE_TCP_RANGE = 192.168.9.41-60:65535
  [就绪] AGENT_SECRET（已设置，64 位）
  [就绪] MEDIA_DIR = D:\remote-phone-media
```

然后看 agent 自己的启动日志，**这两行决定「发视频」能不能用**：

```
[agent] media dir: D:\remote-phone-media
[agent] video download: https://jyglobal.top / secret configured
```

| 日志 | 含义 |
| --- | --- |
| `secret configured` | 正常 |
| `secret MISSING` | `AGENT_SECRET` 没设上，发视频会 401 |
| `video download: disabled` | `RELAY_SERVER_WS_URL` 没设上 |

最后一行应该是：

```
[agent] keepalive: enabled, 60000ms interval -> 192.168.9.41:65535, ... (20 total)
[agent] api ready at http://127.0.0.1:5071
```

也可以临时覆盖而不动持久变量：

```powershell
.\scripts\start-agent.ps1 -RelayUrl "wss://jyglobal.top/ws/agent" -Secret "<密钥>"
```

---

## 10. 确认设备真的上线了

服务器上：

```bash
curl -s https://jyglobal.top/health
# 期望 {"ok":true,"agents":1,"devices":20}
```

`agents` 还是 0 就说明本机没连上，对照排查：

| 现象 | 原因 |
| --- | --- |
| agent 日志刷 `ECONNREFUSED` | relay 没起，或地址写错端口 |
| 一直重连、`agents:0` | 用了 `ws://` 但服务器是 HTTPS。改为 `wss://` |
| `devices:0` 但 `agents:1` | adb 连不上手机，查 `DEVICE_TCP_RANGE` 与手机是否同网段 |

---

# 第三部分：开通账号（浏览器）

打开 `https://jyglobal.top`，用管理员登录（用户名 `admin` + `.env` 里的密码）。

顶栏会出现「控制台 / 自动化 / 管理」三个入口。

## 11. 建客户

两条路：

- **客户自助注册**：需要第 6 步的 SMTP 已配好。注册是两步 —— 先发邮箱验证码，
  再带码建号。
- **管理员直接建**：「管理 → 用户 → 新建」，填用户名密码即可，邮箱可留空
  （视为已验证，相当于人工担保）。

> ⚠️ **新账号默认「什么都没有」**：六项权限全为 false，配额
> `maxDevices = 0`。所以新建完必须做第 12~14 步，否则客户登录后
> 既看不到设备也没有任何操作入口。

## 12. 先设配额（**必须在分配设备之前**）

「管理 → 用户」→ 点客户 → 配额：

| 配额 | 默认 | 说明 |
| --- | --- | --- |
| `maxDevices` | **0** | 最多分配几台 |
| `maxConcurrentTasks` | 1 | 并发任务数 |
| `maxStorageBytes` | 0 | 视频素材总容量上限，**0 表示不限** |

> ⚠️ **顺序不能反。** 分配设备时会校验 `maxDevices`，而新账号是 0，
> 直接去分配会失败并报「超出配额：xxx 最多 0 台」——看起来像是个 bug，
> 其实只是配额还没放开。**先改 `maxDevices`，再去分配设备。**

## 13. 分配设备

「管理 → 设备」→ 选中设备 → 指定给某个客户。

客户能操作的设备集合**就是这个集合**，没有别的途径：多租户隔离是基于
「设备归属」推导出来的，客户既看不到也操作不了没分给自己的设备。

- 分配失败报「已分配给其它账号」→ 先去原账号那里收回
- 收回设备后，该客户的设备列表**实时刷新**
- 收回查看权限、或禁用账号，会**立即断开**该客户正在进行的连接和画面流

## 14. 开权限

「管理 → 用户」→ 点客户 → 勾选：

| 能力 | 作用 |
| --- | --- |
| `can_view_devices` | 看到自己的设备列表（**基础权限，其余都依赖它**） |
| `can_view_stream` | 看实时画面 |
| `can_control_input` | 点击 / 滑动 / 按键 |
| `can_run_dayil` | 下发养号任务 |
| `can_send_video` | 下发发视频任务 |
| `can_upload_video` | 上传视频素材 |

> **最小可用组合**：
> 看画面 + 操控 → `can_view_devices` + `can_view_stream` + `can_control_input`
> 要养号 → 再加 `can_run_dayil`
> 要发视频 → 再加 `can_upload_video` + `can_send_video`
>
> 权限改动**实时生效**（服务端用 `access epoch` 立刻通知在线连接，
> 不需要客户重新登录）。

---

# 第四部分：验收

## 15. 逐项检查

### 先确认部署真的生效

`deploy.sh` 跑完**不等于**新版本真的上线了。它中途失败会直接中止
（开头是 `set -euo pipefail`），但如果你只瞥了一眼开头就以为成了，
就会对着旧页面找半天问题。三条命令分别验证三段：

```bash
# 1) 线上页面：nginx 真的在提供新产物
curl -s https://jyglobal.top | grep -o '<title>[^<]*</title>'
#   期望 <title>外贸易</title>

# 2) 发布目录：打包产物确实被换掉了
ls -l --time-style=long-iso /var/www/remote-phone-control/index.html
grep -l '外贸易' /var/www/remote-phone-control/assets/*.js
#   期望打印出 index-<hash>.js，且 index.html 的时间是刚刚

# 3) relay：新代码在跑，邮件仍是 smtp 模式
pm2 logs remote-phone-relay --lines 12 --nostream | grep -E 'mail:|server ready'
#   期望 [relay] server ready at ... 与 [relay] mail: smtp（...）
```

为什么值得单独列出来：**前端有两份副本** —— 仓库里的 `web/dist`，和 nginx
实际读的 `/var/www/remote-phone-control`。它们最容易不同步（改了代码忘了发布
是这里最常见的失误），所以第 2 条刻意查 `/var/www` 那一份，**查仓库里的
`web/dist` 没有意义**。`deploy.sh` 的存在就是为了消除这个风险，但前提是你
确实跑了它、而且它跑完了。

> 第 1 条如果还是旧标题，先 `Ctrl+Shift+R` 强刷再判断。
> 正常情况下不需要：`index.html` 是 `no-store`，打包产物文件名带内容哈希，
> 构建一变文件名就变。真的一直是旧的，才说明第 4 步发布失败。

### 完整验收表

| # | 检查项 | 期望 |
| --- | --- | --- |
| 1 | `curl https://jyglobal.top/health` | `{"ok":true,"agents":1,"devices":20}` |
| 2 | 浏览器打开 `https://jyglobal.top` | 有锁标（证书有效），出登录页 |
| 3 | 管理员登录 | 顶栏出现「控制台 / 自动化 / 管理」 |
| 4 | 「管理 → 设备」 | 20 台全部在线、已分配状态正确 |
| 5 | 客户登录 | 只看到分配给自己的设备 |
| 6 | 点设备 → 实时画面 | 能看到手机屏幕，点一下手机有反应 |
| 7 | 自动化 → 养号 → 选设备 → 下发 | 返回 `script_run_id`，手机开始刷 |
| 8 | 自动化 → 发视频 → 上传 mp4 | 进度条走完，素材出现在列表里 |
| 9 | 选素材 + 设备 + 账号 → 下发 | 返回 `script_run_id`；agent 日志出现 `[agent] video <id> -> <路径>` |
| 10 | 管理员收回客户的查看权限 | 客户那边**立刻**失去画面，不用重新登录 |

## 16. 故障对照

| 现象 | 排查方向 |
| --- | --- |
| 站点 502 | relay 没起：`pm2 logs remote-phone-relay --lines 50 --nostream` |
| `curl` 返回 **000**、`pm2 list` 里 ↺ 次数暴涨 | relay **启动即崩**、被 pm2 反复重启。看 `~/.pm2/logs/remote-phone-relay-error.log`。最常见原因是 `MAIL_TRANSPORT=smtp` 但 `SMTP_*` 没配全（或整行被 `#` 注释了） |
| `MAIL_TRANSPORT=smtp 时必须设置环境变量 SMTP_HOST` | 去 `relay/.env` 检查 `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` 三行是否都在、都没被 `#` 注释 |
| `relay/.env` 里配置莫名变少了 | 用 `cat > relay/.env` 覆盖过。`>` 是截断写入，改用 `nano` |
| 站点 403 Forbidden | nginx 读不到 `/var/www`，或有 `sites-enabled/default` 抢匹配 |
| 改配置不生效 | 用 `systemctl restart nginx`，不要 `reload` |
| 浏览器显示旧界面 | 产物没发布（跑 `deploy.sh`），或 `index.html` 被缓存 |
| 客户看不到设备 | 第 12~14 步没做完：配额 `maxDevices` 或 `can_view_devices` |
| 分配设备报「最多 0 台」 | 先改 `maxDevices` 再分配（见第 12 步） |
| 分配设备报「已分配给其它账号」 | 先去原账号收回 |
| 客户点设备没反应 | 缺 `can_control_input` 或 `can_view_stream` |
| 上传视频 413 | nginx `client_max_body_size`；或超出 `maxStorageBytes` |
| 上传/下发 401 | 两端 `AGENT_SECRET` 不一致 |
| 下载 503 | 服务器 `relay/.env` 没被读到（看有没有 `env file:` 日志） |
| `video download: disabled` | 本机 `RELAY_SERVER_WS_URL` 没设 |
| 账号下拉是空的 | 外贸易没跑，或手机上没登录账号 |
| 「autojs 未激活」 | 主机上的外贸易需要先完成激活 |
| 「所选视频存在同名文件」 | 同一批里两个视频规范化后同名，改名重传 |
| 收不到注册验证码 | `MAIL_TRANSPORT=console`，或 SPF/DKIM 没过（进垃圾箱） |
| `deploy.sh` 在「[1/5] 拉取代码」就退出 | `git pull` 失败会因 `set -e` 中止整个脚本（**好消息是 relay 没被动过，站点无中断**）。修好拉取再重跑 |
| `git pull` 报 `GnuTLS recv error (-110)` / `Empty reply from server` / `Connection was reset` | 到 github.com 的 HTTPS 被掐。先 `git config --global http.version HTTP/1.1` 重试；仍不通就换 SSH（见下） |
| 需要长期稳定的拉取通道 | 给服务器配一把部署密钥，remote 换成 SSH。GitHub：仓库 → Settings → Deploy keys（只拉代码就别勾 write access）。443 入口：`ssh://git@ssh.github.com:443/...` |

---

# 附录 A：日常运维

```bash
cd ~/remote-phone-control

# 更新代码（拉取 → 装依赖 → 构建 → 发布 → 重启，一步不漏）
bash deploy/deploy.sh

# 日志 / 重启
pm2 logs remote-phone-relay
pm2 restart remote-phone-relay
pm2 status
```

> **只做更新就永远只有这一条命令。** 它固定做五件事，只改后端也会重建前端、
> 只改前端也会重启 relay —— 都是无害的。这是故意的：宁可多做一个动作，
> 也不要因为「这次只改了 XX」而漏掉某一步。忘了发布前端产物是这里最常见的失误。
>
> 跑的时候 `npm ci` 会先删 `node_modules`，站点会短暂 502，几秒到几十秒。
>
> `git pull` 是脚本的第一步，也是唯一会「静默中止整个脚本」的一步
> （`set -e`）。拉取失败时站点不会中断，但也**什么都没更新** ——
> 拼错脚本名、GitHub 连不上都会走到这里，详见第 16 节故障对照。

**备份 / 搬迁数据**（账号 + 设备归属 + 视频素材）：

```bash
# 备份，产出 relay-data-<时间戳>.tar.gz
bash deploy/relay-data.sh export

# 恢复到另一台机器
bash deploy/relay-data.sh import ~/relay-data-20260916-120000.tar.gz
```

它比手工 `sqlite3 .backup` 多做两件必要的事：用在线备份接口生成**自包含**的库
（不停 relay），并数一遍表，读不出表就直接失败；导入前先 `pm2 stop`，
把现有数据改名留档。

> ⚠️ **别用 `cp relay.db` 备份。** relay 跑在 WAL 模式，最新事务都还在
> `.db-wal` 里，`.db` 本身可能只有 4KB 的文件头。裸拷 + 只还原 `.db` 会得到
> 一张表都没有的空库，**而全过程没有任何报错**。

**证书续期**（apt 装的 certbot.timer 自动做，可自查）：

```bash
systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

---

# 附录 B：环境变量总表

## 服务器 `relay/.env`

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 随机（打印一次） | 初始管理员密码，仅首次建库生效 |
| `ADMIN_USERNAME` | `admin` | 初始管理员用户名 |
| `AGENT_SECRET` | 空 | 视频下载通道共享密钥；空则下载 503 |
| `NODE_ENV` | — | **生产必须 `production`**，否则验证码随接口回显 |
| `MAIL_TRANSPORT` | `console` | `smtp` 才真正发信 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — | `smtp` 模式下缺任一 relay 拒绝启动 |
| `RELAY_HOST` / `RELAY_PORT` | `0.0.0.0` / `5081` | 监听地址 |
| `RELAY_DB_FILE` | `data/relay.db` | 相对 `relay/` 解析 |
| `RELAY_MEDIA_DIR` | `data/videos` | 相对 `relay/` 解析 |
| `VIDEO_MAX_BYTES` | `536870912`（512MB） | 单文件上限，要与 nginx 对齐 |
| `AUTOMATION_TIMEOUT_MS` | 10 分钟 | relay 等 agent 回执的上限 |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MINUTES` | `10` / `15` | 登录限流 |
| `REGISTER_MAX_ATTEMPTS` / `REGCODE_MAX_ATTEMPTS` / `RESET_MAX_ATTEMPTS` | `10` / `5` / `10` | 注册、发码、重置限流 |

## 本机（Windows，用 `setx`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADB_PATH` | `adb`（PATH） | adb 可执行文件 |
| `SCRCPY_PATH` / `SCRCPY_SERVER_PATH` | `scrcpy` / `scrcpy-server` | 画面与触控 |
| `DEVICE_TCP_RANGE` | 空（关闭保活） | `192.168.9.41-60:65535` |
| `RELAY_SERVER_WS_URL` | 空（不连 relay） | `wss://jyglobal.top/ws/agent` |
| `AGENT_SECRET` | 空 | 必须与服务器一致 |
| `MEDIA_DIR` | `%TEMP%\remote-phone-media` | 视频暂存 |
| `AGENT_ID` | `agent-local` | 多主机时区分 |
| `AUTOJS_BASE_URL` | `http://127.0.0.1:5000` | 外贸易地址 |
| `AUTOJS_TIMEOUT_MS` | `300000` | 含 adb push，给足时间 |
| `AGENT_HOST` / `AGENT_PORT` | `127.0.0.1` / `5071` | 本机接口，不要对外 |
| `DEVICE_KEEPALIVE_INTERVAL_MS` / `_CONCURRENCY` | `60000` / `4` | ADB 保活 |
| `STREAM_MAX_SIZE` / `STREAM_BIT_RATE` | `720` / `2000000` | 画面质量与码率 |

---

# 附录 C：安全加固（上线前逐条确认）

1. **`NODE_ENV=production`** —— 不设时注册验证码会随接口回显，是取码后门
2. **安全组只开 22 / 80 / 443** —— 5081、5071 不对公网开放
3. **`ADMIN_PASSWORD` 用强密码**，不要留在 shell 历史里
4. **配置 SPF / DKIM / DMARC** —— 否则验证码进垃圾箱
5. **SSH 改密钥登录、关密码登录**，`fail2ban` 可选
6. **`/ws/agent` 目前没有鉴权** —— 任何知道地址的人都能伪装成 agent 上报设备。
   内网/可信来源部署可接受，公网长期建议加共享密钥（尚未实现）
7. **视频素材不做自动清理** —— 定期看 `df -h` 与
   `du -sh ~/remote-phone-control/relay/data/videos`
8. **定期备份** —— `bash deploy/relay-data.sh export` 并下载到本地
