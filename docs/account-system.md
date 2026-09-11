# 账号系统与管理后台

> Phase A 交付。范围：数据库、用户与设备归属、认证会话、管理 API、初始管理员引导。
> **不含** WebSocket 通道的隔离校验（那是 Phase B）。

---

## 1. 目标

把 remote-phone-control 从「自用工具」改造成「可对外提供服务的多租户系统」：

- 客户通过浏览器**自助注册**
- 管理员在后台**分配手机**、**开关权限**、**设置配额**
- 客户只能看到和操作分配给他的手机

权限模型的一个关键决定：**权限挂在使用者账号上，不引入租户表**。
因为实际业务是「一个客户用一个账号，用完两周就走」，
多一层租户只会增加复杂度而没有收益。

---

## 2. 交付内容

| 文件 | 说明 |
|---|---|
| `relay/src/db/schema.ts` | 表结构（DDL） |
| `relay/src/db/database.ts` | 打开数据库、迁移、类型转换辅助 |
| `relay/src/auth/capabilities.ts` | 6 个权限开关的**唯一定义源** |
| `relay/src/auth/password.ts` | scrypt 哈希与校验、随机密码生成 |
| `relay/src/auth/sessions.ts` | 会话签发 / 校验 / 吊销 |
| `relay/src/auth/users.ts` | 用户 CRUD、能力与配额、认证 |
| `relay/src/auth/bootstrap.ts` | 初始管理员引导 |
| `relay/src/devices/store.ts` | 设备归属与**配额执行** |
| `relay/src/api/http.ts` | 认证与管理 HTTP API |
| `relay/src/main.ts` | 接入：数据库、API 路由、设备同步 |
| `relay/dev/ts-resolve.mjs` | 开发辅助：让 Node 原生 TS 能解析 `.js` → `.ts` |
| `relay/dev/register.mjs` | 同上 |

---

## 3. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 数据库 | **`node:sqlite`（Node 24 内置）** | 零原生依赖，不用编译、不用预编译包，Linux 服务器开箱即用 |
| 密码哈希 | **`node:crypto` 的 scrypt** | 内置 KDF，无需引入 bcrypt/argon2 依赖 |
| 会话 | 随机令牌，**哈希后入库** | 可吊销、可过期，且库被读走也无法直接冒用 |
| 令牌传输 | HTTP `Authorization: Bearer` | 不放 URL——URL 会进日志与浏览器历史 |

> ⚠️ **`node:sqlite` 目前仍标记为 experimental。** 换取的是零原生依赖。
> 所有数据库调用都收敛在 `db/` 与 `auth/` 目录内，
> 若将来要换回 `better-sqlite3`，改动范围有限。

**另一个约束**：`node:sqlite` 只接受 `number / string / bigint / null / Uint8Array`，
**不支持布尔值**。因此所有开关一律存 `0 / 1` 整数，由 `toBool` / `fromBool` 转换。

---

## 4. 数据模型

```sql
users (
  id, username UNIQUE COLLATE NOCASE, password_hash, role, status,
  created_at, updated_at,
  can_view_devices, can_view_stream, can_control_input,
  can_run_dayil, can_send_video, can_upload_video,
  max_devices, max_concurrent_tasks, max_storage_bytes
)

devices (
  serial PRIMARY KEY, agent_id,
  assigned_user_id REFERENCES users(id) ON DELETE SET NULL,
  assigned_at, last_seen_at
)

sessions (token_hash PRIMARY KEY, user_id, created_at, expires_at, last_seen_at)

audit_log (id, actor_user_id, action, target, detail, created_at)
```

设计要点：

- `username` 用 `COLLATE NOCASE`，避免出现仅大小写不同的两个账号
- 删除用户时设备归属自动置 NULL（`ON DELETE SET NULL`），不留悬空引用
- `devices` 里同时存 `agent_id`，为将来多主机预留
- **设备上报只更新 `agent_id` 与 `last_seen_at`，绝不触碰 `assigned_user_id`** ——
  归属是管理员手工决定的，不能被设备上报覆盖

---

## 5. 权限模型

6 个能力开关（定义在 `auth/capabilities.ts`）：

