# 多租户化设计构思

> 状态：**构思稿**，未实施。
> 背景变化：remote-phone-control 的定位从「自用工具」变为「面向外部客户的 SaaS 产品」，
> 客户通过浏览器上传视频、生成任务、下发到连接设备的 Windows 主机，并按客户限制可用手机数量。

---

## 0. 这一版推翻了什么

| 原假设 | 多租户下的现实 |
|---|---|
| 只有你自己用 | 多个互不信任的客户共用同一批主机与设备 |
| relay 可以不鉴权 | 多租户下鉴权是**前置条件**，不是增强项 |
| 视频路径由 agent 本地扫目录选 | 视频由客户浏览器上传到服务器，再下发到 agent 主机 |
| 直接把 autojs API 透传给浏览器 | **不能透传**——autojs 没有租户概念，透传等于把 A 客户的设备和账号暴露给 B |

---

## 1. 三个必须先接受的事实

### 1.1 autojs-controller 完全没有租户概念

已核实：`/api/accounts`、`/api/devices`、`/api/automation/run-status` 全部是**全局作用域**。
`runState.getSnapshot()` 返回全局任务，账号列表带 `device_id` 但没有归属者。

**结论：隔离不能委托给 autojs，必须由我们这层强制执行。**
任何"把 `/api/automation/*` 直接暴露给浏览器"的方案都是错的。

### 1.2 relay 目前零鉴权、零持久化

`relay/src/main.ts` 只有一个内存 `Map<agentId, AgentConnection>`：

- `/ws/viewer` 任何人可连
- 无用户、无会话、无权限、无数据库
- 重启即丢全部状态

多租户要求持久化（租户/设备归属/视频/任务记录）与鉴权，这两块**都要新增**。

### 1.3 视频必须服务端中转，且必须走 pull

- 浏览器无法直连 agent 主机（NAT + 无入站端口）
- 服务器无法主动连 agent（会破坏 1.md 第 13 节确立的"agent 主动出站"原则，也会被防火墙拦住）

**唯一可行方向：浏览器 → 服务器（存），agent 主动出站去服务器拉。**

---

## 2. 核心洞察：租户作用域 ≡ 一个设备集合

这是整个设计能保持简单的关键。

只要**设备对租户是独占分配**的，那么租户的可见范围就完全由它拥有的 serial 集合决定，其余一切都是派生出来的：

| 资源 | 派生方式 |
|---|---|
| 可见账号 | `accounts` 中 `device_id ∈ 租户设备集` 的那些 |
| 可见任务 | `run-status` 中 `deviceId ∈ 租户设备集` 的 entries |
| 可执行任务 | 校验 `requested_device_ids ⊆ 租户设备集` |
| 可见视频 | `videos.tenant_id = 租户` |

**我们真正需要存储的归属数据只有一份：device → tenant 映射。**

而且独占分配还白送一个好处：**两个租户的任务天然不会争抢同一台手机**，并发安全不需要额外加锁。

前提条件（必须满足，否则派生失效）：

1. 每个账号都必须绑定 `device_id`（未绑定的账号归谁都不对 → 一律隐藏）
2. 设备分配必须互斥（一个 serial 只能属于一个租户）

---

## 3. 视频链路设计

### 3.1 全流程

```text
① 客户浏览器上传
   POST /api/videos  (multipart, 带租户会话)
        ↓
② 服务器落盘 + 记账
   media/<tenantId>/<videoId>/<safeName>.mp4
   DB: videos(id, tenant_id, original_name, safe_name, size, sha256, status, created_at)
   返回 videoId

③ 派发任务（WS 控制通道只传 JSON，不传字节）
   server → agent: { type:"task", taskId, tenantId, videoId, downloadUrl, sha256, sizeBytes }

④ agent 主动出站下载
   GET /api/agent/videos/<videoId>   (agent 自己的凭证，非租户凭证)
        ↓
⑤ agent 落地（保留原始文件名，见 3.3）
   D:\remote-phone-media\<tenantId>\<videoId>\<safeName>.mp4
   校验 sha256

⑥ agent 调 autojs
   POST /api/automation/send-video/start
   { accounts, video_paths:[本地绝对路径], device_ids:[...], send_time, titles, ... }

⑦ 任务完成 / TTL 到期后清理本地文件
```

### 3.2 为什么走 pull 而不是 push

- 保持 agent 只需出站连接，符合现有架构与 NAT 现实
- 下载走独立 HTTPS，**不占用 WS 控制通道**（否则大文件会阻塞设备列表和输入指令）
- 天然支持断点续传与重试
- 支持一对多：一个视频要下发到多台 agent 主机时，各自去拉

### 3.3 ⚠️ 本地落地路径必须保留原始文件名

autojs 的 `normalizeVideoNames(body.videos, body.videoPaths)` 会**从路径的 basename 推导视频名**，
而这个名字会写进生成的脚本（`TARGET_VIDEO`），成为手机侧识别视频的依据。

所以**不能**把文件存成 `<videoId>.mp4`（会丢失可读名字，也可能影响业务语义）。

