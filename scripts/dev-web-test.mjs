/**
 * 前端本地验收环境（无需真实手机）。
 *
 * 一条命令起三样东西：
 *   1. 静态服务：把 web/dist 提供在 http://127.0.0.1:8090
 *      **并把 /api 与 /ws 反代到 relay**，所以前端与 relay 同源
 *   2. relay：跑在 http://127.0.0.1:5091（console 邮件模式，验证码自动回显）
 *   3. 假 Agent：连上 relay 并上报几台虚拟设备，让控制台/管理页有内容可点
 *
 * 用**普通的生产构建**即可，不需要任何构建时变量：
 *
 *   npm run build --workspace web
 *
 * 为什么能做到这点：`web/src/api/client.ts` 按**页面来源**判断中继地址。
 * 本脚本把 /api 和 /ws 反代到 relay，前端看到的就都是 8090 这一个源，
 * 与生产（nginx 同源反代）完全一致。
 *
 * 早先的做法是让前端直连 5091，那就成了跨源，必须用
 * `VITE_RELAY_WS_BASE_URL` 把地址**烤进产物** —— 结果是 `web/dist`
 * 变成「只在本地测试能用」的东西。一旦误传到服务器，
 * 客户浏览器会去连自己的 127.0.0.1，整个前端直接废掉。
 * 反代之后这个隐患从结构上消失了。
 *
 * 用法：node scripts/dev-web-test.mjs        （Ctrl+C 结束，会一并关掉 relay）
 */

import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import WebSocket from "ws";

const RELAY_PORT = Number(process.env.TEST_RELAY_PORT ?? "5091");
const WEB_PORT = Number(process.env.TEST_WEB_PORT ?? "8090");
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? "DevTest123456";
/** 本地验收用的固定密钥，与真实部署无关（生产必须各自随机生成） */
const AGENT_SECRET = process.env.TEST_AGENT_SECRET ?? "devtest-agent-secret";

/** 测试专用网段，和真实设备无关 */
const DEVICES = [
  { serial: "10.99.0.11:5555", model: "SM-N950U", androidVersion: "9" },
  { serial: "10.99.0.12:5555", model: "Pixel 5", androidVersion: "11" },
  { serial: "10.99.0.13:5555", model: "MI 9", androidVersion: "10" },
  { serial: "10.99.0.14:5555", model: "Redmi K30", androidVersion: "10" }
];

const repoRoot = resolve(import.meta.dirname, "..");
const distDir = join(repoRoot, "web", "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. 静态服务 + 同源反代 ────────────────────────────────────
/**
 * 静态文件服务在 8090，同时把 /api 与 /ws 反代到 relay（5091）。
 *
 * 这样前端与 relay 同源，与生产（nginx 同源反代）一致，
 * 因此不需要任何构建时变量，普通生产构建直接可用。
 */
function startStaticServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${WEB_PORT}`);

    // 账号 / 管理 API 转给 relay
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      proxyHttpToRelay(req, res);
      return;
    }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") {
      pathname = "/index.html";
    }

    // 防目录穿越
    const target = normalize(join(distDir, pathname));
    if (!target.startsWith(distDir)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    try {
      const body = await readFile(target);
      res.writeHead(200, {
        "Content-Type": MIME[extname(target)] ?? "application/octet-stream",
        "Cache-Control": "no-store"
      });
      res.end(body);
    } catch {
      // SPA 回退：未知路径交给前端路由
      try {
        const fallback = await readFile(join(distDir, "index.html"));
        res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
        res.end(fallback);
      } catch {
        res.writeHead(404).end("not found");
      }
    }
  });

  /**
   * WebSocket 升级：在 TCP 层直接打通到 relay。
   *
   * 不去解析 / 重建 WebSocket 握手，只是把升级请求原样转发、再把两个
   * socket 对接起来 —— 覆盖 /ws/viewer（控制）、/ws/viewer/stream（视频流）
   * 以及将来可能新增的 WS 端点，都不需要改这里。
   */
  server.on("upgrade", (req, socket, head) => {
    const upstream = connect(RELAY_PORT, "127.0.0.1", () => {
      const headerLines = Object.entries(req.headers)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
        .join("\r\n");

      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
      if (head && head.length > 0) {
        upstream.write(head);
      }

      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  return new Promise((ok) => server.listen(WEB_PORT, "127.0.0.1", () => ok(server)));
}

/** 把 HTTP 请求原样转给 relay，响应流式回写。 */
function proxyHttpToRelay(req, res) {
  const upstream = request(
    {
      host: "127.0.0.1",
      port: RELAY_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${RELAY_PORT}` }
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );

  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ error: "relay 未就绪" }));
  });

  req.pipe(upstream);
}

