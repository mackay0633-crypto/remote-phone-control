# ADB over TCP 设备保活

## 1. 要解决的问题

设备以 **ADB over TCP** 方式接入（本环境为 `192.168.9.41-60:65535`，共 20 台）。

这类连接**只存在于 adb server 进程的内存中**。一旦 adb server 重启——重启主机、执行 `adb kill-server`、或进程崩溃——**全部设备会立刻消失**。

而改造前的 remote-phone-control 没有能力找回它们：

- `AdbClient` 只实现 `listDevices` / `getDeviceMeta` / `tap` / `swipe` / `keyevent` / `runShell`
- **没有 `adb connect`**

结果就是：总机一旦重启，agent 会看到 0 台设备，并且**永远不会自愈**。

详见 `docs/adb-device-verification.md` 第 6.1 节。

## 2. 方案

新增 `DeviceKeepalive` 模块：

1. **启动时**按配置的地址段逐个 `adb connect`，保证首个设备列表就是完整的
2. **运行中**周期性比对目标地址与当前设备列表
3. 对缺失的目标重新 `connect`
4. 对状态为 `offline` / `unauthorized` 的残留记录，先 `disconnect` 再 `connect`
5. 恢复成功后立即触发一次设备列表刷新，不必等下一个轮询周期

## 3. 新增与改动的文件

| 文件 | 说明 |
|---|---|
| `agent/src/device/device-targets.ts` | **新增**。地址段解析（纯函数，无副作用） |
| `agent/src/device/device-keepalive.ts` | **新增**。保活主逻辑 |
| `agent/src/adb/adb-client.ts` | 新增 `connect()` / `disconnect()` |
| `agent/src/device/device-tracker.ts` | 新增 `refreshNow()`，供保活恢复后立即刷新 |
| `agent/src/config/env.ts` | 新增 4 个保活配置项 |
| `agent/src/main.ts` | 启动时接入保活（`--serve` 与单次模式都生效） |
| `agent/src/http/agent-server.ts` | 新增 `GET /api/devices/keepalive` 状态查询 |

## 4. 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DEVICE_TCP_RANGE` | 空 → **保活关闭** | 设备地址段，逗号分隔多条 |
| `DEVICE_TCP_PORT` | `5555` | 条目未显式带端口时的默认端口 |
| `DEVICE_KEEPALIVE_INTERVAL_MS` | `60000` | 检查间隔，最小值 5000 |
| `DEVICE_KEEPALIVE_CONCURRENCY` | `4` | 并发 `connect` 数，上限 16 |

**默认关闭**，不配置 `DEVICE_TCP_RANGE` 时行为与改造前完全一致。

### 地址段语法

| 写法 | 含义 |
|---|---|
| `192.168.9.41-60` | 末段范围 |
| `192.168.9.41-192.168.9.60` | 完整 IP 范围 |
| `192.168.9.41` | 单个地址 |
| `192.168.9.41:65535` | 带端口 |
| `192.168.9.41-60:65535` | 范围 + 端口 |
| `192.168.9.41-60:65535,10.0.0.5` | 逗号分隔混合 |

非法输入（端口越界、反向范围、格式错误）会被跳过并打印 `[agent] ignore ...` 警告，不会中断启动。
展开上限 1024 个目标。

### 已实测的解析结果

| 输入 | 输出 |
|---|---|
| `192.168.9.41-60:65535` | 20 个，`41:65535` .. `60:65535` |
| `192.168.9.41-192.168.9.60`（默认端口 65535） | 20 个 |
| `10.0.0.1,10.0.0.3:5555` | 2 个 |
| `192.168.9.41` | 1 个 |
| `192.168.9.41-60:65535,10.0.0.5` | 21 个 |
| `bad-input` | 0 个 + 警告 |
| `192.168.9.41:99999` | 0 个 + 警告 |
| `192.168.9.60-41` | 0 个 + 警告 |

## 5. 本环境推荐用法

```powershell
$env:DEVICE_TCP_RANGE = "192.168.9.41-60:65535"
npm run agent:server
```

启动日志会打印展开结果，可直接确认解析是否正确：

```text
[agent] keepalive: enabled, 60000ms interval -> 192.168.9.41:65535, 192.168.9.42:65535, ... (20 total)
[agent] keepalive initial pass
[agent] keepalive: 20/20 target(s) not ready, reconnecting
[agent] keepalive: restored 20/20, now 20/20 online
```

也可以用单次模式验证（会先补齐设备再输出列表）：

```powershell
$env:DEVICE_TCP_RANGE = "192.168.9.41-60:65535"
npm run agent:devices
```

## 6. 状态查询

```http
GET /api/devices/keepalive
```

```json
{
  "enabled": true,
  "targetCount": 20,
  "onlineCount": 20,
  "missing": [],
  "lastRunAt": "2026-09-10T10:12:33.480Z",
  "lastAttempted": 0,
  "lastRestored": 0,
  "lastFailures": []
}
```

未启用保活时返回 `enabled: false`。

## 7. 故障排查

| 现象 | 排查方向 |
|---|---|
| 日志 `keepalive: disabled` | `DEVICE_TCP_RANGE` 为空或全部条目被判定非法（看 `ignore ...` 警告） |
| `restored 0/N` 且 `lastFailures` 有内容 | 设备 IP 不可达、端口不对，或设备侧 adbd 未监听该端口 |
| 设备反复掉线 | 检查是否另有程序在 `disconnect` 同一批设备；确认网线/交换机稳定 |
| 目标数不对 | 用启动日志的展开预览核对地址段写法 |

### 设计上的注意点

- **以重新枚举结果为准**：恢复计数不是仅凭 `adb connect` 的输出，而是在 connect 之后重新 `adb devices` 复核，避免"命令成功但设备仍不可用"的假象。
- **并发受限**：默认 4 路并发，避免一次性对 20~40 台设备发起连接冲击。
- **不干扰 `input` 链路**：保活只调用 `connect` / `disconnect` / `listDevices`，不触碰 scrcpy 与输入注入。

## 8. 仍未解决的问题

以下问题已在 `docs/adb-device-verification.md` 记录，**本模块未涉及**：

1. **设备轮询开销**：`DeviceManager.listDevices()` 对每台设备执行 3 次 shell，20 台为每轮 60 次 adb 调用（默认 5 秒一轮）。40 台时翻倍。
2. **视频链路带宽**：20 台 × 2Mbps = 40Mbps，40 台为 80Mbps，全部走同一条网线。
