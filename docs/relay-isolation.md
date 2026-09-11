# relay WebSocket 隔离（Phase B）

> 目标：让「客户只能看到、并且只能操作分配给他的手机」这条约束
> **真正在服务端强制执行**，而不只是 UI 上的隐藏。
> 状态：**已实现并通过 28 条端到端断言验证**。

---

## 1. 改造前的状况

Phase A 完成时，HTTP 侧已有完整的认证与权限，但 WebSocket 通道
（浏览器实际用来画面和控制的那条路）**零校验**：

| 位置 | 改造前 |
|---|---|
| `/ws/viewer` 连接 | 连上就下发**全部 20 台设备** |
| `broadcastDevices()` | 序列化**一份** payload，广播给**所有** viewer |
| 输入下发 | 只检查 agentId 是否存在，**不检查 serial 归属** |
| `/ws/viewer/stream` | 只检查 agent 在线，**不检查 serial 归属** |
| Agent 回报的 `input-error` | `broadcastViewerMessage()` 广播给所有人 |

后果：任何能连上 relay 的人，都能看和操控你的全部手机。
更细一点——`input-error` 的广播会把**别人的设备号**写进你的页面。

---

## 2. 设计

### 2.1 鉴权：首条消息携带令牌，不放 URL

```
客户端 → { "type": "auth", "token": "<会话令牌>" }
服务端 → { "type": "auth-ok", user: {...} }  然后才推设备列表
```

- **不放查询串**：URL 会进服务器日志、反向代理日志和浏览器历史
- **超时 5 秒**未鉴权即断开
- 鉴权前**不发送任何字节**，连设备列表都不给

### 2.2 授权：归属 + 能力，双重校验

| 检查 | 依据 |
|---|---|
| 设备归属 | `serial ∈ 该账号被分配的 serial 集合` |
| 能力 | `can_view_stream` / `can_control_input` |

**agentId 不再由客户端提供**，而是服务端按 serial 从在线设备表反查——
客户端无法伪造。

### 2.3 权限变更即刻生效：访问纪元

难点：管理员在后台关掉某人的操控权限时，那个人**已经连着 WebSocket**。
如果权限在连接建立时快照一次，这次改动就要等到他重连才生效。

但如果每条输入消息都查库——拖动手指时输入可达**每秒数十条**——
就是每秒数百次查询。

解法是「访问纪元」（`relay/src/access/epoch.ts`）：

```
任何影响访问控制的写操作  →  纪元 +1  →  所有连接的权限缓存自动失效
                                      ↓
                              下一条消息重新查库
```

- 管理端的分配设备 / 开关能力 / 禁用账号 / 重置密码 / 删除账号
  都会调用 `notifyAccessChanged()`：纪元 +1，并**主动重校验所有在线连接**
- 每个连接缓存 `{ user, serials, epoch }`；纪元一致就直接用缓存
- 另设 60 秒间隔重校验会话本身是否仍然有效（覆盖会话过期）

于是「即刻生效」和「不为每条输入查库」同时成立。

### 2.4 每条消息独立构造

这是最容易漏的一点：

```ts
// ❌ 改造前：一份 payload 发所有人
const serialized = serializeDevices();
viewerSockets.forEach((viewer) => viewer.send(serialized));

// ✅ 现在：每个连接各构造一份
viewerSessions.forEach((viewer, socket) => {
  const visible = hasCapability(viewer.user, "can_view_devices")
    ? all.filter((device) => viewer.serials.has(device.serial))
    : [];
  socket.send(JSON.stringify({ type: "devices", devices: visible, updatedAt }));
});
```

同理，Agent 回报的 `input-error` 改为 **只发给拥有该 serial 的连接**
（`sendToViewersOwning`），不再广播。

### 2.5 主动推送最新权限

服务端拒绝越权操作只解决了「拦得住」，没解决「UI 撒谎」：
管理员刚关掉操控权，前端按钮仍按登录时的旧权限显示为可用，点了才被拒。

因此 `revalidateViewers()` 在重校验之后，会额外推一条：

```json
{ "type": "permissions", "role": "customer", "capabilities": { ... } }
```

前端收到后更新本地会话（并写回 localStorage），按钮状态随之刷新。

---

## 3. 验证结果

`relay/dev/phase-b-isolation-test.mjs`，**30 条断言全部通过**。

### 1. 未鉴权连接（4 条）

| 断言 | 结果 |
|---|---|
| 未发送 auth 时收不到任何消息 | PASS |
| 首条非 auth 消息被拒 | PASS |
| 被拒后连接关闭 | PASS |
| 伪造令牌被拒 | PASS |

