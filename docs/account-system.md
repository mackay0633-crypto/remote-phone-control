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
| 数据库 | **`better-sqlite3`** | 覆盖 Node 18/20/22/24，预编译包覆盖主流平台 |
| 密码哈希 | **`node:crypto` 的 scrypt** | 内置 KDF，无需引入 bcrypt/argon2 依赖 |
| 会话 | 随机令牌，**哈希后入库** | 可吊销、可过期，且库被读走也无法直接冒用 |
| 令牌传输 | HTTP `Authorization: Bearer` | 不放 URL——URL 会进日志与浏览器历史 |

### 一次踩坑记录：为什么不是 `node:sqlite`

最初用的是 Node 内置的 `node:sqlite`，理由是「零原生依赖」。
但那个判断**只验证了开发机（Node 24），没有确认部署服务器的 Node 版本**——
结果生产服务器是 Node 20，启动直接失败：

```
Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
Node.js v20.20.2
```

`node:sqlite` 直到 **Node 22.5 才加入、23.4 才默认可用**，覆盖面太窄。

改用 `better-sqlite3`：覆盖 Node 18/20/22/24，`npm install` 即可。
代价是原生模块，换来「装到哪台机器都能跑」。

两个库的 API 几乎一致（同步、`prepare/get/all/run/exec`），
因此切换只动了 `relay/src/db/database.ts` 一个文件。

**通用教训**：选依赖时要看**部署目标**，不是自己手上那台。
这次是拿部署环境做了本地便利的取舍。

**一个残留约束**：SQLite 没有原生布尔类型，所有开关一律存 `0 / 1` 整数，
由 `toBool` / `fromBool` 转换。

---

## 4. 数据模型

```sql
users (
  id, username UNIQUE COLLATE NOCASE, password_hash, role, status,
  email, email_verified_at,
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

email_verifications (
  id, email COLLATE NOCASE,
  purpose CHECK (purpose IN ('register', 'reset', 'change_email')),
  code_hash, attempts, created_at, expires_at, consumed_at
)

audit_log (id, actor_user_id, action, target, detail, created_at)
```

设计要点：

- `username` 用 `COLLATE NOCASE`，避免出现仅大小写不同的两个账号
- 删除用户时设备归属自动置 NULL（`ON DELETE SET NULL`），不留悬空引用
- `devices` 里同时存 `agent_id`，为将来多主机预留
- **设备上报只更新 `agent_id` 与 `last_seen_at`，绝不触碰 `assigned_user_id`** ——
  归属是管理员手工决定的，不能被设备上报覆盖
- `email` 允许为空但不允许重复：用**部分唯一索引**
  （`WHERE email IS NOT NULL`）+ `COLLATE NOCASE`，`Alice@x.com` 与 `alice@x.com` 算同一个
- **无邮箱的账号按「已验证」对待**（`email === null` 即视为可信）。
  否则 v1 存量账号与管理员直接建的号一升级就全被判成未验证，等于自己把自己锁在门外
- `email_verifications` 只存验证码**哈希**，并带 `attempts` 计数器；
  `purpose` 把「注册 / 找回密码 / 换绑邮箱」三种码彼此隔离——
  注册的码不能拿去重置密码，反之亦然

### 版本迁移

`SCHEMA_STATEMENTS` 全是 `CREATE TABLE IF NOT EXISTS`，**对已存在的表是空操作**。
所以只改建表语句的话，全新库正常、老库启动即报 `no such column`——这类 bug 只在升级时炸。

因此每次改表都要**两边都写**：建表语句给新库，`MIGRATIONS`（`db/schema.ts`）给老库。

启动流程（`db/database.ts`）：

```
检测 users 表是否存在
  ├─ 存在 → 先按 schema_meta.version 逐条跑迁移（每条迁移与版本号写入同一事务）
  └─ 不存在 → 跳过迁移（建表语句本身已是最新结构）
执行 SCHEMA_STATEMENTS（补齐缺失的表/索引）
写入 SCHEMA_VERSION
```

