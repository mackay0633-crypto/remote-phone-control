# remote-phone-control 项目说明文档（给 DeepSeek）

## 1. 项目是什么

`remote-phone-control` 是一个 Android 手机远程控制系统，目标是把一台或多台 Android 设备的画面和控制能力，通过一台 Windows 主机和一个中继服务器，暴露给浏览器端使用。

这个项目当前重点解决的是下面这条链路：

```text
Android -> Windows Agent -> Relay Server -> Browser
```

它不是一个单纯的“截图查看器”，而是一个面向远程操控的系统，核心能力包括：

- 发现 Android 设备
- 获取设备基础信息
- 将设备画面编码为 H.264 并推到浏览器
- 从浏览器发送点击、滑动、系统键等控制指令
- 支持本地直连模式和经服务器中继的公网模式
- 从一开始就按“多设备”场景设计

当前项目更像是一个“第一版可运行骨架 + 中继版主链路打通”的工程，已经能跑通设备发现、视频推流、控制回传和浏览器展示，但还有不少能力可以继续增强。

## 2. 这个项目要解决什么问题

作者希望实现一个基于浏览器的 Android 远程控制台，用于：

- 在 PC 端集中查看和操作 Android 手机
- 后续扩展到多台手机的群控/批量操作
- 让处于内网的 Agent 主动连外网服务器，从而实现公网访问
- 为后续更实时、更低延迟、更强控制能力的方案打基础

通俗地说，这个项目想做的是：

1. 手机上画面采集出来
2. 通过本地 Agent 或云端 Relay 转给浏览器
3. 浏览器端像操作真实手机一样发送触控和按键
4. 最终形成一个“远程手机控制面板”

## 3. 当前总体架构

项目采用分层架构：

```text
Android Device
  |- 通过 adb 获取设备信息
  |- 通过 adb exec-out screenrecord 输出 H.264 视频流
  |- 通过 scrcpy server 控制 socket 接收触控/按键
  v
Windows Agent
  |- 设备发现与状态维护
  |- 本地 HTTP / WebSocket 服务
  |- 连接 Relay，主动上报设备和转发流
  v
Relay Server
  |- 接收多个 Agent 的连接
  |- 汇总设备列表
  |- 管理 viewer 控制通道
  |- 管理 viewer 视频流订阅
  v
Browser Web UI
  |- 展示设备列表
  |- 选择设备
  |- 播放 H.264 画面
  |- 发送点击、滑动、Home/Back/Recent 等指令
```

### 3.1 两种运行模式

#### 本地模式

浏览器直接连接本机 Agent：

- HTTP: `http://127.0.0.1:5071`
- WS 控制: `ws://127.0.0.1:5071/ws`
- WS 视频: `ws://127.0.0.1:5071/ws/stream`

适合在本地开发和局域网场景中验证链路。

#### 中继模式

Agent 主动连接服务器上的 Relay，浏览器再去连 Relay：

- Agent -> Relay: `/ws/agent`
- Viewer 控制通道: `/ws/viewer`
- Viewer 视频通道: `/ws/viewer/stream`

这个模式主要是为公网访问准备的。因为 Agent 是主动出站连接，更适合部署在内网机器上。

## 4. 仓库目录说明

项目是一个 npm workspace monorepo，主要目录如下：

```text
agent/   Windows 侧本地代理
relay/   服务端中继
web/     浏览器端前端
shared/  共享类型
docs/    架构、协议和阶段文档
```

### 4.1 `agent/`

这是整个系统最关键的本地桥接层，职责包括：

- 发现 Android 设备
- 对外暴露本地 API 和 WebSocket
- 从 Android 拉视频流
- 执行来自浏览器或 Relay 的控制指令
- 在 Relay 模式下主动连接服务器

核心文件：

- `agent/src/main.ts`
- `agent/src/http/agent-server.ts`
- `agent/src/relay/relay-client.ts`
- `agent/src/device/*`
- `agent/src/input/input-manager.ts`
- `agent/src/stream/h264-stream-session.ts`
- `agent/src/scrcpy/scrcpy-control-manager.ts`

### 4.2 `relay/`

服务端中转模块，职责是：

- 接收 Agent 注册
- 汇总所有 Agent 上报的设备列表
- 将浏览器的控制命令转发给对应 Agent
- 将 Agent 上传的二进制 H.264 数据转给订阅者
- 做基本的流状态管理

核心文件：

- `relay/src/main.ts`

### 4.3 `web/`

浏览器端 UI，目前是 React + Vite 实现的单页控制台，职责包括：