正确做法是每个视频一个独立目录，basename 保持原样：

```
D:\remote-phone-media\<tenantId>\<videoId>\<safeName>.mp4
```

目录由 `videoId` 保证唯一，basename 由 `safeName` 保证语义，两者都不冲突。

---

## 4. ⚠️ 安全：两处注入必须先堵

**这是本文档最重要的一节。** 在自用场景下无所谓，在多租户下等于把主机控制权交给客户。

### 4.1 生成的 AutoJS 脚本存在注入（严重）

`scripts_renderer/buildsendVedio.js:90`：

```js
code = code.replace(/{{SCHEDULED_TIME}}/g, SCHEDULED_TIME || '');
```

而模板 `scripts/sendVedio_precise_template.js:9` 是：

```js
let SCHEDULED_TIME = "{{SCHEDULED_TIME}}";   // 外层已有双引号
```

`SCHEDULED_TIME` 来自 `String(body.send_time || body.sendTime || '').trim()`，**完全未转义**。

因此只要传入：

```
send_time = "; <任意 JS>; //
```

就能闭合字符串并**在手机上执行任意 AutoJS 代码**。
手机上有客户的 TikTok 登录态，也能读本机文件、发网络请求——后果严重。

**对比：同一文件里其他字段的处理是正确的**

| 字段 | 处理 | 评价 |
|---|---|---|
| `TARGET_ACCOUNT` / `TARGET_VIDEO` | `escapeForDQ()` | ✅ 正确（先转义 `\` 再转义 `"`，顺序对） |
| `PRODUCT_NAME` / `LOCATION_TEXT` | `escapeForDQ()` | ✅ 正确 |
| `TITLE_TOPIC` | `JSON.stringify()` | ⚠️ 基本可用，但 U+2028/U+2029 在旧 Rhino 上可能出问题 |
| **`SCHEDULED_TIME`** | **无** | ❌ **漏洞** |

**修复方向**：`send_time` 必须走白名单校验（严格正则），而不是靠转义。

```
^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$
```

### 4.2 ADB 命令拼接存在注入（严重）

`server.js:1272` 与 `1276`：

```js
await execCommandAsync(`"${deviceManager.adbPath}" -s ${deviceId} shell "mkdir -p '${remoteDir}'"`, 10000);
await execCommandAsync(`"${deviceManager.adbPath}" -s ${deviceId} push "${localPath}" "${remotePath}"`, timeout);
```

`remotePath` 形如 `/sdcard/SaveVideo/<account>/<file>`，其中 `<file>` 来自调用方传入的
`video_paths` 的 basename。Windows 上 `exec()` 经由 `cmd.exe`，
文件名中出现 `"` 即可跳出引号 → **在 Windows 主机上执行任意命令**。

而这台主机持有全部设备、全部账号和 autojs 授权，是最敏感的资产。

**修复方向**：上传时对文件名做**白名单字符过滤**，而不是事后转义：

- 只允许 `[A-Za-z0-9._-]`，其余一律替换为 `_`
- 长度上限（如 80 字符）
- 强制小写扩展名且限定 `mp4` / `mov`
- 禁止以 `.` 开头、禁止路径分隔符

这一条同时解决了 autojs 侧的兼容问题，是双重收益。

### 4.3 其他输入也要限长

`titles` / `product_name` / `location` 虽然已有 `escapeForDQ`，仍应加长度上限与条数上限，
作为纵深防御。

---

## 5. 设备配额与分配

### 5.1 数据模型

```sql
tenants (
  id, name, status,
  max_devices            INTEGER,   -- 可用手机数量上限
  max_concurrent_tasks   INTEGER,   -- 并发任务上限
  max_storage_bytes      INTEGER,   -- 视频存储配额
  created_at
)

devices (
  serial      TEXT PRIMARY KEY,     -- 形如 192.168.9.41:65535，全局唯一
  agent_id    TEXT NOT NULL,
  tenant_id   TEXT,                 -- NULL = 未分配
  assigned_at TEXT,
  note        TEXT
)
```

配额校验点：

| 时机 | 校验 |
|---|---|
| 分配设备 | `COUNT(devices WHERE tenant_id=T) < max_devices` |
| 派发任务 | 目标设备集 ⊆ 该租户设备集，且并发任务数 < `max_concurrent_tasks` |
| 上传视频 | 累计存储 < `max_storage_bytes` |

### 5.2 两种分配模型

**模型 A：静态分配（推荐先做）**

管理员把具体 serial 绑定给租户，配额就是"最多能绑几台"。

- ✅ 行为可预测，客户知道自己固定用哪几台
- ✅ 无需锁、无租约、无过期清理
- ✅ 派生式隔离（第 2 节）直接成立
- ❌ 设备利用率低（客户不用时设备闲置）

**模型 B：动态池化**

设备进池，租户按需申请 N 台并带 TTL。

- ✅ 利用率高
- ❌ 需要租约、过期回收、并发抢锁、孤儿租约清理
- ❌ 租户与设备的映射变成时变的，第 2 节的"派生"变得复杂
- ❌ 客户体验不确定（每次拿到的可能不是同一批手机，账号绑定会错乱）

