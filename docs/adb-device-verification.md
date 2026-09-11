# ADB 与设备环境验证报告

验证日期：2026-09（本轮会话）
验证主机：`DESKTOP-F57TPQS` / `192.168.9.10`
验证目标：确认 remote-phone-control 所处环境的 ADB 与设备连接事实，为集成 autojs-controller 做准备。

---

## 1. 结论摘要

| 议题 | 结论 |
|---|---|
| 多版本 adb 是否互相冲突 | **不冲突**。四个 adb 副本协议版本一致，可共用同一个 adb server |
| 是否需要统一 adb / 替换文件 | **不需要**。原方案全部作废 |
| 设备连接方式 | **ADB over TCP**，`192.168.9.41-60:65535`，共 20 台 |
| 设备是否依赖微蓝云 | **不依赖**。设备归属 adb server 进程，微蓝云关闭后全部照常可用 |
| 设备可否重连 | **可以**，`adb connect <ip>:65535` 一条命令即可恢复 |
| remote agent 能否自愈 | **不能**。`AdbClient` 没有 `connect` 能力（见第 6 节） |

**最重要的两个发现：**

1. adb 版本冲突问题**不存在**，之前基于“文件哈希不同”推出的“必然冲突”结论是错的。
2. 真正的风险不是 adb 冲突，而是**设备连接只存在于 adb server 内存中，且 remote 没有重连能力**。

---

## 2. 环境事实

### 2.1 主机与网络

| 项 | 值 |
|---|---|
| 主机名 | `DESKTOP-F57TPQS` |
| 本机 IPv4 | `192.168.9.10` |
| 网卡 | 以太网（有线） |
| 网关 | `192.168.9.1` |

### 2.2 设备

| 项 | 值 |
|---|---|
| IP 范围 | `192.168.9.41` – `192.168.9.60` |
| 设备数量 | **20 台** |
| adb 端口 | **`65535`**（非默认 5555） |
| serial 格式 | `192.168.9.41:65535` |
| 机型 | `SM-N950U`（Samsung Galaxy Note 8） |
| Android 版本 | 9 |
| `wm size` | Physical `1080x1920` / Override `1080x2220` |
| MAC 前缀 | 全部为 `dc-04-5a`（同一批设备） |
| 可达性 | 全部 ping 通，TTL=64，<1ms |

> **注意**：`service.adb.tcp.port` 在设备侧为 `65535`，因此不是默认的 5555 端口。
> 最初尝试 `adb connect <ip>:5555` 会返回 `connection refused (10061)`，这是预期行为，不是故障。

### 2.3 adb 二进制副本

机器上共发现 4 个 adb 副本，分属 3 个不同构建：

| 位置 | 大小 | SHA256（前16位） | 客户端版本 | 归属 |
|---|---|---|---|---|
| `D:\weilanyun\tools\adb.exe` | 6,021,632 | `126562AC7F8BCA87` | 34.0.1-9680074 | 微蓝云 |
| `C:\Program Files\Laixi\tools\platform-tools\adb.exe` | 6,641,760 | `1E1C2280B90B3F01` | 36.0.0-13206524 | 来喜（**remote agent 默认使用**） |
| `C:\Users\admin\Desktop\scrcpy-win64-v3.3.4\adb.exe` | 6,641,760 | `1E1C2280B90B3F01` | 36.0.0-13206524 | 与来喜同一副本 |
| `D:\projects\autojs-controller\adb\adb.exe` | 5,916,440 | `705DDC21F33AC521` | 34.0.4-10411341 | autojs-controller 自带 |

配套 DLL（版本与 exe 绑定，必须成套）：

| 位置 | AdbWinApi.dll | AdbWinUsbApi.dll |
|---|---|---|
| 微蓝云 | 97,792 | 62,976 |
| 来喜 / scrcpy | 108,128 | 73,312 |
| autojs | 108,312 | 73,496 |

---

## 3. adb 版本冲突验证

### 3.1 冲突的触发条件

adb 只在 **`ADB_SERVER_VERSION`（协议版本常量）**不一致时才会杀掉已有 server，而不是二进制文件不同就杀。

