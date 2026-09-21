# 发视频链路

客户在浏览器里上传的视频，最终要变成设备主机上的一条 `adb push`。
中间隔着三重身份（浏览器 / 服务器 / 设备主机），这条文档说明每一段
为什么这么设计，以及出问题时先看哪里。

## 一句话流程

```
浏览器 ──1.上传──▶ relay（存盘 + 记 sha256）
                      │
                      │◀──2.拉取（Bearer AGENT_SECRET）── agent（设备主机）
                                                        │
                                                   3.本地路径交给 autojs
                                                        │
                                                   4.adb push 到手机
```

分段说明：

1. **上传** —— `POST /api/videos?name=<原始文件名>`，请求体就是文件的裸字节。
   不用 multipart 是为了让服务端**边收边写盘边算 sha256**：几百 MB 的视频
   若先读进内存，服务器会被打爆。
2. **拉取** —— `GET /api/agent/videos/:id`，用 `Authorization: Bearer <AGENT_SECRET>`。
   这个接口**不在账号鉴权体系内**（设备主机没有用户会话），而是靠共享密钥，
   并且路由注册在鉴权闸门之前。没有密钥就是 401，密钥不对也是 401。
3. **落到本地** —— agent 写到 `<MEDIA_DIR>/<videoId>/<safeName>`。
   目录用 videoId 保证唯一；**文件名必须保持 relay 给的名字**，
   因为 autojs 从 `video_paths` 的 basename 推导视频名并写进脚本。
4. **下发** —— agent 把本地绝对路径填进 `video_paths`，调用 autojs 的
   `/api/automation/send-video/start`。下载后校验 sha256，不一致直接丢弃，
   避免把半截文件推上手机。

## 两道必须一起改的地方

### 文件名规范化

`sanitizeVideoFilename` 存在**两份**：

- `relay/src/videos/store.ts` —— 决定磁盘上的文件名，并把它告诉 agent
- `agent/src/autojs/autojs-validation.ts` —— 纵深防御，断言 basename 已是规范形式

规则一旦分叉，agent 会以「文件名未经规范化」为由拒掉**所有**下发，
而这个报错完全指不到真正的病因。因此有一项专门的测试逐例比对两边：

```
relay/dev/video-pipeline-test.mjs  →  「两侧规范化结果完全一致」
```

改任何一边都必须跑它。

### 同名视频

autojs 用 **basename** 当视频标识。两个不同文件如果规范化后同名
（例如 `我的 视频.mp4` 与 `我的#视频.mp4` 都变成 `我的_视频.mp4`），
在手机上会退化成同一个视频，任务结果与预期不符且极难排查。

relay 在转发前直接拒绝这种组合（`checkVideoOwnership` 里的同名检查），
错误信息里带上冲突的文件名。

## 安全边界

| 风险 | 位置 | 处理 |
| --- | --- | --- |
| 调用方指定主机本地路径 | relay `router.ts` | `send-video.start` 的 payload 里 `video_paths` **一律删除**，只认 `video_ids`。否则任何租户都能把主机上的任意文件推到手机上 |
| 用别人的视频素材 | relay `router.ts` | 逐个查 `videos.user_id` 是否属于发起者（管理员除外），并写审计 |
| 猜测 / 遍历 videoId | relay `router.ts` | `video_ids` 必须匹配 `^[a-f0-9]{32}$`；不存在的 id 与不属于自己的 id 返回同一句错误，不泄露存在性 |
| 用别人设备上的账号 | agent `relay-client.ts` | 下发前取回 autojs 的账号表，只放行「属于本次允许设备」与「没有归属设备」的账号，交给校验层拒绝（`无权操作以下账号`）。**多租户共用一台主机**，没有这道检查时手工构造一条 WS 消息就能指定别人的账号 |
| 文件名注入 cmd.exe | relay + agent | 字符白名单只保留 Unicode 字母/数字与 `._-`，`"` `&` `|` 反引号全被替换 |
| 路径穿越 | relay + agent | 只取 basename；agent 落盘前再挡一次 `/` `\` 与前导 `.` |
| 磁盘被写满 | relay `http.ts` | 单文件上限 `VIDEO_MAX_BYTES`（默认 512MB）+ 按 `maxStorageBytes` 配额，两处都查（content-length 先挡，写完按真实大小再挡） |
| 传输损坏 | agent `video-download.ts` | 下载后校验 sha256，不一致就删掉临时目录并报错 |
| 同名视频互相覆盖 | relay `router.ts` | 同一批 `video_ids` 里出现同名 `safe_name` 直接拒绝（autojs 用 basename 当视频标识） |

## 环境变量

relay：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `RELAY_MEDIA_DIR` | `data/videos` | 视频落盘根目录 |
| `VIDEO_MAX_BYTES` | `536870912`（512MB） | 单文件上限，需与 nginx 的 `client_max_body_size` 对齐 |
| `AGENT_SECRET` | 无 | 缺省时下载接口返回 503，视频链路不可用 |

agent（设备主机）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_SECRET` | 无 | **必须与 relay 一致**，否则下载全部 401 |
| `MEDIA_DIR` | `%TEMP%\remote-phone-media` | 视频本地暂存目录，需有足够磁盘空间 |
| `RELAY_SERVER_WS_URL` | 无 | 由它推导 HTTP 基址（`ws://` → `http://`，`wss://` → `https://`） |

