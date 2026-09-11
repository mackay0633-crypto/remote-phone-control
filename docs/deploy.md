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

## 1. 服务器准备

```bash
# Node 20+（better-sqlite3@12 支持 20.x / 22.x / 24.x）
node --version

# nginx
sudo apt update && sudo apt install -y nginx

# 构建前端需要用到，也顺便给原生模块编译兜底
sudo apt install -y build-essential python3
```

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

## 3. 构建前端

```bash
npm run build --workspace web
```

产物在 `web/dist/`。

**不需要设置任何构建时变量** —— 前端会按页面来源自动判断：

| 打开地址 | 行为 |
|---|---|
| `localhost:5173`（开发） | 本地直连模式，连本机 Agent 5071 |
| 任何其它域名 | 同源中继模式，`/api` 与 `/ws` 都打到当前域名 |

所以同一份 `dist` 部署到哪个域名都能用，换域名也不用重新构建。

---

## 4. 配置 nginx

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/remote-phone-control
sudo nano /etc/nginx/sites-available/remote-phone-control     # 改 your-domain.com
sudo ln -sf /etc/nginx/sites-available/remote-phone-control /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default                   # 去掉默认站点
sudo nginx -t && sudo systemctl reload nginx
```

配置里三个容易漏的点：

1. **`/ws/` 必须带 `Upgrade` 与 `Connection` 头** —— 缺了 WebSocket 握手直接失败
2. **`proxy_read_timeout 3600s`** —— 视频流是长连接，nginx 默认 60 秒无数据就掐断
3. **`client_max_body_size 512m`** —— 将来加视频上传时，默认的 1MB 会直接 413

---

## 5. 申请证书

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

证书就位后上面的 HTTPS 段才可用。临时自签也能跑通，但浏览器会警告。

---

## 6. 启动 relay

```bash
# 首次启动会创建管理员并打印密码
pm2 start npm --name remote-phone-relay -- run relay:start

# 或者指定管理员密码（推荐，免得每次从日志里抄）
ADMIN_PASSWORD='<你的强密码>' pm2 start npm --name remote-phone-relay -- run relay:start
```

日志里应该有：

```
[relay] server ready at http://0.0.0.0:5081
[relay] database: data/relay.db
[relay] api: /api/auth/*, /api/admin/*, /api/my/devices
```

**记得 `pm2 save`**，否则重启服务器后不会自动拉起：

```bash
pm2 save
pm2 startup     # 按提示执行输出的那行命令
```

---

## 7. 本地 Agent 连接

在**本地 Windows 主机**上（接手机那台），起一个新窗口：

```powershell
# 只需设一次，持久生效
setx ADB_PATH           "C:\path\to\platform-tools\adb.exe"
setx SCRCPY_PATH        "C:\path\to\scrcpy.exe"
setx SCRCPY_SERVER_PATH "C:\path\to\scrcpy-server"
setx DEVICE_TCP_RANGE   "10.0.0.41-60:5555"

# 每次启动
cd D:\projects\remote-phone-control
$env:RELAY_SERVER_WS_URL = "wss://your-domain.com/ws/agent"   # 注意是 wss
$env:AGENT_ID = "pc-01"
npm run agent:server
```

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

---

## 9. 日常运维

```bash
pm2 logs remote-phone-relay          # 看日志
pm2 restart remote-phone-relay       # 重启
```

**更新代码**：

```bash
cd ~/remote-phone-control
git pull
npm ci
npm run build --workspace web
pm2 restart remote-phone-relay
```

**数据库备份**（含账号、设备归属、审计日志）：

```bash
# SQLite 用了 WAL，备份时连 -wal / -shm 一起拿，或者先 checkpoint
sqlite3 ~/remote-phone-control/relay/data/relay.db ".backup /tmp/relay-backup.db"
```

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