当版本一致时，后启动的 client 会直接复用已有 server，**不会发生任何重启**。

> 这一点是本轮最重要的认知修正：
> **文件哈希/大小不同 ≠ 协议版本不同。**
> 早期仅凭 4 个副本哈希不同就推断“必然冲突”，该结论已证伪。

### 3.2 实测结果

三个版本全部报告 `Android Debug Bridge version 1.0.41`，协议版本一致。

测试方法：记录 5037 端口 server 的 PID，用另一个版本的 adb 执行 `devices`，再检查 PID 是否变化。

| 被测 adb | 客户端版本 | 测试前 PID | 测试后 PID | 是否 killing |
|---|---|---|---|---|
| 来喜 | 36.0.0-13206524 | 29816 | 29816 | 否 |
| autojs | 34.0.4-10411341 | 29816 | 29816 | 否 |

两个客户端都成功复用了微蓝云启动的 server，全程无 `adb server version ... doesn't match ...; killing` 消息，PID 未变。

### 3.3 结论

- **平台工具 34.x 与 36.x 共用同一协议版本**，可安全共存
- 无需统一 adb、无需替换任何文件、无需设置 `ADB_PATH`
- 也解释了为何这台机器长期并存 4 个 adb 副本却相安无事

### 3.4 复现命令

```powershell
# 取 5037 上 server 的 PID
((netstat -ano | Select-String ':5037\b' | Select-String 'LISTENING' | Select-Object -First 1).ToString() `
  -replace '\s+',' ').Trim().Split(' ')[-1]

# 用另一个版本调用，再取一次 PID 比对
& "C:\Program Files\Laixi\tools\platform-tools\adb.exe" devices

