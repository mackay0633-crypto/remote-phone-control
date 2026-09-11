# remote-phone-control

Android 手机远程 Web 群控系统的第一阶段骨架工程。

当前已完成：

- Phase 1 环境检查结论落档
- 项目基础目录结构
- `agent` 设备发现模块
- `agent` 本地 HTTP / WebSocket 设备接口
- `web` 本地设备仪表盘
- `relay` 云端中继服务骨架（Agent 上行、Viewer 拉流、控制回传）

## 目录

- `agent/` Windows 侧本地 Agent
- `relay/` 服务器侧中继服务
- `web/` 本地浏览器端界面
- `shared/` 共享类型
- `docs/` 架构与阶段文档

## 快速开始

在项目根目录执行：

```powershell
npm install
npm run agent:devices
```

启动本地 Agent 服务：

```powershell
npm run agent:server
```

启动前端页面：

```powershell
npm run web:dev
```

启动云端中继服务：

```powershell
npm run relay:dev
```

## Agent 环境变量

Agent 依赖的 adb / scrcpy 位置**不写死在源码里**，请用环境变量指定：

```powershell
$env:ADB_PATH           = "C:\path\to\platform-tools\adb.exe"
$env:SCRCPY_PATH        = "C:\path\to\scrcpy.exe"
$env:SCRCPY_SERVER_PATH = "C:\path\to\scrcpy-server"
```

未设置时回退到 PATH 里的 `adb` / `scrcpy`。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `ADB_PATH` | PATH 中的 `adb` | adb 可执行文件 |
| `SCRCPY_PATH` | PATH 中的 `scrcpy` | scrcpy 可执行文件 |
| `SCRCPY_SERVER_PATH` | PATH 中的 `scrcpy-server` | scrcpy-server |
| `AGENT_HOST` / `AGENT_PORT` | `127.0.0.1` / `5071` | 本地 HTTP / WebSocket 监听 |
| `DEVICE_POLL_INTERVAL_MS` | `5000` | 设备轮询间隔 |
| `STREAM_MAX_SIZE` / `STREAM_BIT_RATE` | `720` / `2000000` | 视频流参数 |
| `AUTOJS_BASE_URL` | `http://127.0.0.1:5000` | autojs-controller 地址 |
| `AUTOJS_TIMEOUT_MS` | `300000` | autojs 请求超时（发视频含 push，留足时间） |
| `RELAY_SERVER_WS_URL` / `AGENT_ID` | 空 / `agent-local` | 中继模式 |

## ADB over TCP 设备保活

设备以 ADB over TCP 接入时，连接只存在于 adb server 的内存中。server 一旦重启，
全部设备会消失且不会自动恢复。配置地址段即可让 Agent 自动补齐并持续保活：

```powershell
$env:DEVICE_TCP_RANGE="192.168.9.41-60:65535"
npm run agent:server
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DEVICE_TCP_RANGE` | 空（关闭） | 设备地址段，逗号分隔多条 |
| `DEVICE_TCP_PORT` | `5555` | 条目未显式带端口时的默认端口 |
| `DEVICE_KEEPALIVE_INTERVAL_MS` | `60000` | 检查间隔，最小 5000 |
| `DEVICE_KEEPALIVE_CONCURRENCY` | `4` | 并发 connect 数，上限 16 |

状态查询：`GET /api/devices/keepalive`

详见 `docs/device-keepalive.md`。

## 账号系统与设备隔离

relay 现在带账号体系：客户自助注册，管理员分配设备并开关权限。

```powershell
# 首次启动会自动创建管理员；不设 ADMIN_PASSWORD 则随机生成并在控制台打印一次
$env:ADMIN_USERNAME = "admin"
$env:ADMIN_PASSWORD = "<你自己设一个强密码>"
npm run relay:dev
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `RELAY_DB_FILE` | `data/relay.db` | SQLite 数据库路径（**不要提交**） |
| `ADMIN_USERNAME` | `admin` | 初始管理员用户名，仅首次启动生效 |
| `ADMIN_PASSWORD` | 随机生成 | 初始管理员密码，仅首次启动生效 |
| `LOGIN_MAX_ATTEMPTS` | `10` | 登录限流：每 IP / 每用户名 在窗口内的尝试次数 |
| `LOGIN_WINDOW_MINUTES` | `15` | 登录限流窗口（分钟） |
| `REGISTER_MAX_ATTEMPTS` | `10` | 注册限流：每 IP 每小时的次数 |

> **Node 版本要求**：`>= 20`（`better-sqlite3@12` 支持 20.x / 22.x / 23.x / 24.x+）。
> 数据库是原生模块，预编译包覆盖主流平台，启动前先在 relay 目录 `npm install`。
> 若预编译包缺失导致编译失败，装上工具链即可：`sudo apt install -y build-essential python3`。
>
> 跑自动化测试时记得放宽限流，否则多轮登录会撞 429：
> `$env:LOGIN_MAX_ATTEMPTS='1000'`

**隔离在服务端强制执行**：客户只能看到、并且只能操控分配给他的设备；
查看画面与手动操控各自独立开关；管理员改权限对已建立的连接**立即生效**。

浏览器登录界面已就绪，管理页面待做。详见：

- `docs/account-system.md` — 账号系统与管理 API
- `docs/relay-isolation.md` — WebSocket 隔离设计与验证
- `docs/web-console.md` — 浏览器控制台与登录

## 中继模式

当前支持两种模式：

1. 本地模式  
   `web` 直接连接本地 Agent 的 `127.0.0.1:5071`
2. 中继模式  
   `agent` 主动连接服务器上的 `relay`，浏览器再通过 `relay` 拉设备列表、视频流和控制通道

### Agent 连接 Relay

在启动 Agent 前设置：

```powershell
$env:RELAY_SERVER_WS_URL="ws://<server-host>:5081/ws/agent"
$env:AGENT_ID="pc-01"
npm run agent:server
```

### Web 连接 Relay

在启动前端前设置：

```powershell
$env:VITE_RELAY_WS_BASE_URL="ws://<server-host>:5081"
npm run web:dev
```

配置了 `VITE_RELAY_WS_BASE_URL` 后，前端会自动改为 relay 模式：

- 设备列表来自 Relay
- 视频流来自 Relay `/ws/viewer/stream`
- 输入控制通过 Relay 回传到 Agent