顺序不能颠倒：建表语句里含依赖新列的索引（如 `users(email)`），
在尚未迁移的老库上先跑会直接报错。

库版本**高于**程序支持的版本时拒绝启动——那说明代码被回滚了，
用旧代码操作新结构大概率静默写坏数据。

**`SCHEMA_VERSION` 由 `MIGRATIONS` 推导，刻意不手写**（`SCHEMA_VERSION = max(迁移版本)`）。
这不是洁癖，是踩出来的：手写时一旦出现「加了迁移却忘了改版本号」的漂移，
`runMigrations` 按「版本号大于当前就执行」会把比声明版本更新的迁移也跑掉，
随后版本号又被写回较小的值——结果**结构升了、版本号没升**。
等下次把版本号补对，那次迁移会再执行一遍；对 `v3` 这种表重建型迁移，
就是把表里的数据清空。推导之后两者不可能再漂移。

迁移可以是表重建：SQLite 不支持修改 `CHECK` 约束，`v3` 就是
「建新表 → 拷数据 → 删旧表 → 改名 → 重建索引」。
注意 `DROP TABLE` 会连索引一起删掉，所以索引必须显式重建。

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

### 6.1 自助注册（邮箱验证码）

注册分两步，**验证通过后才建号**：

```
POST /api/auth/register/code   { email }                               → 发 6 位验证码
POST /api/auth/register        { username, email, password, code }     → 验码后建号
```

为什么不是「先建号、状态 pending、验证后激活」：

- 库里不会留下「建了号但从没验证邮箱」的半成品账号
- 不需要动 `users.status` 的 CHECK 约束（SQLite 改约束要重建整张表）
- 服务端不需要暂存用户密码，前端把表单留在内存里重发即可

验证码规则：6 位数字、10 分钟有效、重发冷却 60 秒、
同一邮箱同一用途只保留一个有效码、单码最多猜 5 次（**超限即作废**）。

几个刻意的取舍：

- **验证码通过后才查用户名/邮箱是否重复**——没拿到验证码的人，
  连「这个邮箱是否已注册」都问不出来。被占用时**不消费验证码**，
  用户换个用户名就能接着用，不必重新收信
- `/register/code` 对「邮箱已注册」和「邮箱未注册」返回**完全一致**的响应，
  否则它就成了邮箱批量探测接口（重复注册在第二步以 409 明确告知）
- 验证码**只存哈希**（走 scrypt）。6 位数字只有 100 万种组合，
  明文存法一旦库泄露就等于所有人的在途验证码直接暴露
- 「没有待验证的码」时仍然跑一次哈希校验，避免用响应时间探测
  「某邮箱是否正处于验证流程中」（与用户名枚举同一套路）

新账号一律：

```
role = customer
6 个能力开关 = 全 0
max_devices = 0
```

所以注册完能登录，但**什么都看不到、什么都做不了**，直到管理员分配。
前端据 `permissionDenied` 显示「等待管理员分配设备」——
比直接拒绝登录更友好，也少一堆「为什么登不上」的询问。

**邮件发送**由 `relay/src/mail/mailer.ts` 负责，见第 10 节的环境变量。
开发环境默认 `MAIL_TRANSPORT=console`（验证码只打印进 relay 日志），
生产必须配 SMTP，否则没人能注册成功。

### 6.2 找回密码（忘记密码）

同样两步，但**不需要用户名**——身份凭据就是「能收到邮箱验证码」：

```
POST /api/auth/password/reset/code   { email }                      → 发重置验证码
POST /api/auth/password/reset        { email, code, newPassword }   → 验码后改密
```

改密成功后会**吊销该账号的全部会话**并触发访问纪元 +1（在线 WebSocket 立即重校验），
但**刻意不补发 token**：让用户用新密码重新登录一次，顺便确认记得住。

