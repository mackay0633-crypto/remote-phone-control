/**
 * agent 侧「发视频」下发逻辑测试。
 *
 * 这一段是整个链路里**唯一同时接触不可信输入和真实文件名**的地方，
 * 但它既不需要手机也不需要真 autojs —— 所以用两个假服务把它围起来测：
 *
 *   - 假 relay（HTTP）：提供视频下载，也就是 `GET /api/agent/videos/:id`
 *   - 假 relay（WS）  ：扮演 relay 的 agent 通道，把 automation 请求喂进来
 *   - 假 autojs（HTTP）：记录 agent 最终**真正发给 autojs 的请求体**
 *
 * 关键是最后那点：断言的对象不是 agent 的返回值，而是 autojs 收到的字节。
 * 这正是容易被糊弄过去的地方 —— 「函数返回成功」和「干净的请求发出去了」
 * 是两件不同的事。
 *
 * 覆盖：
 *
 *   1. `video_ids` → 下载 → `video_paths` 换成**本机真实路径**
 *   2. 调用方自带的 `video_paths` 被忽略（否则可推主机上任意文件到手机）
 *   3. 账号被限制在「本次允许设备」范围内，且**不会**发出被拒的请求
 *   4. 没有归属设备的账号不误伤
 *   5. assignments 引用未下发的视频时提前拒绝
 *
 * 运行（不需要任何环境变量）：
 *   cd agent
 *   npx tsx dev/send-video-dispatch-test.mjs
 *
 * 用 tsx 而不是 `node`：agent 的源码里用了 TypeScript 的**参数属性**
 * （`constructor(private readonly options: ...)`，共 8 处），
 * 而 Node 的类型擦除模式（--experimental-strip-types）只能删类型、
 * 不能生成 `this.options = options` 赋值，会直接报
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。tsx 是 agent 自己的运行器
 * （`npm run dev` 也是它），所以这里跟齐。
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

import { AutojsClient } from "../src/autojs/autojs-client.ts";
import { RelayClient } from "../src/relay/relay-client.ts";

const AGENT_SECRET = "dispatch-test-secret";
const VIDEO_ID = "b".repeat(32);
const SAFE_NAME = "派发_测试.mp4";
const VIDEO_BODY = Buffer.from("dispatch-test-video-".repeat(128), "utf8");
const VIDEO_SHA = createHash("sha256").update(VIDEO_BODY).digest("hex");

// 与 relay 侧测试一致的测试网段
const SERIAL_MINE = "10.99.2.1:65535";
const SERIAL_THEIRS = "10.99.2.2:65535";

let pass = 0;
let fail = 0;

function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`);
  }
}

/** 假 relay 的 HTTP 部分：视频下载 */
function startVideoServer() {
  return new Promise((resolveServer) => {
    const seen = [];
    const server = createServer((req, res) => {
      res.setHeader("Connection", "close");
      seen.push({ url: req.url, authorization: req.headers.authorization ?? null });

      if (!req.url?.startsWith(`/api/agent/videos/${VIDEO_ID}`)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "视频不存在" }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(VIDEO_BODY.length),
        "X-Video-Name": encodeURIComponent(SAFE_NAME),
        "X-Video-Sha256": VIDEO_SHA
      });
      res.end(VIDEO_BODY);
    });

    server.listen(0, "127.0.0.1", () => resolveServer({ server, seen, port: server.address().port }));
  });
}

/** 假 autojs：账号表 + 记录真正收到的发视频请求 */
function startAutojsServer() {
  return new Promise((resolveServer) => {
    const received = [];
    const server = createServer((req, res) => {
      res.setHeader("Connection", "close");
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const url = req.url ?? "";

        if (req.method === "GET" && url === "/api/accounts") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify([
              { id: 1, username: "acc_mine", device_id: SERIAL_MINE },
              { id: 2, username: "acc_theirs", device_id: SERIAL_THEIRS },
              { id: 3, username: "acc_nodevice", device_id: null }
            ])
          );
          return;
        }

        if (req.method === "POST" && url === "/api/automation/send-video/start") {
          received.push(JSON.parse(body || "{}"));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, script_run_id: "sv_dispatch_test", script_type: "sendvedio_precise" }));
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `未实现的接口 ${req.method} ${url}` }));
      });
    });

    server.listen(0, "127.0.0.1", () => resolveServer({ server, received, port: server.address().port }));
  });
}