- 展示全部设备
- 选中某台设备作为主控对象
- 通过 JMuxer 播放 H.264 数据
- 将鼠标/指针事件映射为设备坐标
- 发送触控、滑动和系统键控制

核心文件：

- `web/src/App.tsx`
- `web/src/styles.css`

### 4.4 `shared/`

目前主要用于共享设备类型定义：

- `shared/types/device.ts`

## 5. 技术栈与关键依赖

### 5.1 后端/Agent/Relay

- Node.js
- TypeScript
- `ws` 用于 WebSocket
- `tsx` 用于开发态直接运行 TS

### 5.2 前端

- React 19
- Vite
- `jmuxer` 用于在浏览器中喂入 H.264 Annex-B 流

### 5.3 Android 控制与视频来源

- `adb`
- `screenrecord --output-format=h264`
- `scrcpy-server`

这里要特别注意：

- 当前视频链路不是直接接 scrcpy 视频 socket
- 当前视频来源是 `adb exec-out screenrecord --output-format=h264`
- 当前控制链路则使用 scrcpy 的 control socket

也就是说，项目当前把“视频采集”和“控制注入”拆成了两条不同实现路径。

## 6. 当前实际实现细节

这一节很重要，因为它描述的是“代码里现在真的怎么做”，不是理想规划。

### 6.1 Agent 启动流程

`agent/src/main.ts` 的行为分两类：

#### 只列设备

执行 `npm run agent:devices` 时，会：

- 读取环境变量
- 初始化 ADB 客户端
- 列出已连接设备
- 输出设备信息 JSON

#### 启动服务

执行 `npm run agent:server` 时，会：

1. 启动设备轮询器 `DeviceTracker`
2. 如果配置了 `RELAY_SERVER_WS_URL`，则启动 `RelayClient`
3. 启动本地 `AgentServer`
4. 提供 HTTP / WS / 视频流服务

### 6.2 设备发现

Agent 通过 ADB 轮询设备，抽象出统一的设备信息，包括：

- `serial`
- `status`
- `model`
- `androidVersion`
- `width`
- `height`
- `streamStatus`
- `controlStatus`
- `transport` (`usb` / `tcp`)

这说明项目从一开始就考虑了 USB 和 ADB over TCP 的统一建模。

### 6.3 本地 Agent API 与 WS

`agent/src/http/agent-server.ts` 当前提供：

#### HTTP

- `GET /health`
- `GET /api/devices`
- `POST /api/devices/:serial/input`

#### WebSocket

- `/ws`：设备列表推送 + 输入控制
- `/ws/stream?serial=xxx`：设备视频流

本地模式下，前端主要靠 `/ws` 和 `/ws/stream` 工作。

### 6.4 视频链路实现

当前视频流由 `H264StreamSession` 提供。

它的核心做法是：

1. 调用 `adb -s <serial> exec-out screenrecord --output-format=h264 ... -`
2. 从 stdout 直接读取 H.264 字节流
3. 将数据块通过 WebSocket 发给浏览器
4. 浏览器用 `JMuxer` 进行解码播放

视频参数受环境变量控制：

- `STREAM_MAX_SIZE`，默认 `720`
- `STREAM_BIT_RATE`，默认 `2000000`

尺寸会按设备分辨率缩放后再取偶数，避免编码尺寸异常。

### 6.5 控制链路实现

控制部分分为两层：

#### 浏览器侧

前端把指针事件映射成设备坐标，再发送以下命令之一：

- `touch`：`down / move / up`
- `tap`
- `swipe`
- `keyevent`：`HOME / BACK / APP_SWITCH`

#### Agent 侧

`InputManager` 会根据命令类型选择不同执行方式：

- `tap` -> 走 ADB `input tap`
- `swipe` -> 走 ADB `input swipe`
- `keyevent` -> 走 ADB `input keyevent`
- `touch` -> 先在内存里拼装为一个完整手势，再在 `up` 时退化为 tap 或 swipe

需要注意：虽然项目里有 `ScrcpyControlManager`，并支持建立 scrcpy control socket、发送 touch 和 keyevent 二进制协议，但当前 `InputManager` 里对 `touch` 的落地依然是“在 Agent 端将手势收敛为 tap/swipe 再调用 ADB”。

换句话说：

- scrcpy 控制通道基础设施已经写了
- 但当前主流程中，`touch move` 还没有真正逐帧走 scrcpy 注入
- 现在更接近“高层手势映射 + ADB 执行”

这一点对于后续优化“跟手感”非常关键。

### 6.6 Relay 中继实现

`relay/src/main.ts` 是当前中继服务核心。

