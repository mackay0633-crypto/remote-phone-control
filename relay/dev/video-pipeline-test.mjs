/**
 * 发视频链路测试：素材上传 → 服务器存储 → 设备主机下载 → 下发。
 *
 * 覆盖三件容易出错、且出错后果严重的事：
 *
 *   1. **两处文件名规范化必须完全一致**
 *      relay 用它决定磁盘文件名，agent 用它做纵深防御（要求 basename
 *      已经是规范形式）。规则一旦分叉，agent 会以「文件名未经规范化」
 *      为由拒掉**所有**下发——而且报错完全指不到真正的病因。
 *      这里直接把两个模块导入同一个进程逐例比对。
 *
 *   2. **`video_paths` 绝不能由调用方提供**
 *      它是设备主机上的绝对路径，autojs 会 `adb push` 到手机。
 *      若允许浏览器指定，任何租户都能把主机上的任意文件推到设备上。
 *
 *   3. **视频归属与存储配额**
 *      视频和账号一样是「谁的资源」，不查归属就能拿别人的素材；
 *      不查配额就能把服务器磁盘写满。
 *
 * 运行（需先启动 relay，且 AGENT_SECRET 已知）：
 *   cd relay
 *   $env:LOGIN_MAX_ATTEMPTS='1000'; $env:REGISTER_MAX_ATTEMPTS='1000'; $env:AGENT_SECRET='test-agent-secret'
 *   node --import ./dev/register.mjs src/main.ts      # 另开窗口
 *   $env:TEST_ADMIN_PASSWORD='<与上面一致>'; $env:TEST_AGENT_SECRET='test-agent-secret'
 *   node --import ./dev/register.mjs dev/video-pipeline-test.mjs
 *
 * 注：`--import ./dev/register.mjs` 是为了让本文件能直接 import 两侧的 .ts 源码。
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { sanitizeVideoFilename as relaySanitize } from "../src/videos/store.ts";
import { sanitizeVideoFilename as agentSanitize } from "../../agent/src/autojs/autojs-validation.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE = process.env.TEST_BASE ?? "http://127.0.0.1:5091";
const WS_BASE = BASE.replace(/^http/, "ws");
const ADMIN = {
  username: process.env.TEST_ADMIN_USER ?? "admin",
  password: requireEnv("TEST_ADMIN_PASSWORD")
};
const AGENT_SECRET = requireEnv("TEST_AGENT_SECRET");

/**
 * relay 落盘素材的根目录，用来**直接查文件系统**证明文件真的被删了。
 *
 * 为什么不能靠接口判断：删掉用户之后 `GET /api/agent/videos/:id` 一定返回
 * 404「视频不存在」—— 因为数据库记录没了，跟文件在不在无关。所以只有看
 * 磁盘才能区分「记录删了」和「文件也删了」。
 *
 * 默认值与测试文档里的启动命令一致（`RELAY_MEDIA_DIR=..\.tmp-test\videos`）。
 * 若指向别处，下面会用「删之前文件是否存在」做前置校验，校验不过就报 SKIP
 * 而不是假装通过 —— 否则路径写错会让断言永远成立。
 */
const MEDIA_DIR =
  process.env.TEST_RELAY_MEDIA_DIR ?? resolve(__dirname, "..", "..", ".tmp-test", "videos");

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`缺少环境变量 ${name}`);
    process.exit(1);
  }
  return value;
}

// 独立网段，避免与其他测试的设备归属互相干扰
const SERIALS = {
  mine: "10.99.1.1:65535",
  theirs: "10.99.1.2:65535"
};

const CUSTOMER = { username: "vidcust", email: "vidcust@example.com", password: "CustomerPass123" };
const OTHER = { username: "vidother", email: "vidother@example.com", password: "CustomerPass123" };

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  return { status: res.status, body: payload };
}