// ── 2. relay（子进程）────────────────────────────────────────
function startRelay() {
  const child = spawn(
    process.execPath,
    ["--import", "./dev/register.mjs", "src/main.ts"],
    {
      cwd: join(repoRoot, "relay"),
      stdio: "inherit",
      env: {
        ...process.env,
        RELAY_HOST: "127.0.0.1",
        RELAY_PORT: String(RELAY_PORT),
        // 库放在已被 gitignore 的 data-test 下，重启后测试账号还在，方便反复验收
        RELAY_DB_FILE: "data-test/ui-test.db",
        ADMIN_PASSWORD,
        // 视频下载通道的共享密钥。假 agent 不会真的去下载，
        // 但设上之后 `/api/agent/videos/:id` 才是可用的，
        // 便于手工 curl 验证「服务器确实存下了客户上传的文件」。
        AGENT_SECRET,
        // console 模式：验证码会回显到接口，前端会自动填入，省得真发邮件
        MAIL_TRANSPORT: "console",
        // 验收时会反复注册/登录，放宽限流
        LOGIN_MAX_ATTEMPTS: "1000",
        REGISTER_MAX_ATTEMPTS: "1000",
        REGCODE_MAX_ATTEMPTS: "1000",
        RESET_MAX_ATTEMPTS: "1000",
        // 刻意**不设** NODE_ENV=production：那样 devCode 才不会回显
        NODE_ENV: ""
      }
    }
  );

  return child;
}

