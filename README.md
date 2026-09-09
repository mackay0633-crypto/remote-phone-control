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