这个流程的防枚举比注册更麻烦，因为「邮箱是否注册过」直接决定了要不要发信。
三道处理缺一不可：

1. **响应完全一致**——未注册的邮箱也返回 200 与同样的字段
2. **未注册的邮箱也照常签发验证码**（只是不发信）。
   否则「验证码不存在」会立刻返回，而已注册邮箱无论对错都要跑一次 scrypt，
   文案与耗时的差异就是个现成的探测信号。顺带解决了另一个问题：
   验证码表的记录与「账号是否存在」无关，冷却期行为也就一致了
3. **发信不等待**（`background: true`）——定投要走一次 SMTP 往返（几百毫秒），
   不存在的邮箱则立刻返回，这个时间差本身就能判断账号是否存在。
   代价是发信失败只能进日志与审计，无法当场告诉用户

被**禁用**的账号照常收到验证码，只在最后一步以 403 明确拒绝。
反过来的话（禁用就不发信）等于告诉外人「这个号被禁了」。

### 6.3 换绑邮箱

```
POST /api/auth/email/code   { email }                               → 给「新邮箱」发码
POST /api/auth/email        { email, code, currentPassword }         → 改绑
```

两个刻意的设计：

- **验证的是新邮箱**，不是旧邮箱。旧邮箱此时可能已经收不到信了——
  那正是很多人要换绑的原因
- **额外要求当前密码**。邮箱是账号的找回通道，只凭一个被盗的会话就能改走邮箱，
  之后走一遍找回密码即可彻底接管账号

占用检查放在**验码之后**（与注册一致），避免这个接口变成「某邮箱是否已注册」的查询工具。
换绑成功后新邮箱直接记为已验证，旧邮箱立即失去找回能力（有测试覆盖）。

### 6.4 初始管理员

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
| POST | `/api/auth/register/code` | 发送注册验证码（限流：IP 与邮箱双维度，各 5 次 / 15 分钟） |
| POST | `/api/auth/register` | 自助注册，需带 `code`（限流：每 IP 每小时 10 次） |
| POST | `/api/auth/password/reset/code` | 发送重置验证码；**对未注册邮箱返回同样响应但不发信** |
| POST | `/api/auth/password/reset` | 用验证码设置新密码（限流：每 IP 每小时 10 次） |
| POST | `/api/auth/login` | 登录，返回 token（限流：用户名与 IP 双维度） |

### 需登录

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/me` | 当前用户与能力 |
| POST | `/api/auth/logout` | 登出（吊销当前会话） |
| POST | `/api/auth/password` | 改密（吊销全部会话并补发当前设备） |
| POST | `/api/auth/email/code` | 给**新邮箱**发送换绑验证码 |
| POST | `/api/auth/email` | 换绑邮箱（需当前密码 + 新邮箱验证码） |
| GET | `/api/my/devices` | **只返回分配给我的设备** |

### 管理端（仅 admin）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/meta` | 能力定义，供前端渲染勾选框 |
| GET | `/api/admin/users` | 用户列表（含各自设备数） |
| POST | `/api/admin/users` | 直接创建客户账号（邮箱可选，填了即记为已验证） |
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
| 11 | 验证码**只存哈希**，10 分钟过期 | 6 位数字空间太小，明文存储等于库一泄露就全员失守 |
| 12 | 单码最多猜 5 次，超限即作废 | 哈希只挡离线爆破，挡不住在线猜码 |
| 13 | 发码接口对「邮箱是否已注册」返回一致响应 | 把注册接口变成邮箱批量探测工具 |
| 14 | `devCode` 回显仅限**非生产环境 + console 邮件模式** | 防止把调试便利变成线上取码后门 |
| 15 | 验证码按 `purpose` 隔离（注册/重置/换绑） | 注册的码不能拿去重置密码，反之亦然 |
| 16 | 找回密码：未注册邮箱也返回一致响应**并签发码**，且发信不等待 | 用响应体、错误文案与**响应时间**三重防邮箱枚举 |
| 17 | 换绑邮箱需要**当前密码 + 新邮箱验证码** | 只有会话被盗时无法改走邮箱（那等于账号整体失守） |
| 18 | 找回密码成功后吊销全部会话 + 纪元 +1 | 密码被重置后，旧会话与在线连接必须立刻失效 |

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