/** 上传原始字节（与前端一致：body 是文件本身，文件名走查询参数） */
async function uploadBytes(name, bytes, token) {
  const res = await fetch(`${BASE}/api/videos?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      Authorization: `Bearer ${token}`
    },
    body: bytes
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  return { status: res.status, body: payload };
}

async function ensureRegistered(user) {
  const codeRes = await api("POST", "/api/auth/register/code", { email: user.email });
  const code = codeRes.body?.devCode;
  if (!code) {
    return { status: 0, body: null };
  }
  return api("POST", "/api/auth/register", { ...user, code });
}

// ────────────────────────── 假 Agent ──────────────────────────

/** 记录到达 agent 的自动化请求，用来证明被拒的请求没有出网 */
const agentReceived = [];

function startFakeAgent() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/agent`);

    ws.on("open", () => {
      const devices = Object.values(SERIALS).map((serial) => ({
        serial,
        status: "online",
        model: "SM-N950U",
        androidVersion: "9",
        width: 1080,
        height: 2220,
        streamStatus: "idle",
        controlStatus: "ready",
        transport: "tcp"
      }));

      ws.send(JSON.stringify({ type: "register-agent", agentId: "agent-video" }));
      ws.send(JSON.stringify({ type: "devices", devices }));
      resolve(ws);
    });

    ws.on("error", reject);

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type !== "automation") {
        return;
      }

      agentReceived.push(msg);

      const reply = (ok, data, error, code) => {
        ws.send(JSON.stringify({ type: "automation-result", requestId: msg.requestId, ok, data, error, code }));
      };

      if (msg.action === "send-video.start") {
        // 真实 agent 会先用 video_ids 从 relay 下载文件，
        // 再把本地路径放进 video_paths。这里只回报收到的字段。
        if (Array.isArray(msg.allowedDeviceIds)) {
          const outOfScope = (msg.payload?.device_ids ?? []).filter(
            (s) => !msg.allowedDeviceIds.includes(s)
          );
          if (outOfScope.length > 0) {
            reply(false, undefined, `agent 侧拒绝：设备不在允许集合内 ${outOfScope.join(",")}`, "validation_failed");
            return;
          }
        }

        reply(true, {
          success: true,
          script_run_id: "sendvedio_test",
          script_type: "sendvedio_precise",
          received: msg.payload
        });
        return;
      }

      reply(false, undefined, `测试假 agent 未实现: ${msg.action}`, "unsupported_action");
    });
  });
}

// ────────────────────────── viewer ──────────────────────────