### 2. 设备可见性（3 条）

| 断言 | 结果 |
|---|---|
| cust1 只看到自己的 2 台 | PASS |
| cust2 只看到自己的 1 台 | PASS |
| 管理员看到全部 4 台 | PASS |

### 3. 指令下发隔离（6 条）

| 断言 | 结果 |
|---|---|
| 合法指令到达 Agent | PASS |
| 到达的是自己的设备 | PASS |
| 越权指令被拒（"无权操作该设备"） | PASS |
| **越权指令没有到达 Agent** | PASS |
| 未知设备被拒 | PASS |
| 未知设备指令未到达 Agent | PASS |

> 「没有到达 Agent」是通过假 Agent 记录实际收到的 `input` 消息来验证的——
> 不只是看服务端回了错，而是确认真指令没被转发出去。

### 4. 视频流隔离（6 条）

| 断言 | 结果 |
|---|---|
| 未鉴权订阅收不到任何数据 | PASS |
| 未鉴权订阅被拒（鉴权超时） | PASS |
| 订阅自己的设备成功 | PASS |
| 收到二进制帧 | PASS |
| 订阅他人设备被拒（"无权查看该设备"） | PASS |
| 被拒后连接关闭 | PASS |

### 5. 权限变更即时生效（8 条）

| 断言 | 结果 |
|---|---|
| 收回 `can_control_input` 后旧连接立即失效 | PASS |
| 被收回后指令未到达 Agent | PASS |
| 连接仍然保留（仅失去操控能力） | PASS |
| **推送了最新权限（`can_control_input=false`）** | PASS |
| **推送的权限里 `can_view_devices` 仍为 true** | PASS |
| 收回 `can_view_stream` 后**正在进行的流被断开** | PASS |
| 收回设备归属后设备列表立即刷新 | PASS |
| 禁用账号后连接被断开 | PASS |

### 6. 审计（3 条）

| 断言 | 结果 |
|---|---|
| 记录了越权指令尝试（`viewer.input_denied`） | PASS |
| 记录了越权订阅尝试（`viewer.stream_denied`） | PASS |
| 记录了流被收回（`viewer.stream_revoked`） | PASS |

### 运行方式

```powershell
# 1) 启动 relay（独立端口与数据库）
cd relay
$env:RELAY_PORT='5091'; $env:RELAY_DB_FILE='data-test/relay.db'
$env:ADMIN_PASSWORD='<随便设一个测试密码>'
node --import ./dev/register.mjs src/main.ts

# 2) 另开窗口跑测试（密码要与上面一致）
$env:TEST_ADMIN_PASSWORD='<上面那个测试密码>'
node dev/phase-b-isolation-test.mjs
```

> 测试脚本**不提供默认密码**：源码里不留任何可用凭据。

---

## 4. 涉及的文件

| 文件 | 改动 |
|---|---|
| `relay/src/access/epoch.ts` | **新增**。访问纪元计数 |
| `relay/src/db/audit.ts` | **新增**。审计写入，供 WS 与 API 共用 |
| `relay/src/main.ts` | 两个 WS 处理器重写；新增鉴权、授权、重校验逻辑 |
| `relay/src/api/http.ts` | 新增 `onAccessChanged` 回调；所有写操作触发纪元 +1 |
| `relay/dev/phase-b-isolation-test.mjs` | **新增**。隔离验证脚本 |
| `relay/dev/register.mjs`、`ts-resolve.mjs` | 开发辅助：让 Node 原生 TS 能解析 `.js` → `.ts` |

---

## 5. 遗留

### 5.1 前端尚未跟进（阻塞）

relay 模式的 WebSocket 协议已变，而 `web/src/App.tsx` 还是旧协议：

- `/ws/viewer` 连上后**不发 auth** → 5 秒后被断开
- `/ws/viewer/stream` 同样没有 auth
- 还没有登录界面，令牌无处获得

**因此浏览器端的 relay 模式目前不可用**，需要 Phase C：

1. 登录 / 注册页面
2. 令牌存储（`localStorage`）+ WS 首条 auth 消息
3. 管理页面（客户列表、设备分配、权限开关、审计）
4. 任务下发与视频上传界面

### 5.2 其他

- **令牌存储**：前端用 `localStorage` 简单直接，但需注意 XSS 风险；
  更稳妥的是 httpOnly Cookie + CSRF 防护。当前选择 localStorage 是为了
  不引入跨域 Cookie 的复杂度，**上线前建议重新评估**。
- **限流是内存态**：relay 重启即清空。单实例部署没问题，
  多实例时需要换成共享存储。