### 邮箱验证（新增）

`tsc --noEmit` 通过（relay 与 web 两侧），`vite build` 通过。

**迁移**：拿真实的 v1 测试库（6 个存量账号）跑升级，日志输出
`[db] 已迁移到 v2：…`，存量账号 `email` / `email_verified_at` 均为 NULL 且
**仍能正常登录**（无邮箱按已验证对待）；重复启动不再触发迁移。

**新流程 43 条断言全部通过**，覆盖：

```
--- 发送验证码 ---
PASS  发码 200 + devCode 6 位数字 / 非法邮箱 400
PASS  冷却期内重发 429 / 冷却是按邮箱维度
--- 校验 ---
PASS  缺少验证码 400 / 错误验证码 400 / 弱密码 400 / 非法用户名 400
--- 正常注册 ---
PASS  注册 201 / 回显 email / emailVerified=true / 不含 passwordHash
PASS  能力默认全关 / 配额默认 0 / 注册后即刻可登录
--- 安全边界 ---
PASS  同一验证码不可复用 400
PASS  同一邮箱换个大小写仍判重 409（COLLATE NOCASE 生效）
PASS  用户名重复 409 且**验证码未被消费**，换名后同一码仍可用
PASS  猜错 2 次仍提示「不正确」，第 3 次达上限后即使码正确也被拒
--- 兼容与后台 ---
PASS  v1 老账号能登录 / email 为 null / emailVerified 为 true
PASS  管理端列表含 email 与 emailVerified
PASS  管理员建号（带邮箱）201 且直接记为已验证 / 非法邮箱 400
PASS  审计含 register_code_sent / register_code_rejected / auth.register
```

现有两套脚本也在**全新库**上复跑通过：`admin-api-contract-test` 70 条、
`phase-b-isolation-test` 30 条（后者顺带证明新注册流程建出的账号
在 WebSocket 隔离逻辑里一切正常）。

### SMTP 分支与生产模式（真实验证过）

console 模式只是开发便利，**真正要上线的是 smtp 分支**，所以它单独验证过：
起一个假 SMTP 服务器接住邮件，**9 条断言通过**（nodemailer 已成为正式依赖后复跑）——

```
PASS  发码 200 / 邮件确实抵达 SMTP 会话
PASS  MAIL FROM 是配置的发件人 / RCPT TO 是目标邮箱
PASS  能从邮件正文解出 6 位验证码，并用它完成注册（201 + emailVerified）
PASS  NODE_ENV=production 下响应里没有 devCode / 没有 code
```

**TLS 分支**单独验证了标志是否真的生效：把 `SMTP_SECURE=true` 指向那个
明文假服务器，发信必然握手失败，接口返回 502，日志里是
`SSL routines:tls_validate_record_header:wrong version number`——
说明 secure 标志确实传到了 nodemailer，而不是被忽略。
（真正的 TLS 握手成功与否需要真实服务商账号才能验，见第 10 节。）

### 并发与启动守卫

**并发双花**：同一邮箱 + 同一验证码，同时提交两个不同用户名 → 恰好
一个 201、一个 409，库里该邮箱只有 1 个账号。
真正兜底的是 `users.email` 的 **UNIQUE 索引**，而不是接口里的
`findUserByEmail` 预检查——预检查天然带竞态窗口。

**启动守卫**（必须 exit 1，且只给人话、不给堆栈）：

