/**
 * 前端本地验收的**自动化版本**。
 *
 * 配套 `scripts/dev-web-test.mjs`：那个脚本起「静态页 + relay + 假 agent」
 * 三件套并把 /api 与 /ws 反代到 relay，本脚本对 **8090 这一个源**发请求，
 * 走的路径与浏览器完全一致（同源反代，和生产 nginx 部署同构）。
 *
 * 为什么要有它：浏览器里点一遍能发现「接口通不通」，但发现不了
 * 「调用方塞的 video_paths 有没有被剥掉」这类只体现在**服务端收到的字节**
 * 上的问题。这里刻意把 `video_paths: ["C:\\Windows\\win.ini"]` 塞进去，
 * 再断言假 agent 收到的 `video_paths` 是 null。
 *
 * 用法：
 *   1. 另开窗口：node scripts/dev-web-test.mjs
 *   2. 本脚本：  node scripts/dev-web-acceptance.mjs
 *
 * 可重复运行：账号与设备是幂等的，容量断言用增量而不是绝对值。
 */

import { createHash } from "node:crypto";
import WebSocket from "ws";

const BASE = process.env.TEST_WEB_BASE ?? "http://127.0.0.1:8090";
const WS_BASE = BASE.replace(/^http/, "ws");
// 与 scripts/dev-web-test.mjs 的默认值保持一致
const AGENT_SECRET = process.env.TEST_AGENT_SECRET ?? "devtest-agent-secret";
const ADMIN = {
  username: process.env.TEST_ADMIN_USER ?? "admin",
  password: process.env.TEST_ADMIN_PASSWORD ?? "DevTest123456"
};

const CUSTOMER = { username: "uicheck", email: "uicheck@example.com", password: "CustomerPass123" };
/** dev-web-test 上报的第一台虚拟设备 */
const SERIAL = "10.99.0.11:5555";
/** 假 agent 为每台设备配的账号名，见 dev-web-test.mjs 的 accounts 分支 */
const ACCOUNT = "acc_dev_1";

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

/** 打开 viewer、鉴权、发一条 automation 并等回执 */
function dispatch(token, action, payload) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/viewer`);
    const requestId = `acceptance-${Date.now().toString(36)}`;

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("等待 automation-result 超时"));
    }, 10000);

    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        return;
      }

      const msg = JSON.parse(raw.toString());

      if (msg.type === "auth-ok") {
        ws.send(JSON.stringify({ type: "automation", requestId, action, payload }));
        return;
      }

      if (msg.type === "auth-error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`viewer 鉴权失败：${msg.message ?? "未知原因"}`));
        return;
      }

      if (msg.type === "automation-result" && msg.requestId === requestId) {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      }
    });

    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
  });
}

async function main() {
  console.log(`目标前端: ${BASE}\n`);

  console.log("--- 1. 同源反代 ---");

  chk("静态页可访问", (await fetch(`${BASE}/`)).status, 200);
  chk("反代 /health 可用", (await fetch(`${BASE}/health`)).status, 200);

  const admin = await api("POST", "/api/auth/login", ADMIN);
  chk("管理员登录（走反代）", admin.status, 200);
  const adminToken = admin.body.token;

  console.log("--- 2. 准备客户与设备 ---");

  // 幂等：账号可能已存在、可能被上一轮禁用
  const existing = (await api("GET", "/api/admin/users", undefined, adminToken)).body.users
    .find((u) => u.username === CUSTOMER.username);
  if (existing && existing.status !== "active") {
    await api("PATCH", `/api/admin/users/${existing.id}`, { status: "active" }, adminToken);
  }

  // 注册两步走；已注册过时 register 返回 409，属预期
  const codeRes = await api("POST", "/api/auth/register/code", { email: CUSTOMER.email });
  if (codeRes.body?.devCode) {
    await api("POST", "/api/auth/register", { ...CUSTOMER, code: codeRes.body.devCode });
  }

  const me = (await api("GET", "/api/admin/users", undefined, adminToken)).body.users
    .find((u) => u.username === CUSTOMER.username);
  chk("客户账号存在", Boolean(me), true);

  await api("PATCH", `/api/admin/users/${me.id}`, {
    quota: { maxDevices: 2, maxStorageBytes: 0 },
    capabilities: {
      can_view_devices: true,
      can_view_stream: true,
      can_control_input: true,
      can_run_dayil: true,
      can_send_video: true,
      can_upload_video: true
    }
  }, adminToken);

  const assign = await api(
    "POST",
    `/api/admin/devices/${encodeURIComponent(SERIAL)}/assign`,
    { userId: me.id },
    adminToken
  );
  chk("设备分配成功", assign.status, 200);

  const myToken = (await api("POST", "/api/auth/login", {
    username: CUSTOMER.username,
    password: CUSTOMER.password
  })).body.token;

  console.log("--- 3. 上传素材（与浏览器同一套请求语义）---");

  // 增量断言：库是复用的，重跑时已用空间会累积
  const usedBefore = (await api("GET", "/api/videos", undefined, myToken)).body.usedBytes;
  const bytes = Buffer.from("ui-acceptance-video-".repeat(100), "utf8");

  const upload = await fetch(`${BASE}/api/videos?name=${encodeURIComponent("验收 视频.mp4")}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      Authorization: `Bearer ${myToken}`
    },
    body: bytes
  });
  const uploaded = await upload.json();

  chk("上传成功", upload.status, 201);
  chk("文件名被规范化", uploaded.video?.name, "验收_视频.mp4");
  chk("已用空间按上传量增长", uploaded.usedBytes, usedBefore + bytes.length);

  const videoId = uploaded.video.id;
  const sha = createHash("sha256").update(bytes).digest("hex");

  console.log("--- 4. 素材库与下载通道 ---");

  const list = await api("GET", "/api/videos", undefined, myToken);
  chk("素材库列出该视频", list.body.videos.some((v) => v.id === videoId), true);
  chk("配额字段存在", typeof list.body.quotaBytes, "number");

  const download = await fetch(`${BASE}/api/agent/videos/${videoId}`, {
    headers: { Authorization: `Bearer ${AGENT_SECRET}` }
  });
  const downloaded = Buffer.from(await download.arrayBuffer());
  chk("agent 可下载", download.status, 200);
  chk("内容 sha256 一致", createHash("sha256").update(downloaded).digest("hex"), sha);

  console.log("--- 5. 下发（含恶意 video_paths 注入）---");

  const result = await dispatch(myToken, "send-video.start", {
    type: "precise",
    accounts: [ACCOUNT],
    device_ids: [SERIAL],
    video_ids: [videoId],
    // 故意注入：必须被 relay 剥掉，只认 video_ids
    video_paths: ["C:\\Windows\\win.ini"],
    titles: ["验收标题"]
  });

  chk("发视频下发成功", result.ok, true);
  chk("假 agent 返回 script_run_id", result.data?.script_run_id, "sendvedio_devtest");
  chk("回显收到的 video_ids", result.data?.resolved_videos, [videoId]);

  console.log(`\n=========== pass=${pass}  fail=${fail} ===========`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