async function waitForRelay() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${RELAY_PORT}/health`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  return false;
}

// ── 3. 假 Agent ──────────────────────────────────────────────
function startFakeAgent() {
  const socket = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws/agent`);

  const payload = () =>
    JSON.stringify({
      type: "devices",
      devices: DEVICES.map((device) => ({
        serial: device.serial,
        status: "online",
        model: device.model,
        androidVersion: device.androidVersion,
        width: 1080,
        height: 2220,
        streamStatus: "idle",
        controlStatus: "ready",
        transport: "tcp"
      }))
    });

  socket.on("open", () => {
    socket.send(JSON.stringify({ type: "register-agent", agentId: "fake-agent-ui-test" }));
    socket.send(payload());
    console.log(`[fake-agent] 已上报 ${DEVICES.length} 台虚拟设备`);
  });

  // 周期性重报，避免被判定为离线
  const timer = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload());
    }
  }, 20_000);

  /**
   * 响应 relay 转来的指令。
   *
   * 不做真事，但必须**有回应**，否则前端会一直卡在「正在连接」：
   *   - start-stream 不回 stream-ready，视频面板永远到不了 LIVE
   *   - input 打印出来，方便点击时确认指令真的从前端走到了这一层
   */
  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    /**
     * 模拟 autojs 的自动化接口。
     *
     * 不接真 autojs，只回一个成功形状的响应，
     * 让「自动化」页面能走完整流程（选设备 → 下发 → 看结果）。
     * 真正下发前会打印出来，方便确认参数确实传到了这一层。
     */
    if (msg.type === "automation") {
      const reply = (ok, data, error, code) =>
        socket.send(
          JSON.stringify({ type: "automation-result", requestId: msg.requestId, ok, data, error, code })
        );

      const deviceIds = msg.payload?.device_ids ?? [];

      switch (msg.action) {
        case "health":
          reply(true, { ok: true, port: 5000 });
          return;

        case "run-status":
          reply(true, {
            success: true,
            active: false,
            taskCount: 0,
            runCount: 0,
            deviceCount: 0,
            entries: []
          });
          return;

        case "accounts":
          // 给每台假设备配一个账号，否则「发视频」页面的账号下拉永远是空的，
          // 本地根本走不完流程。device_id 必须与上报的设备 serial 一致，
          // relay 会据此把账号裁给对应租户。
          reply(
            true,
            DEVICES.map((device, index) => ({
              id: index + 1,
              username: `acc_dev_${index + 1}`,
              device_id: device.serial,
              status: "online"
            }))
          );
          return;

        case "dayil-work.start":
          console.log(`[fake-agent] 养号下发 → ${deviceIds.length} 台: ${deviceIds.join(", ")}`);
          reply(true, {
            success: true,
            message: "养号脚本生成成功（假响应）",
            script_path: "D:\\fake\\DayilWork_run_devtest.js",
            script_run_id: "dayil_work_devtest",
            script_type: "dayil_work"
          });
          return;

        case "send-video.start": {
          // 真实 agent 会先用 video_ids 从 relay 下载文件，再把本地路径
          // 放进 video_paths。这里只把收到的 payload 打出来，
          // 方便确认 video_ids 到了、而调用方塞的 video_paths 被剥掉了。
          const videoIds = msg.payload?.video_ids ?? [];
          console.log(
            `[fake-agent] 发视频下发 → ${deviceIds.length} 台，${videoIds.length} 个视频（假响应）`
          );
          console.log(`[fake-agent] video_ids=${JSON.stringify(videoIds)}`);
          console.log(
            `[fake-agent] video_paths=${JSON.stringify(msg.payload?.video_paths ?? null)}（应为 null）`
          );

          reply(true, {
            success: true,
            script_run_id: "sendvedio_devtest",
            script_type: msg.payload?.type === "batch" ? "sendvedio_batch" : "sendvedio_precise",
            resolved_videos: videoIds,
            resolved_device_ids: deviceIds
          });
          return;
        }

        default:
          reply(false, undefined, `不支持的动作: ${msg.action}`, "unsupported_action");
      }
      return;
    }

    if (msg.type === "start-stream") {
      socket.send(
        JSON.stringify({ type: "stream-ready", serial: msg.serial, width: 1080, height: 2220 })
      );
      console.log(`[fake-agent] start-stream ${msg.serial} → 已回 stream-ready（无真实画面）`);
      return;
    }

    if (msg.type === "input") {
      const command = msg.command ?? {};
      const detail = command.key ? ` ${command.key}` : command.action === "touch" ? ` ${command.phase}` : "";
      console.log(`[fake-agent] input ${msg.serial} ${command.action}${detail}`);
    }
  });

  socket.on("close", () => clearInterval(timer));
  socket.on("error", (error) => console.error(`[fake-agent] ${error.message}`));

  return { socket, stop: () => { clearInterval(timer); socket.close(); } };
}

// ── 主流程 ───────────────────────────────────────────────────
if (!existsSync(join(distDir, "index.html"))) {
  console.error("找不到 web/dist/index.html。请先构建前端（普通生产构建即可）：");
  console.error("  npm run build --workspace web");
  process.exit(1);
}

const agents = [];
let relay = null;
let staticServer = null;

async function shutdown() {
  console.log("\n正在关闭…");
  agents.forEach((agent) => agent.stop());
  staticServer?.close();
  relay?.kill();
  await sleep(300);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

console.log("启动中…（relay 首次启动会建库，稍等几秒）\n");
staticServer = await startStaticServer();
relay = startRelay();

if (!(await waitForRelay())) {
  console.error("relay 未在预期时间内就绪，请检查上面的输出。");
  await shutdown();
}

agents.push(startFakeAgent());
await sleep(500);

const bar = "─".repeat(64);
console.log(`
┌${bar}
│ 前端地址   http://127.0.0.1:${WEB_PORT}
│ relay      http://127.0.0.1:${RELAY_PORT}
│ 管理员     admin / ${ADMIN_PASSWORD}
│ 虚拟设备   ${DEVICES.length} 台（由假 Agent 上报，没有真实画面）
│ agent 密钥 ${AGENT_SECRET}（假 agent 不会真的下载视频）
│
│ 邮件是 console 模式：验证码会显示在页面上并自动填入，不会真发信
│
│ 验收清单见 docs/web-console.md；自动化验收（另开窗口）：
│   node scripts/dev-web-acceptance.mjs
│ Ctrl+C 结束（会一并关掉 relay）
└${bar}
`);