```
MAIL_TRANSPORT=smtp 但缺 SMTP_HOST  → [relay] 邮件配置有误，已拒绝启动：…
MAIL_TRANSPORT=carrier-pigeon       → …未知的 MAIL_TRANSPORT（可选值：console / smtp）
```

输出用 `writeSync(2, …)` 而不是 `console.error` + `process.exit`：
管道上的 stderr 是异步写入的，`process.exit` 会把尚未 flush 的内容丢掉
（Windows 上尤其明显），而这行信息是操作者唯一的线索。

### 找回密码与换绑邮箱（35 条断言全通过）

```
--- 发送重置码 ---
PASS  已注册邮箱 200 + devCode / 非法邮箱 400
PASS  未注册邮箱同样 200，且字段集合一致（除 devCode）
PASS  未注册邮箱不返回 devCode（因为确实没发信，日志里也没有该收件人）
--- 校验与改密 ---
PASS  错误验证码 400 / 弱密码 400 / 正确验证码 200
PASS  刻意不补发 token / 同一验证码不可复用
--- 改密之后 ---
PASS  旧密码登录 401 / 新密码登录 200
PASS  改密前签发的会话立即失效 401
--- 用途隔离 ---
PASS  注册的码不能拿来重置密码
--- 被禁用的账号 ---
PASS  仍然会发码（否则等于告诉外人它被禁了）/ 改密被拒 403
--- 换绑邮箱 ---
PASS  未登录请求换绑码 401 / 换成同一邮箱 400
PASS  当前密码错误 401 / 验证码错误 400 / 两者都对 200
PASS  新邮箱落库且标记已验证 / 被他人占用的邮箱 409
--- 换绑后的找回通道 ---
PASS  旧邮箱不再能找回 / 新邮箱可以找回
```

**迁移链**（v3 是表重建，重点验证不丢数据与幂等）：

```
v1 真实老库（6 个存量用户）→ v3：用户保留、CHECK 已更新
                          首次启动 2 条迁移日志，**第二次启动 0 条**
v2 库（带 1 条 reset 验证码）→ v3：旧记录完整保留（表重建未丢数据）
                          首次启动 1 条迁移日志，**第二次启动 0 条**
```

---

## 10. 运维配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `RELAY_DB_FILE` | `data/relay.db` | SQLite 文件路径（相对 relay 工作目录） |
| `ADMIN_USERNAME` | `admin` | 初始管理员用户名，仅首次启动生效 |
| `ADMIN_PASSWORD` | 随机生成 | 初始管理员密码，仅首次启动生效 |
| `MAIL_TRANSPORT` | `console` | `console` = 验证码只打印进日志；`smtp` = 真实发信 |
| `SMTP_HOST` / `SMTP_PORT` | 无 / `465` | `smtp` 模式必填；端口决定默认是否用隐式 TLS |
| `SMTP_USER` / `SMTP_PASS` | 无 | 多数服务商要用**授权码**而非登录密码 |
| `SMTP_FROM` | 同 `SMTP_USER` | 发件人地址 |
| `SMTP_SECURE` | 按端口推断 | `true` = 隐式 TLS（465），`false` = STARTTLS（587） |
| `VERIFICATION_CODE_TTL_MINUTES` | `10` | 验证码有效期 |
| `VERIFICATION_RESEND_SECONDS` | `60` | 重发冷却；小于 5 视为未设置，退回默认值 |
| `VERIFICATION_MAX_ATTEMPTS` | `5` | 单码最大猜错次数；小于 1 视为未设置，退回默认值 |
| `REGCODE_MAX_ATTEMPTS` | `5` | 发码限流：每 IP / 每邮箱，15 分钟窗口（三种用途各自计数） |
| `REGISTER_MAX_ATTEMPTS` | `10` | 注册限流：每 IP，1 小时窗口 |
| `RESET_MAX_ATTEMPTS` | `10` | 找回密码「提交新密码」限流：每 IP，1 小时窗口 |
| `NODE_ENV` | 无 | 设为 `production` 时**即便误用 console 也不会回显验证码** |

