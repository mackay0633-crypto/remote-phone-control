/**
 * Phase B 隔离验证脚本。
 *
 * 用一个「假 Agent」充当设备侧，通过真实 WebSocket 与 HTTP 验证：
 *   - 未鉴权连接拿不到任何数据
 *   - 客户只能看到自己名下的设备
 *   - 客户下发指令到他人设备会被拒绝，且**指令不会到达 Agent**
 *   - 客户无法订阅他人设备的视频流
 *   - 管理员在后台改动权限/归属后，**已建立的连接立刻生效**
 *
 * 运行（需先启动 relay）：
 *   cd relay
 *   node --import ./dev/register.mjs src/main.ts      # 另开窗口
 *   node dev/phase-b-isolation-test.mjs
 */

import WebSocket from "ws";

const BASE = process.env.TEST_BASE ?? "http://127.0.0.1:5091";
const WS_BASE = BASE.replace(/^http/, "ws");
const ADMIN = {
  username: process.env.TEST_ADMIN_USER ?? "admin",
  // 不设默认值：源码里不留任何可用凭据
  password: requireEnv("TEST_ADMIN_PASSWORD")
};

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`缺少环境变量 ${name}——它应与启动 relay 时的 ADMIN_PASSWORD 一致。`);
    console.error(`例如：  $env:${name}='<你的管理员密码>'`);
    process.exit(1);
  }
  return value;
}

const SERIALS = {
  cust1A: "192.168.9.41:65535",
  cust1B: "192.168.9.42:65535",
  cust2A: "192.168.9.43:65535",
  free: "192.168.9.44:65535"
};

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ────────────────────────── HTTP ──────────────────────────

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

// ────────────────────────── 假 Agent ──────────────────────────

/** 记录真正下发到 Agent 的 input，用来证明「被拒的指令没有到达设备」 */
const agentInputs = [];

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

      ws.send(JSON.stringify({ type: "register-agent", agentId: "agent-A" }));
      ws.send(JSON.stringify({ type: "devices", devices }));
      resolve(ws);
    });

    ws.on("error", reject);

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        return;
      }

      const msg = JSON.parse(raw.toString());

      if (msg.type === "input") {
        agentInputs.push(msg);
        return;
      }

      if (msg.type === "start-stream") {
        ws.send(JSON.stringify({ type: "stream-ready", serial: msg.serial, width: 1080, height: 2220 }));

        // 发一帧假数据，验证二进制通路
        const serialBuffer = Buffer.from(msg.serial, "utf8");
        const header = Buffer.alloc(2);
        header.writeUInt16BE(serialBuffer.length, 0);
        ws.send(Buffer.concat([header, serialBuffer, Buffer.from([0, 0, 0, 1, 0x67])]), { binary: true });
      }
    });
  });
}

// ────────────────────────── WS 客户端助手 ──────────────────────────