agent 启动日志会打印 `video download: <base> / secret configured|MISSING`，
这是排查「为什么视频发不出去」的第一现场。

## 部署

1. nginx：`client_max_body_size 512m` + `proxy_request_buffering off`
   （见 `deploy/nginx.conf.example`）。关掉请求缓冲后字节直接透传给 relay，
   不会为一个大视频写两遍磁盘。
2. relay 与 agent 设置**同一个** `AGENT_SECRET`。
3. 确认服务器磁盘余量：每个视频都会在服务器留一份，
   在设备主机再留一份（`MEDIA_DIR`）。视频目前**不做自动清理**。
4. 给客户开 `can_upload_video` 与 `can_send_video` 两项能力，
   并按需要设置 `maxStorageBytes`（0 表示不限）。

## 测试

agent 侧分两段，都不需要 relay、手机或 autojs；relay 侧需要 relay 在跑。

### agent：下载、校验、清理（19 项断言）

```
cd agent
npm run test:video-download
```

用一个本地 HTTP 服务冒充 relay，覆盖：参数守卫（缺密钥 / id 格式）、
正常下载的落盘路径与 Bearer 头、**sha256 不一致时必须删掉半截文件**、
缺 `X-Video-Name`、文件名含路径穿越、服务端 401/404 的原因透传、
暂存目录清理。

### agent：下发逻辑（24 项断言）

```
cd agent
npm run test:send-video
```

用假 relay（HTTP + WS）和假 autojs 把 `RelayClient` 围起来，
断言的对象是**假 autojs 真正收到的请求体**，而不是 agent 的返回值——
「函数返回成功」和「干净的请求发出去了」是两件不同的事。

覆盖：`video_ids` → 下载 → `video_paths` 换成本机真实路径、
调用方自带的 `video_paths` 被忽略、账号被限制在允许设备内且被拒请求
不会发出、无归属设备的账号不误伤、assignments 引用未下发视频时提前拒绝、
`stop()` 之后不再重连。

> 这个测试跑在 `tsx` 上而不是 `node`：agent 源码里有 8 处 TypeScript
> **参数属性**，Node 的类型擦除模式会直接报
> `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。tsx 本来就是 agent 的运行器
> （`npm run dev` 也是它），所以跟齐即可。

### relay：完整链路（49 项断言）

```
# 另开窗口启动 relay（console 邮件模式，验证码会回显）
cd relay
$env:RELAY_DB_FILE='..\.tmp-test\relay-test.db'
$env:RELAY_MEDIA_DIR='..\.tmp-test\videos'
$env:RELAY_PORT='5091'; $env:ADMIN_PASSWORD='test-admin-pw-123'
$env:AGENT_SECRET='test-agent-secret'; $env:MAIL_TRANSPORT='console'
$env:LOGIN_MAX_ATTEMPTS='1000'; $env:REGISTER_MAX_ATTEMPTS='1000'
node --import ./dev/register.mjs src/main.ts

