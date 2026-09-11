# autojs 输入校验层（S0）

> 目标：堵住 autojs-controller 把调用方输入拼进「脚本」与「命令行」所造成的注入。
> 约束：**不改动 autojs-controller 的任何文件**（含 `scripts/` 下的脚本模板）。
> 位置：校验全部实现在 remote-phone-control 的 agent 侧。

---

## 1. 背景：三条真实的注入路径

autojs-controller 会把调用方传入的字符串用两种危险方式消费。以下均为**实测确认**，不是推测。

### 1.1 `send_time` → 生成脚本时字符串未转义

`scripts_renderer/buildsendVedio.js:90`

```js
code = code.replace(/{{SCHEDULED_TIME}}/g, SCHEDULED_TIME || '');
```

模板 `scripts/sendVedio_precise_template.js:9` 是：

```js
let SCHEDULED_TIME = "{{SCHEDULED_TIME}}";   // 外层已有双引号
```

`send_time` 经 `String(body.send_time || body.sendTime || '').trim()` 后**原样注入**。

实测（取模板做同样的替换）：

```
模板原文 : let SCHEDULED_TIME = "{{SCHEDULED_TIME}}";
传入值   : "; globalThis.__pwned = 1; //
生成结果 : let SCHEDULED_TIME = ""; globalThis.__pwned = 1; //";
```

闭合字符串成功，注入的语句成为脚本的一部分，**在手机上执行**。

> 同一文件里 `TARGET_ACCOUNT` / `TARGET_VIDEO` / `PRODUCT_NAME` / `LOCATION_TEXT`
> 都走了 `escapeForDQ()`（且先转义 `\` 再转义 `"`，顺序正确），
> `TITLE_TOPIC` 走 `JSON.stringify()`。**只有 `SCHEDULED_TIME` 漏了。**

### 1.2 `dayil-work` 的 `config` → 键与值都可控

`scripts_renderer/buildDayilWork.js:24-27`

```js
for (const [key, val] of Object.entries(config)) {
  let valueStr = (typeof val === 'object') ? JSON.stringify(val, null, 2) : val;
  code = code.replace(new RegExp(`{{${key}}}`, 'g'), valueStr);
}
```

两个问题叠加：

1. **键名可控** —— 用调用方给的键去构造正则匹配模板占位符
2. **值不转义** —— 非对象值直接替换

而 `scripts/DayilWork_template.js` 里这些占位符**没有引号**，是裸的 JS 表达式位置：

```js
var SWIPE_COUNT = {{SWIPE_COUNT}};
var SWIPE_COUNT_MIN = {{SWIPE_COUNT_MIN}};
var SWIPE_COUNT_MAX = {{SWIPE_COUNT_MAX}};
var PLAY_DURATION = {{PLAY_DURATION}};
var LIKE_PROBABILITY = {{LIKE_PROBABILITY}};
var FOLLOW_PROBABILITY = {{FOLLOW_PROBABILITY}};
var COMMENT_PROBABILITY = {{COMMENT_PROBABILITY}};
var FAVORITE_PROBABILITY = {{FAVORITE_PROBABILITY}};
var SEARCH_PROBABILITY = {{SEARCH_PROBABILITY}};
var WAIT_AFTER_SEARCH = {{WAIT_AFTER_SEARCH}};
var LIVE_WATCH_DURATION = {{LIVE_WATCH_DURATION}};
```

所以 `config: {"SWIPE_COUNT": "1; evil()"}` 即可注入，**同样是在手机上执行**。
（模板中另有 `SEARCH_KEYWORDS` / `TALK_CONTENT` / `TARGET_ACCOUNTS` / `LIVE_CHAT_CONTENT`
四个走 `JSON.stringify` 的列表占位符，风险较低但仍需限量。
`SCRIPT_RUN_ID` / `SCRIPT_TYPE` 会被 `buildDayilWork` 用自身 meta 覆盖，调用方无法控制。）

### 1.3 视频文件名 → 拼进 adb 命令行

`server.js:1272` 与 `1276`

```js
await execCommandAsync(`"${deviceManager.adbPath}" -s ${deviceId} shell "mkdir -p '${remoteDir}'"`, 10000);
await execCommandAsync(`"${deviceManager.adbPath}" -s ${deviceId} push "${localPath}" "${remotePath}"`, timeout);
```

`remotePath` 形如 `/sdcard/SaveVideo/<account>/<file>`。
Windows 上 `exec()` 经由 `cmd.exe`，而 **cmd.exe 逐个引号切换引号状态**，
因此文件名里出现 `"` 就能跳出引号区，`&` `|` 等分隔符随即生效。

实测（把目标程序换成 `echo`，安全无副作用）：

```
文件名   : my " & echo CMD-INJECTION-WORKED & " video.mp4
cmd.exe 收到: echo adb push "D:/media/my " & echo CMD-INJECTION-WORKED & " video.mp4" ...
实际输出 :
  adb push "D:/media/my "
  CMD-INJECTION-WORKED                                  <- 注入的命令被执行
  '" video.mp4"' is not recognized as an internal...
  CMD-INJECTION-WORKED                                  <- 第二次也执行
```