/** 假 relay 的 WS 部分：扮演 agent 通道，把 automation 请求发进 RelayClient */
function startControlServer() {
  return new Promise((resolveServer) => {
    const results = [];
    let connections = 0;
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });

    wss.on("connection", (socket) => {
      connections += 1;

      socket.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (msg.type === "automation-result") {
          results.push(msg);
        }
      });
    });

    wss.on("listening", () => {
      const { port } = wss.address();

      resolveServer({
        wss,
        results,
        port,
        connectionCount: () => connections,
        /** 发一条 automation 请求并等它的回执 */
        send: (action, payload, allowedDeviceIds) =>
          new Promise((resolve, reject) => {
            const requestId = `dispatch-${results.length + 1}-${Date.now().toString(36)}`;
            let poll;

            const finish = (fn) => {
              clearInterval(poll);
              clearTimeout(timer);
              fn();
            };

            const timer = setTimeout(
              () => finish(() => reject(new Error("等待 automation-result 超时"))),
              15000
            );

            poll = setInterval(() => {
              const found = results.find((item) => item.requestId === requestId);
              if (found) {
                finish(() => resolve(found));
              }
            }, 20);

            const socket = [...wss.clients][0];
            socket.send(
              JSON.stringify({ type: "automation", requestId, action, payload, allowedDeviceIds })
            );
          })
      });
    });
  });
}