它维护了三类 WebSocket 服务：

- `/ws/agent`：Agent 接入
- `/ws/viewer`：浏览器控制与设备列表
- `/ws/viewer/stream`：浏览器拉视频流

中继层主要做了这些事：

#### Agent 注册

Agent 连接后发送：

```json
{ "type": "register-agent", "agentId": "pc-01" }
```

Relay 记录该 Agent，并广播设备列表。

#### 设备同步

Agent 会发送：

```json
{ "type": "devices", "devices": [...] }
```

Relay 将所有 Agent 的设备合并后，对外暴露为统一设备列表，并在每条设备信息上附加 `agentId`。

#### 控制回传

浏览器通过 `/ws/viewer` 发送：

```json
{
  "type": "input",
  "agentId": "pc-01",
  "serial": "device-serial",
  "command": { ... }
}
```

Relay 按 `agentId` 找到对应 Agent，再把控制消息转发过去。

#### 视频转发

浏览器连接 `/ws/viewer/stream?agentId=...&serial=...` 时：

1. Relay 检查目标 Agent 是否在线
2. 第一个 viewer 到来时，向 Agent 发送 `start-stream`
3. Agent 开始推送二进制视频流
4. Relay 按 `(agentId, serial)` 维度维护 stream state
5. 当最后一个 viewer 断开时，Relay 向 Agent 发送 `stop-stream`

#### Bootstrap 缓存

Relay 还维护了一个最多 `512 KB` 的视频开头缓存，用于：

- 新 viewer 进入时快速回放前面的关键数据
- 降低 viewer 中途加入时首帧黑屏概率

这部分逻辑体现在 `bootstrapChunks` 和 `readyEvent` 里。

## 7. 前端界面与交互逻辑

前端当前是一个单设备主控台 + 设备卡片墙的布局。

页面主要能力：

- 展示设备总数、在线数、TCP 设备数、视频状态
- 选择当前主控设备
- 播放实时画面
- 用鼠标模拟触控
- 发送系统键
- 展示设备信息和连接状态

### 7.1 前端如何区分本地模式和 Relay 模式

核心开关是环境变量：

- `VITE_RELAY_WS_BASE_URL`

如果这个变量为空：

- 前端走本地 Agent

如果这个变量存在：

- 前端走 Relay

所以前端模式切换是构建时/启动时通过环境变量完成的，而不是页面运行中动态切换。

### 7.2 前端如何把鼠标坐标映射到手机坐标

前端会先读取设备真实分辨率，再根据视频容器和设备长宽比，计算：

- 视频实际渲染宽高
- 左右/上下留白偏移
- 用户点击点在真实设备分辨率中的坐标

这部分逻辑在 `mapClientPointToDevice()` 里，保证点击和滑动落点不会直接按 DOM 像素硬套。

## 8. 通信协议概览

### 8.1 Agent 与 Relay

文本消息类型：

- `register-agent`
- `devices`
- `start-stream`
- `stop-stream`
- `input`
- `input-error`
- `stream-ready`
- `stream-log`
- `stream-error`

二进制流格式：

```text
2 字节 serial 长度（UInt16BE）
+ serial utf8 字节
+ H.264 chunk
```

Relay 通过前两个字节和 serial，把视频流路由到正确设备。

### 8.2 Web 与 Agent / Relay

浏览器控制消息统一是：

```json
{
  "type": "input",
  "serial": "...",
  "command": { ... }
}
```

在 Relay 模式下，会额外带：

```json
"agentId": "..."
```

设备列表消息格式统一是：

```json
{
  "type": "devices",
  "devices": [...],
  "updatedAt": "ISO 时间"
}
```

## 9. 环境变量与运行约定

### 9.1 Agent 相关

- `ADB_PATH`
- `SCRCPY_PATH`
- `SCRCPY_SERVER_PATH`
- `DEVICE_POLL_INTERVAL_MS`
- `AGENT_HOST`
- `AGENT_PORT`
- `STREAM_MAX_SIZE`
- `STREAM_BIT_RATE`
- `RELAY_SERVER_WS_URL`
- `AGENT_ID`

默认端口：

- Agent: `5071`
- Relay: `5081`

### 9.2 Web 相关

- `VITE_RELAY_WS_BASE_URL`

### 9.3 运行脚本

项目根目录脚本：

- `npm run agent:devices`
- `npm run agent:server`
- `npm run web:dev`
- `npm run relay:dev`
- `npm run relay:start`

## 10. 部署方式理解

推荐部署思路是：

### 开发环境

- Windows 机器运行 Agent
- 本机启动 Web
- 本机或服务器启动 Relay

