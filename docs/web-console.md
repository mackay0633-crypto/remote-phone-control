# 浏览器控制台与管理后台（Phase C）

> 状态：**登录 / 注册 / 令牌 / WebSocket 鉴权 / 管理后台 / 养号 / 发视频**
> 均已完成。断言数：管理后台契约 **70**、WebSocket 隔离 **30**、
> 自动化转发 **29**、发视频链路 **49**、agent 下载 **19**、agent 下发 **24**、
> 前端同源反代 **15**。
>
> 发视频的完整链路与安全边界见 [`docs/video-pipeline.md`](./video-pipeline.md)。

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

**构建**：

```bash
npm run build --workspace web      # 产物在 web/dist/
```

**不需要任何构建时变量**，产物本身就是通用的。

## 界面方案：布局 × 主题（两个独立的轴）

界面有**两个正交的轴**，5 套预设 = 两轴的组合：

| 轴 | 决定什么 | 代码在哪 |
|---|---|---|
| **布局 layout** | 东西**摆在哪**：导航位置、设备怎么表现、画面占多大 | `web/src/layouts/` |
| **主题 theme** | **什么颜色**：配色、圆角、阴影、密度 | `web/src/themes/` |

分开的价值：能自由组合（`?layout=table&theme=warm`），也能各自独立演进。
**布局文件里不写颜色，主题文件里不写尺寸** —— 混了以后就没法组合了。

### 五套预设

| # | 预设 | 布局 | 主题 | 结构上的区别 |
|---|---|---|---|---|
| 1 | 经典 | `classic` | `neon` | 顶部大标题 + 四张指标卡 + 左画面右**卡片墙**（与线上现状一致） |
| 2 | 主从三栏 | `master-detail` | `light` | **导航移到左侧竖栏**；设备变**行列表**；画面独立成中栏；右侧信息栏 |
| 3 | 表格密集 | `table` | `corporate` | 整页是**一张八列设备表**（一台一行），画面嵌在右侧固定栏 |
| 4 | 工作台 | `studio` | `terminal` | **画面优先**（约占 2/3 视口），设备变**芯片**，右侧窄工具条 |
| 5 | 设备墙 | `wall` | `warm` | **墙为主体** + 顶部一条扁预览横幅 —— 与经典的主次正好相反 |

五套在四件事上各不相同：**导航在哪 / 设备怎么表现 / 画面占多大 / 信息层级**。

### 怎么预览

```bash
node scripts/dev-web-test.mjs        # 起前端（8090）
```

| 目的 | 地址 |
|---|---|
| **五套并排对比** | http://127.0.0.1:8090/preview.html |
| 单看一套 | http://127.0.0.1:8090/?layout=table&theme=corporate |
| 带切换器 | http://127.0.0.1:8090/?preview=1 |
| 混搭 | http://127.0.0.1:8090/?layout=studio&theme=warm |

`preview.html` 里是**五个真实的 iframe**（不是截图），每一格都能点、能切页签；
点"全屏打开"看完整页面。右上角的「🎨 方案」切换器**只在带 `?layout=` /
`?theme=` / `?preview=1` 时出现** —— 普通用户不该看到换方案的开关。

选择存进 `localStorage`（`rpc.ui.theme` / `rpc.ui.layout`）。地址栏参数
**优先于** localStorage：否则预览页里五个 iframe 会同时显示同一套。

### 换默认方案

改 `theme.ts` 里的 `DEFAULT_THEME` / `DEFAULT_LAYOUT` 各一行。

### 加一套新布局

1. 在 `layouts/pieces.tsx` 里挑现成零件（`FocusScreen`、`ControlBar`、`DeviceList`、
   `DeviceTable`、`DeviceChips`、`DeviceTiles`、`StatStrip`、`metaFields`），
   在 `layouts/shells.tsx` 里拼一个新外壳
2. 在 `shapes.tsx` 的 `ConsoleLayout` 分发里加一个 case
3. 在 `theme.ts` 的 `LAYOUTS` 加一行；需要左侧导航就加进 `SIDEBAR_LAYOUTS`
4. 在 `layouts/layout.css` 里加位置/尺寸规则（**不写颜色**）
5. 在 `public/preview.html` 的 `PRESETS` 加一行

> ⚠️ **新增布局必须自己处理画面尺寸。** 基础样式 `styles.css` 是给经典布局量的：
> `.screen-frame` / `.screen-content` **硬编码 `min-height: 600px`**，
> `.device-video-shell` 死写 300×600。而在 CSS 里 **`min-height` 永远赢过
> `max-height`** —— 所以想在小外框里放画面，光写 `max-height` 完全无效
> （踩过：改完截图一看纹丝不动）。
>
> 做法是靠 `<html data-layout>` 按布局整体覆盖：先 `min-height: 0`，
> 再让手机框 `aspect-ratio` + `max-height: var(--screen-max)` 自动跟随。
> 画面高度上限在 `layout.css` 里按 `[data-layout="…"]` 给。

### 加一套新主题

不需要复制样式表。规则只在 `web/src/themes/palette.css` 里写一遍，
主题只提供变量：

1. 在 `themes.css` 里加一个 `:root[data-theme="新id"] { --accent: …; … }`，
   照抄 `neon` 那一块改值即可（**别漏**密度那 10 个变量，
   漏了会回退成基础样式，看起来像"没生效"）
2. 在 `theme.ts` 的 `THEMES` 里加一行
3. 在 `public/preview.html` 的 `PRESETS` 里引用它

> ⚠️ **两条顺序约束**，反了就会出怪问题：
> - `layouts/layout.css` 与 `themes/*.css` 必须在 `styles.css` **之后**加载
>   （它们靠 `[data-layout]` / `[data-theme]` 前缀提高特异性压过基础样式）
> - `initTheme()` / `applyLayout()` 必须在 React 渲染**之前**调用