async function main() {
  const mediaDir = await mkdtemp(join(tmpdir(), "agent-dispatch-test-"));

  const video = await startVideoServer();
  const autojs = await startAutojsServer();
  const control = await startControlServer();

  const autojsClient = new AutojsClient({
    baseUrl: `http://127.0.0.1:${autojs.port}`,
    timeoutMs: 10_000
  });

  const relayClient = new RelayClient({
    relayServerWsUrl: `ws://127.0.0.1:${control.port}`,
    agentId: "agent-dispatch-test",
    // 只用得到一个订阅入口，测试里不需要设备变化通知
    deviceTracker: {
      subscribe: () => () => {},
      getDevices: () => [],
      getDevice: () => undefined
    },
    inputManager: { execute: async () => {} },
    adbPath: "adb",
    streamMaxSize: 720,
    streamBitRate: 2_000_000,
    autojsClient,
    videoDownload: {
      relayHttpBaseUrl: `http://127.0.0.1:${video.port}`,
      agentSecret: AGENT_SECRET,
      mediaDir
    }
  });

  relayClient.start();
  // 等 WS 建起来
  for (let i = 0; i < 100 && control.wss.clients.size === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  chk("agent 连上了假 relay", control.wss.clients.size, 1);

  const allowed = [SERIAL_MINE];

  console.log("--- 1. 正常下发：video_ids → 本地路径 ---");

  const ok = await control.send(
    "send-video.start",
    {
      type: "precise",
      accounts: ["acc_mine"],
      device_ids: [SERIAL_MINE],
      video_ids: [VIDEO_ID],
      // 调用方注入：必须被忽略
      video_paths: ["C:\\Windows\\System32\\config\\SAM"],
      send_time: "2026-01-02 03:04",
      titles: ["标题一"]
    },
    allowed
  );

  chk("下发成功", ok.ok, true);
  chk("autojs 收到了一次发视频请求", autojs.received.length, 1);

  const body = autojs.received[0] ?? {};
  const expectedPath = join(mediaDir, VIDEO_ID, SAFE_NAME);

  chk("video_paths 被换成本机真实路径", body.video_paths, [expectedPath]);
  chk("下载的文件确实存在", (await stat(expectedPath)).isFile(), true);
  chk("下载请求带上了密钥", video.seen[0]?.authorization, `Bearer ${AGENT_SECRET}`);
  chk("video_ids 没有透传给 autojs", "video_ids" in body, false);
  chk("send_time 透传", body.send_time, "2026-01-02 03:04");
  chk("titles 透传", body.titles, ["标题一"]);
  chk("type 透传", body.type, "precise");

  console.log("--- 2. 账号被限制在允许设备内 ---");

  const postsBefore = autojs.received.length;
  const stolen = await control.send(
    "send-video.start",
    {
      type: "precise",
      // 别人的设备上的账号
      accounts: ["acc_theirs"],
      device_ids: [SERIAL_MINE],
      video_ids: [VIDEO_ID]
    },
    allowed
  );

  chk("越权账号被拒", stolen.ok, false);
  chk("提示无权操作账号", /无权操作以下账号/.test(stolen.error ?? ""), true);
  chk("被拒的请求**没有**发给 autojs", autojs.received.length, postsBefore);

  console.log("--- 3. 无归属设备的账号不被误伤 ---");

  const nodevice = await control.send(
    "send-video.start",
    {
      type: "precise",
      accounts: ["acc_nodevice"],
      device_ids: [SERIAL_MINE],
      video_ids: [VIDEO_ID]
    },
    allowed
  );

  chk("没有 device_id 的账号可以下发", nodevice.ok, true);
  chk("autojs 收到了这一条", autojs.received.at(-1)?.accounts, ["acc_nodevice"]);

  console.log("--- 4. assignments 引用未下发的视频 ---");

  const postsBeforeBad = autojs.received.length;
  const badAssignment = await control.send(
    "send-video.start",
    {
      type: "batch",
      accounts: ["acc_mine"],
      device_ids: [SERIAL_MINE],
      video_ids: [VIDEO_ID],
      assignments: [{ account: "acc_mine", video: "从未上传过.mp4" }]
    },
    allowed
  );

  chk("引用未下发的视频被拒", badAssignment.ok, false);
  chk("错误信息指向 assignments", /assignments/.test(badAssignment.error ?? ""), true);
  chk("被拒的请求没有发给 autojs", autojs.received.length, postsBeforeBad);

  console.log("--- 5. 空 video_ids ---");

  const postsBeforeEmpty = autojs.received.length;
  const empty = await control.send(
    "send-video.start",
    { type: "precise", accounts: ["acc_mine"], device_ids: [SERIAL_MINE] },
    allowed
  );

  chk("空 video_ids 被拒", empty.ok, false);
  chk("被拒的空请求没有发给 autojs", autojs.received.length, postsBeforeEmpty);

  console.log("--- 6. 设备不在允许集合内 ---");

  const postsBeforeScope = autojs.received.length;
  const outOfScope = await control.send(
    "send-video.start",
    { type: "precise", accounts: ["acc_mine"], device_ids: [SERIAL_THEIRS], video_ids: [VIDEO_ID] },
    allowed
  );

  chk("越权设备被拒（纵深防御）", outOfScope.ok, false);
  chk("被拒的越权设备请求没有发给 autojs", autojs.received.length, postsBeforeScope);

  console.log("--- 7. stop() 之后必须停止重连 ---");

  const connectionsBeforeStop = control.connectionCount();
  relayClient.stop();
  // 重连间隔是 1500ms；等够两轮，确认没有新连接冒出来。
  // 不修 stopped 标志的话这里会看到连接数持续增长，进程也永远不退出。
  await new Promise((r) => setTimeout(r, 2000));
  chk("stop() 之后没有新连接", control.connectionCount(), connectionsBeforeStop);
  chk("socket 已断开", control.wss.clients.size, 0);

  control.wss.close();
  await new Promise((done) => video.server.close(done));
  await new Promise((done) => autojs.server.close(done));
  await rm(mediaDir, { recursive: true, force: true });

  console.log(`\n=========== pass=${pass}  fail=${fail} ===========`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