**建议：先做 A。** 模型 B 的复杂度主要来自"账号绑定在设备上"这一约束——
如果租户每次换设备，账号与设备的绑定关系就需要跟着迁移，很容易出错。

### 5.3 设备数量之外还应限制的维度

客户数量限制只是最直观的一条。实际运营中还建议：

- **并发任务数**：防止一个客户同时占用整台主机的 CPU 与 ADB
- **每日任务数**：防刷（批量发帖是高风险行为）
- **视频存储**：防止磁盘被塞满
- **单视频大小**：防止上传超大文件

---

## 6. 鉴权与执行点

### 6.1 需要新增的鉴权层

```
客户浏览器 --登录--> 会话/JWT --> relay 解析出 tenantId
Agent     --长期凭证--> relay 校验 agentId 归属
```

- `/ws/viewer` 连接必须携带凭证，否则拒绝
- 每条消息都按 `tenantId` 收窄作用域
- 现有 `broadcastViewerMessage()` 是**广播给所有 viewer** 的
  （`relay/src/main.ts:422`），多租户下必须改为**按租户定向发送**

### 6.2 隔离执行点（双层）

| 层 | 职责 |
|---|---|
| **relay（主）** | 解析租户身份；计算该租户在目标 agent 上的 `allowedDeviceIds`；过滤所有读取接口；派发前校验 |
| **agent（纵深防御）** | 收到任务后**再校验一次** `requested ⊆ allowed`，然后才调 autojs |

agent 侧再校验一次是必要的：agent 持有 autojs 的裸连接，
如果只信任服务端下发的设备列表，一旦服务端有 bug 就会直接打穿。

---

## 7. 服务端数据模型（汇总）

现有 relay 是纯内存的，需要新增持久化。起步用 SQLite 即可，规模上来再换 PostgreSQL。

| 表 | 用途 |
|---|---|
| `tenants` | 租户与配额 |
| `users` | 登录账号，隶属租户 |
| `sessions` / `api_tokens` | 会话与凭证 |
| `devices` | serial → tenant 归属 |
| `videos` | 上传视频元数据与 sha256 |
| `tasks` | 任务派发与结果（含 push_result / run_result） |
| `audit_log` | 谁在何时对哪些设备做了什么 |

`audit_log` 在商业服务里不是可选项——出纠纷或滥用时需要能回溯。

---

## 8. 分阶段落地建议

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **S0** | 堵住第 4 节的两处注入 + 输入校验 | 无。**应最先做**，与多租户解耦 |
| **S1** | relay 落库（tenants / devices / users） + 登录鉴权 + WS 定向发送 | 无 |
| **S2** | 设备分配与配额（模型 A） | S1 |
| **S3** | 视频上传 + agent 拉取 + 落地 + 任务派发 | S1、S2 |
| **S4** | 审计日志、配额细化（并发/存储/每日任务） | S3 |

**S0 建议立刻做**：它不依赖任何多租户设计，而且现在就已经是敞开的。

---

## 9. 待决策

1. **设备归属模型**：静态分配（A）还是动态池化（B）？我建议 A。
2. **主机与租户的关系**：所有租户共用同一批 Windows 主机（设备级隔离），
   还是每个租户独占主机（物理隔离）？
   - 共用主机 → 依赖第 2 节的派生式隔离，成本低
   - 独占主机 → 隔离更彻底，但 autojs 授权、运维成本成倍增加
3. **autojs 的授权归属**：autojs 按机器码激活。
   多主机意味着**每台主机都要一份授权**，这是持续的运营成本，需要先算清楚。
4. **是否长期依赖 autojs**：见第 10 节。

---

## 10. 一个需要中期决策的战略问题

把商业多租户产品建立在一个**闭源、单租户、按机器授权的 Electron 应用**上，有几个硬约束：

- **无法在它内部做租户隔离** → 所有隔离都得靠我们这层"绕开它做过滤"，脆且难维护
- **两处注入漏洞在它代码里** → 我们只能靠输入白名单在外面兜住，改不了它本身
- **授权依赖** → 主机越多成本越高，且授权失效会直接导致服务不可用
- **不可控** → 它升级可能改变行为，而我们没有话语权

它的实际职责其实不复杂：**生成脚本 → `adb push` → `am start`**。
`server.js` 里这几步（`pushScriptOnlyToDevices`、`runScriptNowOnDevices`）加起来不到 100 行。

**中期建议评估自建这条链路**，把 autojs 换成自己可控的实现：

- 消除授权依赖
- 注入与隔离在自己手里
- 租户概念可以原生做进去

**但这是中期决策，不是现在**——autojs 里那几千行手机上跑的 AutoJS 脚本（
`sendVedio_precise_template.js` 有 3140 行）是有真实价值的资产，重写成本很高。
短期正确做法是：**把它当成一个不可信的单租户后端，用严格输入白名单和双层隔离把它围起来。**