function openViewer(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/viewer`);
    const messages = [];

    ws.on("message", (raw, isBinary) => {
      if (!isBinary) {
        messages.push(JSON.parse(raw.toString()));
      }
    });
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", token }));

      resolve({
        ws,
        messages,
        send: (obj) => ws.send(JSON.stringify(obj)),
        close: () => ws.close(),
        waitFor: async (predicate, timeoutMs = 8000) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const found = messages.find(predicate);
            if (found) {
              return found;
            }
            await sleep(25);
          }
          return null;
        }
      });
    });
  });
}

let requestCounter = 0;

async function requestAutomation(viewer, action, payload) {
  const requestId = `vid-${++requestCounter}-${Date.now().toString(36)}`;
  viewer.send({ type: "automation", requestId, action, payload });

  const result = await viewer.waitFor(
    (m) => m.type === "automation-result" && m.requestId === requestId
  );

  return result ?? { ok: false, error: "TIMEOUT（未收到 automation-result）" };
}

// ────────────────────────── 主流程 ──────────────────────────

async function main() {
  console.log(`目标 relay: ${BASE}\n`);

  // ══════════════ 1. 两侧文件名规范化必须一致 ══════════════
  console.log("--- 1. 文件名规范化（relay ↔ agent）---");

  const samples = [
    "我的视频.mp4",
    "正常视频.mp4",
    "a/b/c.mp4",
    "..\\..\\evil.mp4",
    'my " & echo X & " video.mp4',
    "video.MP4",
    "___a___.mp4",
    "测试 视频 #1.mov",
    "noextension",
    "payload.exe",
    "",
    "   ",
    `${"x".repeat(200)}.mp4`,
    ".hidden.mp4",
    "中文(1).mp4",
    "a&b|c$d`e.mp4",
    "emoji😀video.m4v",
    ".mp4",
    "...mp4",
    "trailing._-.mp4"
  ];

  let mismatches = [];
  for (const sample of samples) {
    const relayResult = relaySanitize(sample);
    const agentResult = agentSanitize(sample);
    const agentValue = agentResult.ok ? agentResult.value : null;

    if (relayResult !== agentValue) {
      mismatches.push({ sample, relay: relayResult, agent: agentValue });
    }
  }

  chk(`两侧规范化结果完全一致（${samples.length} 个样本）`, mismatches, []);

  // 顺带断言「确实做了净化」，否则两边一致地不净化也算通过
  chk("引号与命令分隔符被替换", relaySanitize('my " & echo X & " video.mp4'), "my_echo_X_video.mp4");
  chk("路径穿越被切断", relaySanitize("..\\..\\evil.mp4"), "evil.mp4");
  chk("中文被保留", relaySanitize("我的视频.mp4"), "我的视频.mp4");
  chk("非白名单扩展名被拒", relaySanitize("payload.exe"), null);
  chk("纯符号名被拒", relaySanitize("...mp4"), null);

  // ══════════════ 准备账号 ══════════════
  const adminLogin = await api("POST", "/api/auth/login", ADMIN);
  if (adminLogin.status !== 200) {
    throw new Error(`管理员登录失败: ${adminLogin.status} ${JSON.stringify(adminLogin.body)}`);
  }
  const adminToken = adminLogin.body.token;

  for (const serial of Object.values(SERIALS)) {
    await api("POST", `/api/admin/devices/${encodeURIComponent(serial)}/assign`, { userId: null }, adminToken);
  }

  // 假 agent 必须在「分配设备」之前连上：relay 的设备表是靠 agent
  // 上报的 devices 消息建立的，设备还不存在时分配会失败。
  const agent = await startFakeAgent();
  await sleep(400);

  for (const user of [CUSTOMER, OTHER]) {
    const existing = (await api("GET", "/api/admin/users", undefined, adminToken)).body.users.find(
      (u) => u.username === user.username
    );
    if (existing && existing.status !== "active") {
      await api("PATCH", `/api/admin/users/${existing.id}`, { status: "active" }, adminToken);
    }
  }

  await ensureRegistered(CUSTOMER);
  await ensureRegistered(OTHER);

  const users = (await api("GET", "/api/admin/users", undefined, adminToken)).body.users;
  const me = users.find((u) => u.username === CUSTOMER.username);
  const other = users.find((u) => u.username === OTHER.username);

  const fullCapabilities = {
    can_view_devices: true,
    can_view_stream: true,
    can_control_input: true,
    can_run_dayil: true,
    can_send_video: true,
    can_upload_video: false
  };

  // 先给「没有上传权限」的状态，用于验证能力开关
  await api("PATCH", `/api/admin/users/${me.id}`, {
    quota: { maxDevices: 2, maxStorageBytes: 0 },
    capabilities: fullCapabilities
  }, adminToken);

  await api("PATCH", `/api/admin/users/${other.id}`, {
    quota: { maxDevices: 1, maxStorageBytes: 0 },
    capabilities: { ...fullCapabilities, can_send_video: false }
  }, adminToken);

  // 分配必须成功，否则后面的「归属」断言会以完全无关的报错失败
  const assignMine = await api("POST", `/api/admin/devices/${encodeURIComponent(SERIALS.mine)}/assign`, { userId: me.id }, adminToken);
  const assignTheirs = await api("POST", `/api/admin/devices/${encodeURIComponent(SERIALS.theirs)}/assign`, { userId: other.id }, adminToken);
  chk("测试设备分配成功（两个）", [assignMine.status, assignTheirs.status], [200, 200]);

  const myToken = (await api("POST", "/api/auth/login", { username: CUSTOMER.username, password: CUSTOMER.password })).body.token;
  const otherToken = (await api("POST", "/api/auth/login", { username: OTHER.username, password: OTHER.password })).body.token;

  const viewer = await openViewer(myToken);
  await viewer.waitFor((m) => m.type === "auth-ok");

  // ══════════════ 2. 上传权限 ══════════════
  console.log("--- 2. 上传能力开关 ---");

  const bytes = Buffer.from("fake-video-payload-".repeat(64), "utf8");
  const denied = await uploadBytes("我的视频.mp4", bytes, myToken);
  chk("无 can_upload_video 被拒", denied.status, 403);

  await api("PATCH", `/api/admin/users/${me.id}`, {
    capabilities: { ...fullCapabilities, can_upload_video: true }
  }, adminToken);

  // ══════════════ 3. 上传校验 ══════════════
  console.log("--- 3. 上传输入校验 ---");

  chk("非白名单扩展名被拒", (await uploadBytes("payload.exe", bytes, myToken)).status, 400);
  chk("纯符号文件名被拒", (await uploadBytes("___.mp4", bytes, myToken)).status, 400);
  chk("空内容被拒", (await uploadBytes("empty.mp4", Buffer.alloc(0), myToken)).status, 400);

  // 用「增量」而不是绝对值断言：这个库是共用的，重跑时里面的视频会累积
  const beforeUpload = await api("GET", "/api/videos", undefined, myToken);
  const usedBefore = beforeUpload.body.usedBytes;

  const uploaded = await uploadBytes("我的 视频 #1.mp4", bytes, myToken);
  chk("上传成功", uploaded.status, 201);
  chk("返回规范化文件名", uploaded.body?.video?.name, "我的_视频_1.mp4");
  chk("返回原始文件名", uploaded.body?.video?.originalName, "我的 视频 #1.mp4");
  chk("已用字节按上传量增长", uploaded.body?.usedBytes, usedBefore + bytes.length);

  const myVideoId = uploaded.body.video.id;
  const expectedSha = createHash("sha256").update(bytes).digest("hex");
  chk("videoId 为 32 位十六进制", /^[a-f0-9]{32}$/.test(myVideoId), true);

  // ══════════════ 4. 设备主机下载 ══════════════
  console.log("--- 4. agent 下载通道 ---");

  const noAuth = await fetch(`${BASE}/api/agent/videos/${myVideoId}`);
  chk("无凭证被拒", noAuth.status, 401);

  const badAuth = await fetch(`${BASE}/api/agent/videos/${myVideoId}`, {
    headers: { Authorization: "Bearer wrong-secret" }
  });
  chk("错误凭证被拒", badAuth.status, 401);

  const goodAuth = await fetch(`${BASE}/api/agent/videos/${myVideoId}`, {
    headers: { Authorization: `Bearer ${AGENT_SECRET}` }
  });
  chk("正确凭证可下载", goodAuth.status, 200);
  chk("文件名通过响应头传递", decodeURIComponent(goodAuth.headers.get("x-video-name") ?? ""), "我的_视频_1.mp4");
  chk("sha256 与上传内容一致", goodAuth.headers.get("x-video-sha256"), expectedSha);

  const downloaded = Buffer.from(await goodAuth.arrayBuffer());
  chk("下载内容与原文件一致", createHash("sha256").update(downloaded).digest("hex"), expectedSha);

  const missing = await fetch(`${BASE}/api/agent/videos/${"0".repeat(32)}`, {
    headers: { Authorization: `Bearer ${AGENT_SECRET}` }
  });
  chk("不存在的视频返回 404", missing.status, 404);

  // ══════════════ 5. 列表与删除的归属 ══════════════
  console.log("--- 5. 素材归属 ---");

  const myList = await api("GET", "/api/videos", undefined, myToken);
  chk("自己的列表含刚上传的视频", myList.body.videos.some((v) => v.id === myVideoId), true);

  const otherList = await api("GET", "/api/videos", undefined, otherToken);
  chk("他人列表看不到我的视频", otherList.body.videos.some((v) => v.id === myVideoId), false);

  chk("删除他人视频被拒", (await api("DELETE", `/api/videos/${myVideoId}`, undefined, otherToken)).status, 403);

  // ══════════════ 6. 下发时的归属与路径剥离 ══════════════
  console.log("--- 6. 下发链路 ---");

  const before = agentReceived.length;
  const ok = await requestAutomation(viewer, "send-video.start", {
    type: "precise",
    accounts: ["acc_mine"],
    device_ids: [SERIALS.mine],
    video_ids: [myVideoId],
    // 故意注入：调用方不该能指定主机上的本地路径
    video_paths: ["C:\\Windows\\System32\\config\\SAM"],
    send_time: "2026-01-02 03:04",
    titles: ["标题一"]
  });

  chk("正常下发成功", ok.ok, true);
  if (!ok.ok) {
    console.log(`        错误详情: ${JSON.stringify(ok)}`);
  }
  chk("请求到达 agent", agentReceived.length, before + 1);

  const forwarded = agentReceived[before]?.payload ?? {};
  chk("video_ids 被透传", forwarded.video_ids, [myVideoId]);
  chk("调用方提供的 video_paths 被剥离", "video_paths" in forwarded, false);
  chk("send_time 被透传", forwarded.send_time, "2026-01-02 03:04");
  chk("accounts 被透传", forwarded.accounts, ["acc_mine"]);

  const beforeForeign = agentReceived.length;
  const foreign = await requestAutomation(viewer, "send-video.start", {
    type: "precise",
    accounts: ["acc_mine"],
    device_ids: [SERIALS.mine],
    video_ids: ["f".repeat(32)]
  });
  chk("使用不存在的视频被拒", foreign.ok, false);
  chk("错误信息可读", /视频/.test(foreign.error ?? ""), true);
  await sleep(300);
  chk("被拒请求没有到达 agent", agentReceived.length, beforeForeign);

  const noVideo = await requestAutomation(viewer, "send-video.start", {
    type: "precise",
    accounts: ["acc_mine"],
    device_ids: [SERIALS.mine]
  });
  chk("缺 video_ids 被拒", noVideo.ok, false);

  // ══════════════ 7. 同名视频必须挡掉 ══════════════
  console.log("--- 7. 同名视频 ---");

  // 换个目录名把同一份内容再传一次：safeName 相同但 id 不同
  const dup = await uploadBytes("sub/我的 视频 #1.mp4", bytes, myToken);
  chk("同名视频可以上传（id 不同）", dup.status, 201);
  chk("规范化后与原视频同名", dup.body?.video?.name, "我的_视频_1.mp4");

  const beforeDup = agentReceived.length;
  const dupRes = await requestAutomation(viewer, "send-video.start", {
    type: "precise",
    accounts: ["acc_mine"],
    device_ids: [SERIALS.mine],
    video_ids: [myVideoId, dup.body.video.id]
  });
  chk("同名视频同批下发被拒", dupRes.ok, false);
  chk("提示同名", /同名/.test(dupRes.error ?? ""), true);
  await sleep(300);
  chk("被拒的同名请求没有到达 agent", agentReceived.length, beforeDup);

  // ══════════════ 8. 没有发视频权限 ══════════════
  console.log("--- 8. 发视频能力开关 ---");

  const otherViewer = await openViewer(otherToken);
  await otherViewer.waitFor((m) => m.type === "auth-ok");

  const beforeCap = agentReceived.length;
  const noCap = await requestAutomation(otherViewer, "send-video.start", {
    type: "precise",
    accounts: ["acc_other"],
    device_ids: [SERIALS.theirs],
    video_ids: [myVideoId]
  });
  chk("无 can_send_video 被拒", noCap.ok, false);
  chk("提示缺权限", /权限/.test(noCap.error ?? ""), true);
  await sleep(300);
  chk("缺权限请求没有到达 agent", agentReceived.length, beforeCap);

  // ══════════════ 9. 存储配额 ══════════════
  console.log("--- 9. 存储配额 ---");

  await api("PATCH", `/api/admin/users/${me.id}`, { quota: { maxStorageBytes: 1024 } }, adminToken);

  const beforeQuota = await api("GET", "/api/videos", undefined, myToken);
  const used = beforeQuota.body.usedBytes;

  chk("读取到已用空间", used > 0, true);

  const tooBig = await uploadBytes("big.mp4", Buffer.alloc(Math.max(4096, used + 1)), myToken);
  chk("超出配额被拒", tooBig.status, 413);

  // 收尾：把配额放开，避免影响后续重复运行
  await api("PATCH", `/api/admin/users/${me.id}`, { quota: { maxStorageBytes: 0 } }, adminToken);

  // ══════════════ 10. 删除 ══════════════
  console.log("--- 10. 删除素材 ---");

  const del = await api("DELETE", `/api/videos/${myVideoId}`, undefined, myToken);
  chk("删除自己的视频成功", del.status, 200);

  const afterDelete = await api("GET", "/api/videos", undefined, myToken);
  chk("列表里不再出现", afterDelete.body.videos.some((v) => v.id === myVideoId), false);

  const downloadAfterDelete = await fetch(`${BASE}/api/agent/videos/${myVideoId}`, {
    headers: { Authorization: `Bearer ${AGENT_SECRET}` }
  });
  chk("删除后 agent 下载返回 404", downloadAfterDelete.status, 404);

  // 顺手清掉同名测试留下的那个，否则反复运行会把共用库撑大
  await api("DELETE", `/api/videos/${dup.body.video.id}`, undefined, myToken);

  // ══════════════ 11. 删除用户必须连素材文件一起删 ══════════════
  console.log("--- 11. 删用户连文件一起删 ---");

  // 造一个一次性的客户，专门用来删
  const DOOMED = { username: "vid_doomed", email: "vid_doomed@example.com", password: "CustomerPass123" };
  await ensureRegistered(DOOMED);
  const doomed = (await api("GET", "/api/admin/users", undefined, adminToken)).body.users
    .find((u) => u.username === DOOMED.username);
  chk("一次性客户已创建", Boolean(doomed), true);

  await api("PATCH", `/api/admin/users/${doomed.id}`, {
    quota: { maxDevices: 0, maxStorageBytes: 0 },
    capabilities: { can_view_devices: true, can_upload_video: true, can_send_video: true }
  }, adminToken);

  const doomedToken = (await api("POST", "/api/auth/login", {
    username: DOOMED.username,
    password: DOOMED.password
  })).body.token;

  const doomedUpload = await uploadBytes("要被删掉的素材.mp4", bytes, doomedToken);
  chk("一次性客户上传成功", doomedUpload.status, 201);

  const doomedVideoId = doomedUpload.body.video.id;
  const doomedDir = join(MEDIA_DIR, doomedVideoId);

  // 前置校验：先确认文件确实在磁盘上，否则后面的「不存在」断言没有意义
  const existedBefore = existsSync(doomedDir);
  chk("删之前素材目录确实存在于磁盘", existedBefore, true);
  if (!existedBefore) {
    console.log(`        ⚠️ 找不到 ${doomedDir}`);
    console.log("        TEST_RELAY_MEDIA_DIR 没指向 relay 的 RELAY_MEDIA_DIR，");
    console.log("        下面的文件系统断言会被跳过（不假装通过）。");
  }

  const doomedDelete = await api("DELETE", `/api/admin/users/${doomed.id}`, undefined, adminToken);
  chk("删除账号成功", doomedDelete.status, 200);
  chk("回执报告清理了 1 个素材", doomedDelete.body?.removedVideos, 1);

  if (existedBefore) {
    chk("素材目录已从磁盘删除", existsSync(doomedDir), false);
  } else {
    console.log("  SKIP  素材目录是否删除（无法定位文件系统路径）");
  }

  // 账号确实没了：用原密码登录应失败
  const loginAfter = await api("POST", "/api/auth/login", {
    username: DOOMED.username,
    password: DOOMED.password
  });
  chk("账号已删除（登录失败）", loginAfter.status === 200, false);

  // 审计里要留下清了多少个，否则事后无法核对
  const audit = await api("GET", "/api/admin/audit?limit=20", undefined, adminToken);
  const deleteEntry = audit.body.entries.find(
    (e) => e.action === "admin.user_deleted" && e.target === DOOMED.username
  );
  chk("审计记录了删号", Boolean(deleteEntry), true);

  if (deleteEntry) {
    console.log(`        detail = ${deleteEntry.detail}`);
    chk("detail 里 removedVideos=1", /"removedVideos":1/.test(deleteEntry.detail ?? ""), true);
  }

  // 没有素材的用户也要能删（不能因为 collecting 空数组就出问题）
  const EMPTY = { username: "vid_empty", email: "vid_empty@example.com", password: "CustomerPass123" };
  await ensureRegistered(EMPTY);
  const emptyUser = (await api("GET", "/api/admin/users", undefined, adminToken)).body.users
    .find((u) => u.username === EMPTY.username);
  if (emptyUser) {
    const emptyDelete = await api("DELETE", `/api/admin/users/${emptyUser.id}`, undefined, adminToken);
    chk("删除无素材的用户也成功", emptyDelete.status, 200);
    chk("清理数量为 0", emptyDelete.body?.removedVideos, 0);
  }

  viewer.close();
  otherViewer.close();
  agent.close();

  console.log(`\n=========== pass=${pass}  fail=${fail} ===========`);

  await sleep(100);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