# 跑测试
$env:TEST_BASE='http://127.0.0.1:5091'
$env:TEST_ADMIN_PASSWORD='test-admin-pw-123'
$env:TEST_AGENT_SECRET='test-agent-secret'
node --import ./dev/register.mjs dev/video-pipeline-test.mjs
```

覆盖：两侧规范化一致性、上传能力开关、输入校验、agent 下载通道的
密钥校验与 sha256、素材归属、`video_paths` 剥离、同名视频拦截、
存储配额、删除。

需要 `--import ./dev/register.mjs` 是因为测试要**直接导入两侧的 .ts 源码**
来做逐例比对。

### 前端：同源反代（15 项断言）

```
# 另开窗口
node scripts/dev-web-test.mjs          # 静态页 :8090 + relay :5091 + 假 agent
# 本窗口
node scripts/dev-web-acceptance.mjs
```

`dev-web-test.mjs` 把 `/api` 与 `/ws` 反代到 relay，前端与 relay 同源 ——
与生产的 nginx 部署同构，所以这一轮跑通基本等于「浏览器里点得通」。
`dev-web-acceptance.mjs` 只对 8090 这一个源发请求，路径与浏览器完全一致。

它刻意往 `send-video.start` 里塞 `video_paths: ["C:\\Windows\\win.ini"]`：
接口层面看不出差别，只有检查**服务端实际收到的字节**才能确认剥离生效。
浏览器里手点一遍时，这类问题会漏过去。

## 生命周期与清理

| 事件 | 服务器副本 | 设备主机副本 | 数据库记录 |
|---|---|---|---|
| 客户上传 | 写入 `<RELAY_MEDIA_DIR>/<videoId>/` | — | 新增一行 |
| 设备主机拉取 | — | 写入 `<MEDIA_DIR>/<videoId>/` | — |
| **下发成功** | — | **自动删除**（见下） | — |
| 下发失败 | — | **保留**（便于排查） | — |
| 客户删除素材 | **目录删除** | — | 行删除 |
| **删除客户账号** | **目录删除** | — | 行级联删除 |

> ⚠️ **删账号必须连文件一起删。** `videos.user_id` 是 `ON DELETE CASCADE`，
> 所以 `DELETE FROM users` 会把素材记录清干净 —— 但**数据库不会连带删磁盘文件**。
> 只删记录不删文件会留下一个查不回来的泄漏：行没了就再也查不出「该删哪些目录」。
> 所以 `handleAdminDeleteUser` 的顺序是**先收集 videoId → 删账号 → 再删文件**，
> 并把清理数量写进审计（`removedVideos`）。
>
> 单个文件删不掉不会让请求失败（账号已经删了），只记日志与审计 ——
> 孤儿文件还能靠扫盘回收，而库里留下指向已删账号的行会让配额统计出错。

### 设备主机副本：成功即删

`downloadVideo` **每次都重新下载**（没有「文件已存在就跳过」的判断），
所以本地副本**没有任何复用价值** —— 留着只会让 `<MEDIA_DIR>` 按 videoId
无限增长，一台主机上会堆着所有客户发过的素材。

因此 `RelayClient.runSendVideo` 在**下发成功后**调用 `removeDownloadedVideo`
把副本删掉；**失败时保留**，便于对着文件排查（反正下次也会重新下载）。

### 清理工具

| 场景 | 命令 |
|---|---|
| 服务器：孤儿目录（历史遗留的删账号残留） | `bash deploy/relay-data.sh clean`（预演）→ `clean --yes` |
| 设备主机：历史累积的副本 | `.\scripts\clean-agent-media.ps1 -Apply` |

两个都**默认只报告不删**。安全设计：

- 服务器侧：查不到 `videos` 表就**中止**，绝不把「查询失败」当成「全是孤儿」
- 主机侧：只处理**目录名是 32 位小写十六进制**（videoId 格式）的子目录，
  所以即使 `MEDIA_DIR` 被误设成 `D:\`，也不会误删无关目录

## 已知限制

- **不做断点续传**：网络中断后整个视频重新下载。
- **重复下发会重新下载**：agent 侧没有「文件已存在就跳过」的判断，
  每次下发都会重新走一遍 HTTP 传输并覆盖同名文件（成功后再删掉）。
  同一个视频下发 5 次就是下载 5 次。若嫌慢可以加 `stat` 比对后复用，
  但那要先去掉「成功即删」——两者是同一个取舍的两面。
- **不做转码**：格式、编码、分辨率完全按客户上传的原样推到手机，
  由 autojs 与 TikTok 自己处理。
- **串行下载**：一次任务里的多个视频逐个下载，避免把带宽打满，
  代价是首个视频的下发延迟更长。
- **多租户共用同一个 `MEDIA_DIR`**：所有客户的素材都堆在那台主机的同一个
  目录下，靠 videoId 区分。客户读不到主机的磁盘，所以不是对客户的泄漏，
  但意味着那台机器的磁盘上混着全部客户的素材。
- **账号过滤在拿不到账号表时会放行**：`resolveAllowedAccounts` 取不到
  autojs 的账号列表时只打警告、不拦请求（否则一个只读接口抖动就会让
  所有客户发不出视频）。日志里会明确写出「本次不施加账号过滤」。