数据库文件已在 `.gitignore` 中排除（`*.db`、`relay/data/`），**切勿提交**。

### .env 支持

复制 `relay/.env.example` 为 `relay/.env` 即可免去每次手敲环境变量。
加载由 `relay/src/config/load-env.ts` 用 Node 内建的 `process.loadEnvFile`（20.12+）
完成，不引入 dotenv 依赖。

两条必须知道的规则：

- **真实环境变量优先于 `.env`**（已实测）。所以生产用 pm2 注入凭据、
  本地用 `.env` 调试可以共存，部署时也不会被磁盘上遗留的 `.env` 悄悄覆盖
- `load-env.ts` **必须是 `main.ts` 的第一个 import**，因为 `api/http.ts`（限流参数）
  与 `auth/emailVerification.ts`（验证码 TTL / 冷却 / 尝试上限）都是在**模块顶层**
  就把 `process.env` 读成常量的。改成「在 main.ts 里调一行」会得到一个最安静的
  错误组合：`.env` 里的 `SMTP_*` 生效、而 `VERIFICATION_*` 不生效

### 邮件配置（上生产必做）

```powershell
$env:MAIL_TRANSPORT='smtp'
$env:SMTP_HOST='smtp.exmail.qq.com'
$env:SMTP_PORT='465'
$env:SMTP_USER='noreply@your-domain.com'
$env:SMTP_PASS='<授权码>'
$env:NODE_ENV='production'
```

- **配置写错会拒绝启动**（未知的 `MAIL_TRANSPORT`、缺失的 `SMTP_*`）。
  这是刻意的：静默退回 console 意味着生产环境「以为在发信、实际只有日志」，
  结果是一个人都注册不进来，而且很久不会被发现
- `nodemailer` 已是 `relay` 的正式依赖，`npm ci` 会装好，**不需要额外安装**
- `SMTP_FROM` 必须与 `SMTP_USER` 一致，否则多数服务商直接拒收；
  `SMTP_SECURE` 不设时按端口推断（465 隐式 TLS / 587 STARTTLS），填错的表现是
  SSL 握手失败 + 注册接口 502
- 6 位验证码是典型的营销邮件特征，**发信域名务必配好 SPF / DKIM / DMARC**，
  否则大概率进垃圾箱。正式用建议走阿里云邮件推送 / 腾讯云 SES 这类服务
- 本地开发无需任何配置：默认 console 模式会把验证码打进 relay 日志，
  前端在非生产环境下还会**自动填入**返回的 `devCode`

> **尚未验证**：真实服务商的 TLS 握手与投递（需要真实账号与授权码）。
> 已验证的是 SMTP 会话本身、生产模式不回显、以及 TLS 标志确实生效——
> 详见第 9 节。

### 自动化测试的限流

测试脚本会反复注册与登录，容易撞上默认限流。**同一个 relay 进程连跑几轮尤其容易中招**，
而且症状具有迷惑性：登录返回 429 → token 是 undefined → 后续断言成片失败，
看起来像权限逻辑坏了。放宽后再跑：

```powershell
$env:REGISTER_MAX_ATTEMPTS='1000'
$env:REGCODE_MAX_ATTEMPTS='1000'
$env:LOGIN_MAX_ATTEMPTS='1000'
$env:RESET_MAX_ATTEMPTS='1000'
```

测试拿验证码的方式是从 `/api/auth/register/code` 的响应里读 `devCode`——
因此 relay 必须以**非生产**环境 + console 邮件模式启动。

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

> **前端进度**：登录/注册页、令牌存储、WebSocket 首条鉴权消息、**管理页面**
> （客户列表、设备分配、权限勾选框、审计日志）均已完成。
> 详见 **`docs/web-console.md`**。