**测试**：`node .tmp-test/check-theme-vars.mjs` 这类校验脚本能查出"某套漏了
变量"。更可靠的是直接看 —— 五宫格截图一眼就能发现某格没生效。

### 改 UI 时先截图，别靠"感觉好点了"

改 CSS 最容易犯的两个错：「以为好看了其实更糟」和「改了某个元素把它挤出视口」。
`scripts/dev-screenshot.mjs` 直连 Chrome DevTools Protocol（零依赖，
用 Node 内置的 WebSocket），先截"改之前"、改完再截"改之后"，两张摆一起看：

```bash
node scripts/dev-web-test.mjs            # 另开窗口：起前端 + relay + 假 agent
node scripts/dev-screenshot.mjs --out .tmp-test/before.png
# …改 CSS…
npm run build --workspace web
node scripts/dev-screenshot.mjs --out .tmp-test/after.png
```

它自己会登录（默认 `admin` / `DevTest123456`）、把 token 写进 localStorage，
再用 `--view automation|admin` 切页签，最后整页截图。浏览器用临时 profile，
不碰你日常那个。

三个额外开关，够应付大部分 UI 验证：

```bash
--click "发视频"        # 按文字点按钮（切子标签页）
--eval "<js>"           # 截图前跑一段页面 JS（验证交互，比如点置灰项看提示）
--no-auth               # 静态页/探针页没有账号系统，跳过登录
--url 可带路径          # 如 http://127.0.0.1:8090/preview.html
```

> ⚠️ **别用 PowerShell 的 `Set-Content` 改这个仓库里带中文的文件。**
> PS 5.1 的 `Set-Content` 默认按 **ANSI(GBK)** 写盘，会把中文写成乱码，
> 文件直接变成非法 UTF-8（`node` 和编辑工具都读不了）。已经踩过一次，
> 只能 `git checkout` 回滚重做。改文件用编辑工具，或
> `[System.IO.File]::WriteAllText($p, $text, [System.Text.UTF8Encoding]::new($false))`。

> ⚠️ **注意地址用 `127.0.0.1` 时前端会走"本地直连模式"**（见 `api/client.ts`
> 的来源判断），自动化页会显示"仅在部署环境下可用"，而且控制台读的是本机
> agent 5071 上的真机而不是假 agent。想验证中继模式的页面，得临时带
> `VITE_RELAY_WS_BASE_URL` 构建 —— **看完记得重新纯净构建**，别把地址烤进产物。

> 早先这里有个隐患：`scripts/dev-web-test.mjs` 从前让前端**跨源**直连
> `:5091`，因此要求用 `VITE_RELAY_WS_BASE_URL` 构建，把地址烤进产物 ——
> 那份 `web/dist` 一旦被误传到服务器，客户浏览器会去连自己的
> `127.0.0.1:5091`，前端直接废掉。
>
> 现在该脚本把 `/api` 与 `/ws` **反代到 relay**，前端与 relay 同源
> （与生产的 nginx 部署一致），所以普通生产构建直接可用，隐患从结构上消失。
>
> 生产仍建议**在服务器上构建**（`bash deploy/deploy.sh` 会做），
> 这样产物与代码版本天然一致，不会出现本地陈旧产物被误用。

> 部署时由 nginx 托管 `web/dist`，并反代 relay 的 HTTP 与 WebSocket。
> 反代 WebSocket 必须带 `Upgrade` 与 `Connection` 头（README 已有说明）。

---

## 7. 已知限制

1. **播放器仍是 JMuxer**（现有实现），未做 WebRTC。

2. **前端构建需在普通（非受限）环境验证** —— Vite 需要 esbuild 子进程。
   已完成的验证是 `tsc --noEmit` 类型检查（通过）、`vite build`（通过，
   产物 302 kB / gzip 92 kB）与同源反代下的接口契约测试。

3. **`web/src/main.js` 是未被引用的编译残留** —— `index.html` 加载的是
   `/src/main.tsx`。可以删除，但未动它以免影响既有流程。

## 8. 养号与发视频

两个面板都在「自动化」页。请求走**独立的 viewer 连接**
（`web/src/api/automation.ts`），不和控制台那条共用——
控制通道的生命周期绑在实时画面上，切设备会重建连接，
而发视频可能跑好几分钟，共用会导致切个设备就把在途请求丢掉。

### 养号

选设备 + 五个行为参数 → `dayil-work.start`。界面填「秒」，
下发时换算成毫秒（`PLAY_DURATION`），因为 autojs 的模板收的是毫秒。

参数名与取值范围必须与 `agent/src/autojs/autojs-validation.ts` 一致：
`buildDayilWork` 会把配置项**原样替换进无引号的 JS 占位符**
（`var SWIPE_COUNT = {{SWIPE_COUNT}};`），所以字符串值等于代码注入。
校验层只接受有限整数与白名单键名。

### 发视频

素材库（上传 / 列表 / 删除）+ 发布设置（精准 / 批量）。
完整链路与安全边界见 [`docs/video-pipeline.md`](./video-pipeline.md)。

界面上两个刻意的取舍：

- **账号从 `accounts` 接口拉，不由界面编造** —— 账号名会成为手机上的
  远程目录名（`/sdcard/SaveVideo/<account>/`），必须与 autojs 里真实
  存在的账号一致。
- **批量模式只做「账号 ↔ 视频」配对** —— autojs 的 batch 语义就是
  `assignments: [{account, video}]`，界面直接映射，不额外发明概念。
  配对里的 `video` 用的是**规范化后的文件名**，因为 autojs 从
  `video_paths` 的 basename 推导视频名，两边必须完全一致。