注意这个文件名**本身完全无恶意**，只是视频起名带引号而已。
后果却是在持有全部设备、全部账号、autojs 授权的那台 Windows 主机上执行任意命令。

---

## 2. 为什么放在 remote 这一层

- **不改 autojs-controller**：它的 `server.js`、`scripts/`、`scripts_renderer/` 全部保持原样
- **改在信任边界上**：autojs 被当作「不可信的单租户后端」，我们这层才是关卡
- **结构上没有旁路**：所有写操作都必须经过 `AutojsClient`，而客户端内部先过校验层；
  不存在「忘了调校验」的调用方式

> ⚠️ **前提**：这一层只有在它是唯一入口时才算边界。
> autojs 的 `app.listen(PORT)` 未指定 host，实际绑定 **0.0.0.0**。
> 若 5000 端口能被外部直接访问，即可绕过本校验层。建议加防火墙规则限制为本机访问。

---

## 3. 校验规则

实现于 `agent/src/autojs/autojs-validation.ts`（纯函数）。

### 3.1 `send_time` —— 白名单格式

```
^(YYYY)-(MM)-(DD)[ T](HH):(MM)(:SS)?$
```

除了正则，还逐项检查范围并校验日期真实存在（拒绝 `2026-13-01`、`2026-02-30`、`25:00`）。
**只校验，不做格式转换**——autojs 按 `YYYY-MM-DD HH:MM:SS` 解析，擅自把 `T` 换成空格可能改变行为，故原样透传。

### 3.2 `config` —— 键名白名单 + 值类型收紧

| 类别 | 键 | 约束 |
|---|---|---|
| 数值（11 个） | `SWIPE_COUNT` `SWIPE_COUNT_MIN` `SWIPE_COUNT_MAX` `PLAY_DURATION` `LIKE_PROBABILITY` `FOLLOW_PROBABILITY` `COMMENT_PROBABILITY` `FAVORITE_PROBABILITY` `SEARCH_PROBABILITY` `WAIT_AFTER_SEARCH` `LIVE_WATCH_DURATION` | 必须是**有限整数**，且在各自合理区间内（如概率 0~100） |
| 列表（4 个） | `SEARCH_KEYWORDS` `TALK_CONTENT` `TARGET_ACCOUNTS` `LIVE_CHAT_CONTENT` | 字符串数组，单条 ≤100 字符，最多 50 项 |
| 其他 | — | **一律拒绝** |

### 3.3 视频文件名 —— 自动规范化（用户无感）

| 步骤 | 处理 |
|---|---|
| 1 | 只取 basename，切断 `../../` 路径穿越 |
| 2 | 扩展名白名单：`.mp4` / `.mov` / `.m4v` |
| 3 | 字符白名单：保留 Unicode 字母/数字与 `.` `_` `-`，其余替换为 `_` |
| 4 | 压缩连续下划线、去掉首尾 `._-` |
| 5 | 按码点截断到 80 字符（为扩展名留位，不会切断代理对） |

**保留 Unicode 是有意为之**：若把所有非 ASCII 压成下划线，`我的视频.mp4` 会退化成
`video.mp4`，多个中文视频在同一账号下会得到相同远程路径而互相覆盖。

### 3.4 `device_ids` —— 子集校验（配额的关键）

必须 `⊆ 调用方被分配的设备集合`。
否则用户可以把别人的 serial 填进 `device_ids`，「配额」就只是 UI 上的一个数字。

### 3.5 `video_paths` —— 一致性断言

要求是 Windows 绝对路径，且 basename **已经等于**规范化结果。
这里刻意选择「拒绝」而非「自动改名」：磁盘上的真实文件名必须与传给 autojs 的路径一致，
静默改名会导致 `adb push` 找不到文件。

---

## 4. 实测结果

### 4.1 单元测试（29/29 通过）