### 生产/公网环境

- Windows 机器运行 Agent，主动连接公网 Relay
- Linux 服务器运行 Relay
- Nginx 托管 Web 静态资源，并反代 Relay WebSocket

已知部署约定：

- Relay 健康检查应该访问 `/health`，不要访问根路径 `/`
- 如果 Nginx 显示 `Welcome to nginx`，通常说明静态站点根目录还没正确指到 `web/dist`
- Nginx 反代 WebSocket 时必须带 `Upgrade` 和 `Connection` 头

## 11. 当前能力边界与已知限制

这一节是给 DeepSeek 最重要的“现状边界”。

### 11.1 已经具备的能力

- 多设备发现
- 本地模式可直接查看和控制设备
- Relay 模式已经打通 Agent -> Server -> Browser 主链路
- 浏览器可以接收 H.264 视频并显示
- 可以发送点击、滑动、系统键
- 支持按需开关视频流，而不是所有设备一直推流

### 11.2 当前还不够完善的地方

- 视频仍基于 `adb exec-out screenrecord`，时延和稳定性还有提升空间
- scrcpy control 协议基础设施已经写了，但“实时 move 注入”没有完整融入主输入链路
- 前端目前更偏单主设备控制台，距离真正的群控还有很大空间
- Relay 目前是内存态，不带鉴权、持久化、权限隔离
- 没有完善的错误恢复、监控、告警和日志聚合
- 没有正式的任务队列、批处理编排、设备分组等群控能力
- 没有音频链路
- 没有 WebRTC，当前浏览器播放依赖 WebSocket + JMuxer

### 11.3 设计上的关键现实

项目作者非常关心“实时性”和“无感控制”，也就是操作要尽量跟手。

但当前实现里：

- 视频来自 `screenrecord`
- 控制大量依赖 ADB 的 tap/swipe

这意味着现状更偏“能用”，而不是“极致低延迟”。后续如果要优化体验，重点方向通常会是：

- 视频改为更贴近 scrcpy 原生链路
- 控制 move 走 scrcpy 触控注入
- 进一步减少编码、转发和播放器侧缓冲

## 12. 这个项目现在最适合让 DeepSeek 帮什么

如果把这个项目交给 DeepSeek，比较适合的协作方向包括：

### 12.1 架构设计类

- 评估视频链路是否应从 `screenrecord` 迁移到 scrcpy 视频 socket
- 评估控制链路如何真正接入 scrcpy touch move
- 设计更低延迟的传输方案
- 设计群控调度与设备编排模型

### 12.2 工程实现类

- 优化 Relay 的协议和状态管理
- 增强 Agent 的断线重连与流会话管理
- 为前端增加多设备同时预览
- 引入权限控制、鉴权和租户隔离
- 增加日志、观测性和部署脚本

### 12.3 代码理解类

DeepSeek 在阅读代码时，应优先关注这些入口：

1. `agent/src/main.ts`
2. `agent/src/http/agent-server.ts`
3. `agent/src/relay/relay-client.ts`
4. `agent/src/stream/h264-stream-session.ts`
5. `agent/src/input/input-manager.ts`
6. `agent/src/scrcpy/scrcpy-control-manager.ts`
7. `relay/src/main.ts`
8. `web/src/App.tsx`

## 13. 给 DeepSeek 的一句话总结

这是一个“Android 远程控制系统”的早中期工程版本：本地 Agent 负责设备发现、视频采集和控制执行，Relay 负责公网中继，Web 负责画面展示和交互。当前已经跑通本地与中继两种模式，能做设备列表、H.264 视频查看和基础远程控制，但若目标是更低时延、更强跟手感和真正群控，后续仍需要围绕 scrcpy 原生协议、流媒体链路和调度能力继续深化。

## 14. 建议 DeepSeek 接手时先回答的几个问题

如果要让 DeepSeek 快速给出高价值建议，可以直接让它围绕下面问题展开：

1. 当前基于 `adb screenrecord + JMuxer` 的视频方案，在时延、画质和稳定性上有哪些硬伤？
2. 项目里已经实现了 `ScrcpyControlManager`，应该怎样把它真正融入当前输入主链路，让触控 move 变成“实时注入”？
3. Relay 当前的 stream state 和 bootstrap 缓存设计是否合理？是否需要更清晰的会话生命周期管理？
4. 如果后续要支持多设备同时预览、单设备精细控制、批量群控，这三个需求在架构上应如何拆层？
5. 如果要把这个项目做成公网可用产品，鉴权、权限、资源隔离、日志与监控该如何补齐？