function openViewer(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_BASE + path);
    const messages = [];
    const binaries = [];
    let closed = false;

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        binaries.push(Buffer.from(raw));
      } else {
        messages.push(JSON.parse(raw.toString()));
      }
    });

    ws.on("close", () => {
      closed = true;
    });

    ws.on("error", reject);

    ws.on("open", () => {
      resolve({
        ws,
        messages,
        binaries,
        send: (obj) => ws.send(JSON.stringify(obj)),
        isClosed: () => closed,
        close: () => ws.close(),
        count: () => messages.length,
        /**
         * 只匹配 startIndex 之后的新消息。
         *
         * 必须这样做：同一个连接会先后收到多条 input-error，
         * 若直接 find() 会命中之前残留的那条，断言就形同虚设。
         */
        waitForAfter: async (type, startIndex, timeoutMs = 2500) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const found = messages.slice(startIndex).find((m) => m.type === type);
            if (found) {
              return found;
            }
            await sleep(25);
          }
          return null;
        },
        waitFor: async (type, timeoutMs = 2500) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const found = messages.find((m) => m.type === type);
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

// ────────────────────────── 主流程 ──────────────────────────

async function main() {
  console.log(`目标 relay: ${BASE}\n`);

  const agent = await startFakeAgent();
  await sleep(300);

  // ── 准备账号与归属 ──
  const adminLogin = await api("POST", "/api/auth/login", ADMIN);
  if (adminLogin.status !== 200) {
    throw new Error(`管理员登录失败: ${adminLogin.status} ${JSON.stringify(adminLogin.body)}`);
  }
  const adminToken = adminLogin.body.token;

  await api("POST", "/api/auth/register", { username: "cust1", password: "CustomerPass123" });
  await api("POST", "/api/auth/register", { username: "cust2", password: "CustomerPass123" });

  const users = (await api("GET", "/api/admin/users", undefined, adminToken)).body.users;
  const cust1 = users.find((u) => u.username === "cust1");
  const cust2 = users.find((u) => u.username === "cust2");

  await api(
    "PATCH",
    `/api/admin/users/${cust1.id}`,
    {
      quota: { maxDevices: 2 },
      capabilities: { can_view_devices: true, can_view_stream: true, can_control_input: true }
    },
    adminToken
  );
  await api(
    "PATCH",
    `/api/admin/users/${cust2.id}`,
    { quota: { maxDevices: 1 }, capabilities: { can_view_devices: true, can_view_stream: true } },
    adminToken
  );

  await api("POST", `/api/admin/devices/${encodeURIComponent(SERIALS.cust1A)}/assign`, { userId: cust1.id }, adminToken);
  await api("POST", `/api/admin/devices/${encodeURIComponent(SERIALS.cust1B)}/assign`, { userId: cust1.id }, adminToken);
  await api("POST", `/api/admin/devices/${encodeURIComponent(SERIALS.cust2A)}/assign`, { userId: cust2.id }, adminToken);

  const cust1Token = (await api("POST", "/api/auth/login", { username: "cust1", password: "CustomerPass123" })).body.token;
  const cust2Token = (await api("POST", "/api/auth/login", { username: "cust2", password: "CustomerPass123" })).body.token;

  // ══════════════ 1. 未鉴权不得拿到任何数据 ══════════════
  console.log("--- 1. 未鉴权连接 ---");

  const anon = await openViewer("/ws/viewer");
  await sleep(300);
  chk("未发送 auth 时收不到任何消息", anon.messages.length, 0);
  anon.send({ type: "input", serial: SERIALS.cust1A, command: { action: "tap", x: 1, y: 1 } });
  const anonErr = await anon.waitFor("auth-error");
  chk("首条非 auth 消息被拒", anonErr !== null, true);
  chk("被拒后连接关闭", anon.isClosed(), true);

  const badToken = await openViewer("/ws/viewer");
  badToken.send({ type: "auth", token: "totally-fake-token" });
  chk("伪造令牌被拒", (await badToken.waitFor("auth-error")) !== null, true);

  // ══════════════ 2. 设备可见性隔离 ══════════════
  console.log("--- 2. 设备可见性 ---");

  const v1 = await openViewer("/ws/viewer");
  v1.send({ type: "auth", token: cust1Token });
  await v1.waitFor("auth-ok");
  const v1Devices = await v1.waitFor("devices");
  chk("cust1 只看到自己的 2 台", v1Devices.devices.map((d) => d.serial).sort(), [SERIALS.cust1A, SERIALS.cust1B].sort());

  const v2 = await openViewer("/ws/viewer");
  v2.send({ type: "auth", token: cust2Token });
  await v2.waitFor("auth-ok");
  const v2Devices = await v2.waitFor("devices");
  chk("cust2 只看到自己的 1 台", v2Devices.devices.map((d) => d.serial), [SERIALS.cust2A]);

  const vAdmin = await openViewer("/ws/viewer");
  vAdmin.send({ type: "auth", token: adminToken });
  await vAdmin.waitFor("auth-ok");
  const vAdminDevices = await vAdmin.waitFor("devices");
  chk("管理员看到全部 4 台", vAdminDevices.devices.length, 4);

  // ══════════════ 3. 指令隔离 ══════════════
  console.log("--- 3. 指令下发隔离 ---");

  const inputsBefore = agentInputs.length;

  // 3a. 合法：操作自己的设备
  v1.send({ type: "input", serial: SERIALS.cust1A, command: { action: "tap", x: 100, y: 200 } });
  await sleep(400);
  chk("合法指令到达 Agent", agentInputs.length, inputsBefore + 1);
  chk("到达的是自己的设备", agentInputs[agentInputs.length - 1]?.serial, SERIALS.cust1A);

  // 3b. 越权：操作他人的设备
  const before = agentInputs.length;
  const mark3b = v1.count();
  v1.send({ type: "input", serial: SERIALS.cust2A, command: { action: "tap", x: 100, y: 200 } });
  const denied = await v1.waitForAfter("input-error", mark3b);
  chk("越权指令被拒", denied?.message, "无权操作该设备");
  await sleep(300);
  chk("越权指令**没有**到达 Agent", agentInputs.length, before);

  // 3c. 不存在的设备
  const before2 = agentInputs.length;
  const mark3c = v1.count();
  v1.send({ type: "input", serial: "10.0.0.99:5555", command: { action: "tap", x: 1, y: 1 } });
  chk("未知设备被拒", (await v1.waitForAfter("input-error", mark3c))?.message, "无权操作该设备");
  await sleep(200);
  chk("未知设备指令未到达 Agent", agentInputs.length, before2);

  // ══════════════ 4. 视频流隔离 ══════════════
  console.log("--- 4. 视频流隔离 ---");

  // 4a. 未鉴权订阅
  const s1 = await openViewer(`/ws/viewer/stream?serial=${encodeURIComponent(SERIALS.cust1A)}`);
  await sleep(300);
  chk("未鉴权订阅收不到任何数据", s1.messages.length + s1.binaries.length, 0);
  // 鉴权超时为 5 秒，必须等够再断言
  const s1Err = await s1.waitFor("stream-error", 7000);
  chk("未鉴权订阅被拒（鉴权超时）", s1Err !== null, true);

  // 4b. 订阅自己的设备
  const s2 = await openViewer(`/ws/viewer/stream?serial=${encodeURIComponent(SERIALS.cust1A)}`);
  s2.send({ type: "auth", token: cust1Token });
  const s2Ready = await s2.waitFor("stream-ready");
  chk("订阅自己的设备成功", s2Ready?.serial, SERIALS.cust1A);
  await sleep(400);
  chk("收到二进制帧", s2.binaries.length > 0, true);

  // 4c. 订阅他人的设备
  const s3 = await openViewer(`/ws/viewer/stream?serial=${encodeURIComponent(SERIALS.cust2A)}`);
  s3.send({ type: "auth", token: cust1Token });
  const s3Err = await s3.waitFor("stream-error");
  chk("订阅他人设备被拒", s3Err?.message, "无权查看该设备");
  chk("被拒后连接关闭", s3.isClosed(), true);

  // ══════════════ 5. 管理员改动对已建立连接立刻生效 ══════════════
  console.log("--- 5. 权限变更即时生效 ---");

  // 5a. 收回 can_control_input
  await api("PATCH", `/api/admin/users/${cust1.id}`, { capabilities: { can_control_input: false } }, adminToken);
  await sleep(400);

  const before3 = agentInputs.length;
  const mark5a = v1.count();
  v1.send({ type: "input", serial: SERIALS.cust1A, command: { action: "tap", x: 5, y: 5 } });
  const revoked = await v1.waitForAfter("input-error", mark5a);
  chk("收回操控权后旧连接立即失效", revoked?.message, "当前账号没有手动操控权限");
  await sleep(300);
  chk("被收回后指令未到达 Agent", agentInputs.length, before3);
  chk("连接仍然保留(仅失去操控)", v1.isClosed(), false);

  // 服务端应主动推送最新权限，否则前端按钮会按登录时的旧权限显示
  const permsMsg = [...v1.messages].reverse().find((m) => m.type === "permissions");
  chk("推送了最新权限(can_control_input=false)", permsMsg?.capabilities?.can_control_input, false);
  chk("推送的权限里 can_view_devices 仍为 true", permsMsg?.capabilities?.can_view_devices, true);

  // 5b. 收回 can_view_stream
  await api("PATCH", `/api/admin/users/${cust1.id}`, { capabilities: { can_view_stream: false } }, adminToken);
  await sleep(500);
  const streamRevoked = s2.messages.find(
    (m) => m.type === "stream-error" && m.message === "已失去该设备的查看权限"
  );
  chk("收回查看权后正在进行的流被断开", streamRevoked !== undefined, true);

  // 5c. 收回设备归属 → 设备列表立即刷新
  await api("POST", `/api/admin/devices/${encodeURIComponent(SERIALS.cust1B)}/assign`, { userId: null }, adminToken);
  await sleep(500);
  const latestDevices = [...v1.messages].reverse().find((m) => m.type === "devices");
  chk("收回设备后列表立即刷新", latestDevices.devices.map((d) => d.serial), [SERIALS.cust1A]);

  // 5d. 禁用账号 → 连接被断开
  await api("PATCH", `/api/admin/users/${cust1.id}`, { status: "disabled" }, adminToken);
  await sleep(500);
  chk("账号被禁用后连接被断开", v1.isClosed(), true);

  // ══════════════ 6. 审计 ══════════════
  console.log("--- 6. 审计 ---");
  const audit = (await api("GET", "/api/admin/audit?limit=300", undefined, adminToken)).body.entries;
  const actions = audit.map((e) => e.action);
  chk("记录了越权指令尝试", actions.includes("viewer.input_denied"), true);
  chk("记录了越权订阅尝试", actions.includes("viewer.stream_denied"), true);
  chk("记录了流被收回", actions.includes("viewer.stream_revoked"), true);

  // ── 收尾 ──
  v2.close();
  vAdmin.close();
  agent.close();

  console.log(`\n=========== pass=${pass}  fail=${fail} ===========`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\n测试执行失败:", error);
  process.exit(1);
});