```
--- send_time ---
PASS normal 2026-09-10 20:30            -> OK     "2026-09-10 20:30"
PASS T form 2026-09-10T20:30            -> OK     "2026-09-10T20:30"
PASS empty allowed                      -> OK     ""
PASS INJECTION attempt                  -> REJECT 格式不合法
PASS bad month 2026-13-01               -> REJECT 月份不合法
PASS non-existent 2026-02-30            -> REJECT 不是一个真实存在的日期
PASS bad hour 25                        -> REJECT 小时不合法

--- filename ---
PASS plain video1.mp4                   -> OK     "video1.mp4"
PASS Chinese name                       -> OK     "我的视频.mp4"
PASS with quotes                        -> OK     "my_best_video.mp4"
PASS CMD INJECTION attempt              -> OK     "x_echo_PWNED.mp4"
PASS path traversal                     -> OK     "passwd.mp4"
PASS bad extension .exe                 -> REJECT 仅支持 .mp4 / .mov / .m4v
PASS empty                              -> REJECT 文件名不能为空

--- device_ids ---
PASS valid subset                       -> OK     ["a:1"]
PASS UNAUTHORIZED device                -> REJECT 无权操作以下设备：c:3
PASS mixed valid + unauthorized         -> REJECT 无权操作以下设备：c:3
PASS empty array                        -> REJECT device_ids 不能为空

--- dayil config ---
PASS valid numbers                      -> OK     {"SWIPE_COUNT":30,"PLAY_DURATION":5000}
PASS CODE INJECTION attempt             -> REJECT 必须是数字
PASS unknown key                        -> REJECT 不支持的配置项：HACK
PASS out of range 200                   -> REJECT 超出允许范围 0 ~ 100
PASS valid list                         -> OK     {"SEARCH_KEYWORDS":["a","b"]}
PASS list as string                     -> REJECT 必须是数组

--- video_paths ---
PASS normalized abs path                -> OK     ["D:\\media\\v1\\video1.mp4"]
PASS unnormalized name                  -> REJECT 文件名未经规范化
PASS relative path                      -> REJECT 必须是 Windows 绝对路径
PASS empty                              -> REJECT 不能为空

RESULT: pass=29  fail=0
```

### 4.2 端到端（真实 HTTP 请求）

测试时 **autojs 未运行**（5000 端口无监听）。这一点让结论变得确定：
**凡是返回 400 的，都证明校验发生在 HTTP 调用之前**；
若校验未生效，请求会一路走到网络层并返回 502。

| # | 请求 | 结果 |
|---|---|---|
| 1 | `device_ids: ["10.0.0.99:5555"]` | `400` 无权操作以下设备：10.0.0.99:5555 |
| 2 | `config: { SWIPE_COUNT: "1; evil()" }` | `400` config.SWIPE_COUNT 必须是数字 |
| 3 | `config: { HACK: 1 }` | `400` config 中存在不支持的配置项：HACK |
| 4 | `config: { LIKE_PROBABILITY: 200 }` | `400` 超出允许范围 0 ~ 100 |
| 5 | `send_time: '"; globalThis.pwned=1; //'` | `400` send_time 格式不合法 |
| 6 | `video_paths: ['D:\media\my "best" video.mp4']` | `400` 文件名未经规范化：期望 my_best_video.mp4 |
| 7 | 合法请求 | `502` 无法连接 autojs（未运行） ← 通过校验后才会去连 |

---

## 5. 相关文件

| 文件 | 说明 |
|---|---|
| `agent/src/autojs/autojs-validation.ts` | **新增**。全部校验规则（纯函数，无副作用） |
| `agent/src/autojs/autojs-client.ts` | **新增**。客户端，写操作前强制过校验 |
| `agent/src/autojs/autojs-types.ts` | **新增**。接口类型 |
| `agent/src/config/env.ts` | 新增 `AUTOJS_BASE_URL`（默认 `http://127.0.0.1:5000`）、`AUTOJS_TIMEOUT_MS`（默认 300000，发视频含 push 需给足时间） |
| `agent/src/http/agent-server.ts` | 新增 `/api/autojs/*` 路由；错误码映射到 HTTP 状态 |
| `agent/src/main.ts` | 构造并注入 `AutojsClient` |

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/autojs/health` | 连通性 |
| GET | `/api/autojs/run-status` | 任务状态（**全局视图，转发前须过滤**） |
| GET | `/api/autojs/accounts` | 账号列表（**全局视图，转发前须过滤**） |
| GET | `/api/autojs/devices` | autojs 看到的设备 serial 数组 |
| POST | `/api/autojs/dayil-work/start` | 养号（经校验） |
| POST | `/api/autojs/send-video/start` | 发视频（经校验） |

错误码到 HTTP 的映射：

| `AutojsError.code` | HTTP |
|---|---|
| `validation_failed` | 400 |
| `not_activated` | 403 |
| `timeout` | 504 |
| `unreachable` / `http_error` / `invalid_response` / `task_failed` | 502 |

---

## 6. 与账号系统对接的接入点

配额与隔离的生效点集中在一处：

```ts
AgentServerOptions.resolveAllowedDeviceIds?: () => Promise<string[]> | string[]
```

当前默认返回**本 agent 已知的全部设备**。账号系统就绪后，改为返回
「该登录用户被分配的设备 serial 集合」，则第 3.4 节的子集校验自动生效，
无需改动校验层本身。

同理，`startSendVideo` 的第三个参数 `allowedAccounts` 目前未传，
账号系统就绪后传入即可获得账号级隔离。

---

## 7. 尚未处理

1. **读取接口的过滤** —— `/api/autojs/accounts` 与 `/api/autojs/run-status`
   返回的是 autojs 的全局视图（含他人的账号与任务），
   转发给最终用户前必须按设备集过滤。**尚未实现**。
2. **autojs 端口暴露** —— 见第 2 节末的提醒，建议加防火墙规则。
3. **本条链路目前只在本机可用** —— relay 侧尚未增加 automation 消息转发，
   浏览器还不能直接调用这些接口。