# 查看版本
& "C:\Program Files\Laixi\tools\platform-tools\adb.exe" version
```

---

## 4. 设备连接机制

### 4.1 设备由 adb server 持有，而非群控软件

验证过程：

1. 微蓝云主程序关闭后，仅剩 `D:\weilanyun\tools\adb.exe`（PID 29816）在 5037 上监听
2. 用**来喜的 adb** 查询，20 台设备全部为 `device` 状态
3. 逐台执行 `shell getprop ro.product.model`，**20/20 响应正常**，无僵尸记录

**结论**：adb server 是独立后台进程，父程序退出它不退出；设备连接归 server 所有。
remote-phone-control 可以完全独立于微蓝云使用这批设备。

### 4.2 连接来源不是 mDNS

```powershell
adb mdns services
# 输出为空
```

因此这 20 台**不是自动发现**的，而是由某个程序显式执行 `adb connect <ip>:65535` 建立的。

### 4.3 断线重连验证

```powershell
$adb = "C:\Program Files\Laixi\tools\platform-tools\adb.exe"
& $adb disconnect 192.168.9.60:65535   # disconnected
& $adb devices                          # 剩余 19 台
& $adb connect 192.168.9.60:65535       # connected to 192.168.9.60:65535
& $adb devices                          # 恢复 20 台，shell 可用
```

**结论**：重连可用，一条命令即可恢复单台设备。

---

## 5. 已验证 / 未验证边界

### 已实测确认

- adb 多版本共存无冲突
- 20 台设备在线且 shell 可用
- 微蓝云关闭不影响设备可用性
- `adb disconnect` / `adb connect` 可正常断开与恢复
- `wm size` 的 Override 字段存在（`1080x2220`）

### 尚未验证（受环境限制）

| 项 | 原因 |
|---|---|
| remote agent 实际启动 | 验证沙箱禁止 Node 子进程使用管道 stdio，报 `spawn EPERM`；**非 remote 代码问题，需在正常环境复跑** |
| `screenrecord` 视频推流 | 依赖 agent 启动与浏览器端 |
| 多设备并发推流带宽表现 | 需实测 |
| WMI/PnP 设备枚举 | 沙箱屏蔽，`Get-CimInstance` / `Get-PnpDevice` 全部返回 0，不作为证据 |

### 未解的疑点

首次连续两次 `adb devices` 均为 **0 台**，数分钟后变为 **20 台**，期间未主动改变设备状态。

推测：微蓝云在该时间段内执行了 `adb connect`。**该现象尚未定论**，若设备会周期性消失，其影响将大于本报告讨论的 adb 版本问题，建议后续观察。

---

## 6. 发现的风险与待办

### 6.1 【高】设备连接无法自愈

**风险**：20 个 TCP 连接仅存在于 adb server 的**内存**中。一旦 server 重启（重启主机、`adb kill-server`、进程崩溃），20 台将全部消失。

**现状缺口**：`agent/src/adb/adb-client.ts` 仅实现
`listDevices` / `getDeviceMeta` / `tap` / `swipe` / `keyevent` / `runShell`，
**没有 `adb connect`**。即：总机一旦重启，remote 会看到 0 台设备，且自身无法恢复。
微蓝云关闭后，也没有其它程序会自动重连。

**建议**：为 agent 增加设备保活模块

```
配置（env）：设备 IP 段（192.168.9.41-60）+ 端口（65535）
启动时     ：逐个 adb connect
运行中     ：周期性检查，发现掉线自动重连
```

该模块可同时解决 4.x 的“设备时有时无”隐患，建议优先级高于 autojs API 集成。

### 6.2 【中】设备轮询开销

`DeviceManager.listDevices()` 对**每台**上线设备执行 3 次 shell（`getprop model`、`getprop release`、`wm size`）。

- 20 台 = **每轮 60 次 adb 调用**
- 40 台 = **每轮 120 次 adb 调用**
- 默认轮询间隔 `DEVICE_POLL_INTERVAL_MS` = 5000ms

`DeviceTracker` 有 `refreshing` 防重入，不会堆积，但在 Windows 上大量 `adb.exe` 进程启动开销显著，可能退化为“持续轮询”。

**建议**：实测单轮耗时；必要时降低轮询频率、批量查询或缓存机型信息。

### 6.3 【中】视频链路带宽需重算

设备为**有线 TCP 连接**，与最初基于 USB/OTG 的假设不同。

- 20 台 × 2Mbps = 40Mbps
- 40 台 × 2Mbps = 80Mbps

同一条网线承载全部推流，需在架构层面评估（缩略图模式 / 按需推流已由 relay 的 start/stop-stream 机制部分缓解）。

---

## 7. 对 autojs-controller 集成的影响

1. **`device_id` 格式为 `192.168.9.41:65535`**
   autojs 的 `device_ids` 必须传这种 `IP:端口` 完整格式，不能只传 IP。

2. **`detectTransport()` 判定正确**
   `agent/src/device/device-manager.ts` 依据 “serial 是否含冒号” 判定，TCP 设备会被正确识别为 `tcp`。

3. **`wm size` 解析逻辑正确**
   `agent/src/adb/adb-client.ts` 优先匹配 `Override size`，符合实际（Override `1080x2220` 才是真实显示分辨率），有利于坐标映射。

4. **autojs API 可直连**
   autojs 与 agent 同机（用户已确认），其服务端口 5000 通过 `app.listen(PORT)` 绑定全部网卡。
   注意：`/api/automation/*` 位于激活中间件之后，未激活返回 `403`。

---

## 8. 复现清单

```powershell
# 1) 设备总机
netstat -ano | Select-String ':5037\b'

# 2) 设备列表
& "C:\Program Files\Laixi\tools\platform-tools\adb.exe" devices

# 3) 单台功能验证
& "C:\Program Files\Laixi\tools\platform-tools\adb.exe" -s 192.168.9.41:65535 shell getprop ro.product.model

# 4) 网络可达性
ping -n 2 192.168.9.41

# 5) 版本
& "D:\weilanyun\tools\adb.exe" version
& "C:\Program Files\Laixi\tools\platform-tools\adb.exe" version
& "D:\projects\autojs-controller\adb\adb.exe" version

# 6) 全量保活（示例）
41..60 | ForEach-Object {
  & "C:\Program Files\Laixi\tools\platform-tools\adb.exe" connect "192.168.9.$($_):65535"
}
```