| 键 | 管理页面显示 |
|---|---|
| `can_view_devices` | 查看设备列表 ← **基础能力，关掉则其余失效** |
| `can_view_stream` | 查看实时画面 |
| `can_control_input` | 手动操控（点击 / 滑动 / 按键） |
| `can_run_dayil` | 下发养号任务 |
| `can_send_video` | 下发发视频任务 |
| `can_upload_video` | 上传视频素材 |

配额（数值，与开关分开）：

| 键 | 默认 | 执行点 |
|---|---|---|
| `max_devices` | 0 | **分配设备时**校验（`devices/store.ts`） |
| `max_concurrent_tasks` | 1 | 任务下发时（Phase D） |
| `max_storage_bytes` | 0 | 视频上传时（Phase D） |

**管理员恒为放行**，且不看数据库里的列——即使有人误改了 admin 行的开关，
也不会把管理后台锁死。

---

## 6. 关键流程

### 6.1 自助注册

新账号一律：

```
role = customer
6 个能力开关 = 全 0
max_devices = 0
```

所以注册完能登录，但**什么都看不到、什么都做不了**，直到管理员分配。
前端据 `permissionDenied` 显示「等待管理员分配设备」——
比直接拒绝登录更友好，也少一堆「为什么登不上」的询问。

### 6.2 初始管理员

首次启动时若库里没有任何 admin：

```
用户名 ← ADMIN_USERNAME（默认 admin）
密码   ← ADMIN_PASSWORD 环境变量
         若未设置则随机生成（24 位，排除易混字符），控制台打印一次后只存哈希
```

**刻意不提供硬编码默认密码**——那会进 git，并变成全网皆知的默认口令。

启动横幅示例：

```
================================================================
  已创建初始管理员账号
  用户名: admin
  密码:   xxxxxxxx
  ⚠️  此密码只显示这一次，请立即保存并登录后修改
================================================================
```

---

## 7. API 清单

### 公开

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 自助注册（限流：每 IP 每小时 10 次） |
| POST | `/api/auth/login` | 登录，返回 token（限流：用户名与 IP 双维度） |

### 需登录

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/me` | 当前用户与能力 |
| POST | `/api/auth/logout` | 登出（吊销当前会话） |
| POST | `/api/auth/password` | 改密（吊销全部会话并补发当前设备） |
| GET | `/api/my/devices` | **只返回分配给我的设备** |

### 管理端（仅 admin）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/meta` | 能力定义，供前端渲染勾选框 |
| GET | `/api/admin/users` | 用户列表（含各自设备数） |
| POST | `/api/admin/users` | 直接创建客户账号 |
| PATCH | `/api/admin/users/:id` | 改能力 / 配额 / 状态 |
| POST | `/api/admin/users/:id/password` | 重置密码 |
| DELETE | `/api/admin/users/:id` | 删除账号（自动收回其设备） |
| GET | `/api/admin/devices` | 全部设备 + 归属 + 在线状态 |
| POST | `/api/admin/devices/:serial/assign` | 分配设备（`userId: null` 表示收回） |
| GET | `/api/admin/audit` | 审计日志 |

> **行为变更**：relay 原有的 `GET /api/devices`（返回全部设备）
> 现在**需要管理员权限**。它原本无鉴权，会把全部设备暴露给任何能连上服务器的人。
> 客户要看自己的设备请用 `/api/my/devices`。

---

## 8. 安全设计要点

| # | 措施 | 防的是什么 |
|---|---|---|
| 1 | scrypt + 随机盐，参数随哈希存储 | 库泄露后无法直接还原密码；将来调强度不影响旧哈希 |
| 2 | 会话令牌只存 sha256 | 库被读走也无法直接冒用会话 |
| 3 | 用户名不存在时**也走一次哈希校验**（等时） | 靠响应时间枚举用户名是否存在 |
| 4 | 登录限流按 **用户名 + IP** 双维度 | 只按 IP 会被分布式绕过；只按用户名会被人拿来锁定他人账号 |
| 5 | **禁用账号即刻吊销全部会话** | 否则已登录的连接能一直用到会话过期，权限收紧形同虚设 |
| 6 | 改密吊销全部会话并补发当前设备 | 密码泄露后旧会话立即失效，且不把自己踢下线 |
| 7 | **最后一个管理员不可禁用 / 删除** | 防止把管理后台彻底锁死 |
| 8 | 管理员能力判定不看数据库列 | 同上，双保险 |
| 9 | 请求体上限 64 KB | 内存滥用 |
| 10 | 管理动作全部写审计日志 | 纠纷与滥用回溯 |

