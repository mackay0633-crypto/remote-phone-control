# 浏览器控制台与管理后台（Phase C）

> 状态：**登录 / 注册 / 令牌 / WebSocket 鉴权 / 管理后台**均已完成。
> 管理后台的接口契约经 **65 条断言**验证；
> WebSocket 隔离经 **30 条断言**验证。
> 尚未开始：养号与发视频面板。

---

## 1. 前端结构

原本 `App.tsx` 是一个 800 行的单文件。加入账号体系后拆分：

```
web/src/
├── App.tsx            应用外壳：会话生命周期、顶栏、控制台/管理 视图切换
├── LoginView.tsx      登录 / 注册表单（含本地模式的占位用户）
├── ConsoleView.tsx    控制台：设备墙 + 实时画面 + 触控
├── AdminView.tsx      管理后台：客户与权限、设备分配、审计日志
├── api/
│   ├── session.ts     令牌与用户的本地存储
│   └── client.ts      HTTP API 客户端、ApiError、模式判定
└── styles.css         登录页 / 顶栏 / 管理后台样式
```

### 两种模式

| 模式 | 判定 | 行为 |
|---|---|---|
| 中继模式 | 设置了 `VITE_RELAY_WS_BASE_URL` | 走账号系统：未登录显示登录页；WS 首条消息携带令牌 |
| 本地模式 | 未设置 | 直连本机 Agent，跳过登录（Agent 没有账号体系） |

API 基址由 `VITE_RELAY_WS_BASE_URL` 推导：`ws://host:5081` → `http://host:5081`。
因为前端与 relay 同源部署（nginx 托管静态文件并反代 relay），这样推导是成立的。

---

## 2. WebSocket 鉴权流程

两个 WS 端点都要求**首条消息**携带令牌，超时 5 秒未鉴权即断开：

```
控制通道
  浏览器 → ws://host/ws/viewer
  浏览器 → { "type": "auth", "token": "<会话令牌>" }
  服务端 → { "type": "auth-ok", user: { ... } }
  服务端 → { "type": "devices", devices: [...只含自己的...] }

视频流通道
  浏览器 → ws://host/ws/viewer/stream?serial=<serial>
  浏览器 → { "type": "auth", "token": "<会话令牌>" }
  服务端 → { "type": "stream-ready", ... }   随后是二进制帧
```

**令牌不放查询串**——URL 会进服务器日志、反向代理日志和浏览器历史。

另外 `agentId` 不再由前端提供：relay 按 `serial` 从在线设备表反查，
客户端传什么都不会被信任。

### 权限变更推送

管理员改权限后，relay 在重校验所有连接时会额外推：

```json
{ "type": "permissions", "role": "customer", "capabilities": { ... } }
```

前端收到后更新本地会话并写回 `localStorage`，按钮状态随之刷新。
没有这一步的话，页面会按登录时的旧权限显示按钮，用户点了才被服务端拒绝。

---

## 3. 令牌存储：一个需要重新评估的取舍

当前用 `localStorage` 存令牌：

| | localStorage | httpOnly Cookie |
|---|---|---|
| 实现 | 简单，不受跨域限制 | 需要处理跨域与 CSRF |
| XSS 风险 | **脚本可直接读走令牌** | 脚本读不到 |

选它的原因：前端与 API 可能不同源，Cookie 需要额外配置 `SameSite` / `Domain` / CSRF。

⚠️ **上线前建议重新评估**，尤其是页面将来要渲染用户上传内容（视频标题、
文件名等）时——那会引入 XSS 面。

---

## 5. 管理后台

管理员登录后顶栏出现「控制台 / 管理」切换。管理后台分三块：

### 5.1 客户与权限

左列客户卡片（显示各自已用/配额），右侧是选中账号的：

- **权限开关** —— 6 个能力的勾选框，标注了「查看设备列表」是基础开关
- **配额** —— 最多设备 / 并发任务 / 存储上限（失焦或回车提交）
- **已分配设备** —— 列表 + 逐台「收回」
- **禁用 / 启用账号** —— 禁用会立刻吊销其全部会话

配额为 0 时会显示黄色提示「无法分配任何设备，请先调大配额」，
避免管理员在界面里反复尝试却被服务端拒绝。

### 5.2 设备分配

全量设备表格：设备号、在线状态、归属、操作。
顶部有「分配到」下拉选择客户，选中后点任意空闲设备的「分配」即可。

### 5.3 审计日志

最近的操作记录：时间、操作者、动作、目标。

### 5.4 一个刻意的设计选择

每个动作完成后都会**回读服务端结果**，而不是本地乐观更新。

原因：分配设备会被配额拒绝、改权限可能失败。乐观更新会让界面显示一个
并不存在的状态——用户以为分配成功了，刷新才发现没有。

### 5.5 契约测试

`relay/dev/admin-api-contract-test.mjs` 逐字段验证界面依赖的响应结构，
**65 条断言全部通过**：

```
--- 权限元数据 ---   meta 有 6 个能力，每项含 key 与 label
--- 客户列表 ---     deviceCount 是数字 / capabilities 是布尔 / 不含 passwordHash
--- 设备列表 ---     online 是布尔 / assignedUsername 可空
--- 权限开关 ---     未提及的字段保持关闭 / 返回 changes
--- 配额 ---         负数被拒 / 空变更被拒
--- 设备分配 ---     超配额 400 且错误信息可读 / 归属写入后表格能显示用户名
--- 收回设备 ---     回到空闲 / 客户已用数量减 1
--- 禁用启用 ---     报告吊销的会话数 / 非法状态被拒
--- 审计日志 ---     含 created_at / actor_username / action / target
--- 非管理员 ---     5 个管理端点全部 403
```

**为什么单独做契约测试**：前端在受限沙箱里启动不了（Vite 需要 esbuild 子进程），
而响应结构不对时 UI 是**静默出错**——显示 `undefined`、按钮判断失效，
比直接报错更难排查。

---

## 6. 运行与构建

```powershell
# 开发（本地模式，直连 Agent 5071）
npm run web:dev

# 开发（中继模式，需要 relay 与账号系统）
$env:VITE_RELAY_WS_BASE_URL = "ws://127.0.0.1:5081"
npm run web:dev
```

**构建**：`web/package.json` 里**没有 `build` 脚本**，只有 `dev`。
`web/dist/` 是既有产物，需要重新构建时手动执行：

```powershell
cd web
npx vite build
```

> 部署时由 nginx 托管 `web/dist`，并反代 relay 的 HTTP 与 WebSocket。
> 反代 WebSocket 必须带 `Upgrade` 与 `Connection` 头（README 已有说明）。

---

## 7. 已知限制

1. **养号 / 发视频面板还没做** —— agent 侧的 `/api/autojs/*` 已就绪，
   relay 转发与前端界面待做。

2. **视频上传还没做** —— 客户上传素材、服务器落盘、agent 拉取这条链路未实现。

3. **播放器仍是 JMuxer**（现有实现），未做 WebRTC。

4. **前端构建无法在受限沙箱内验证** —— Vite 需要 esbuild 子进程。
   已完成的是 `tsc --noEmit` 类型检查（通过）与接口契约测试（65 条通过）。

5. **`web/package.json` 没有 `build` 脚本** —— 只有 `dev`。
   出生产产物需手动 `cd web; npx vite build`。

6. **`web/src/main.js` 是未被引用的编译残留** —— `index.html` 加载的是
   `/src/main.tsx`。可以删除，但未动它以免影响你的既有流程。