会话有效期：滑动 7 天，绝对上限 30 天。`last_seen_at` 写回节流到 1 小时一次。

---

## 9. 测试结果

### 静态检查

`tsc --noEmit` 通过（exit 0）。

### 端到端（真实 HTTP，独立测试库与端口）

**34 条断言全部通过**。覆盖：

```
--- 注册 ---
PASS  注册 cust1 / 注册 cust2 / 重复用户名 409 / 弱密码 400 / 非法用户名 400
--- 登录 ---
PASS  管理员登录 / 错误密码 401 / 未见过的用户名 401
--- 未认证访问 ---
PASS  无 token 访问管理端 401 / 伪造 token 401
--- 管理端 ---
PASS  用户数 / cust1 初始设备数 0 / cust1 初始能力全关 / 设备数 4 / 首台未分配
--- 配额与权限 ---
PASS  设置配额与权限 / 分配 41 / 分配 42 / 分配第 3 台超出配额 400 / 抢占他人设备 400
--- 客户视角（核心隔离）---
PASS  cust1 只看到自己的 2 台
PASS  cust1 看到的首台正确
PASS  cust2 看不到任何设备 + permissionDenied
PASS  cust1 访问管理端 403
PASS  cust1 访问全量设备接口 403
PASS  admin 访问全量设备接口 200
--- 禁用即刻生效 ---
PASS  禁用 cust1 / 旧 token 立即失效 401 / 无法再登录 403
--- 审计 ---
PASS  有记录 / 记录分配动作 / 记录越权尝试
```

设备在线状态另测：agent 连接时 `online: true` 且 `assignedUsername` 正确；
agent 断开后记录仍在库中但 `online: false`（这是正确行为——归属持久化，在线状态实时）。

---

## 10. 运维配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `RELAY_DB_FILE` | `data/relay.db` | SQLite 文件路径（相对 relay 工作目录） |
| `ADMIN_USERNAME` | `admin` | 初始管理员用户名，仅首次启动生效 |
| `ADMIN_PASSWORD` | 随机生成 | 初始管理员密码，仅首次启动生效 |

数据库文件已在 `.gitignore` 中排除（`*.db`、`relay/data/`），**切勿提交**。

### 本地不依赖 tsx 运行

`relay/dev/register.mjs` 是一个解析钩子，让 Node 原生 TypeScript 支持能处理
「源码写 `./foo.js` 但实际是 `foo.ts`」的 NodeNext 写法：

```powershell
cd relay
node --import ./dev/register.mjs src/main.ts
```

（正常流程仍用 `npm run relay:dev`。）

---

## 11. Phase B：WebSocket 通道的隔离（已实现）

Phase A 只做了 HTTP 侧的认证与管理。真正决定「能不能看画面、能不能操控」的
隔离校验在 WebSocket 通道那一侧，**现已实现并验证完毕**。

改造前后对比：

| 位置 | 改造前 | 现在 |
|---|---|---|
| `/ws/viewer` 连接 | 直接下发**全部设备** | 必须先发 `auth` 消息，否则收不到任何数据 |
| `broadcastDevices()` | 序列化一份广播给所有人 | **每个连接各构造一份** |
| 输入下发 | 只校验 agent 存在 | 校验归属 + `can_control_input`，agentId 由服务端反查 |
| `/ws/viewer/stream` | 只校验 agent 在线 | 校验归属 + `can_view_stream` |
| Agent 回报的 `input-error` | 广播给所有 viewer | **只发给拥有该设备的人** |

关键机制：**访问权限的「纪元」计数**。管理员一改归属或权限，纪元 +1，
所有连接上的权限缓存立刻失效，下一条消息重新查库——
既满足「变更即刻生效」，又不必为每条输入消息查库（拖动时可达每秒数十条）。

完整设计与验证结果见 **`docs/relay-isolation.md`**。

> **前端进度**：登录/注册页、令牌存储、WebSocket 首条鉴权消息**已完成**；
> 管理页面（客户列表、设备分配、权限勾选框、审计）**尚未开始**。
> 因此 relay 模式现在可以在浏览器里正常登录并使用，
> 但分配设备与开关权限暂时仍需通过 API 操作。
> 详见 **`docs/web-console.md`**。
