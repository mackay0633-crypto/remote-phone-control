/**
 * 自动化链路（养号 / 发视频）端到端测试。
 *
 * 用一个假 Agent 扮演「本机 agent + autojs」，验证 relay 这一层的三件事：
 *
 *   1. **鉴权** —— 动作白名单 + 能力开关；没有 can_run_dayil 就发不出去
 *   2. **归属校验** —— 只能操作自己名下的设备，越权请求**不会到达 agent**
 *   3. **结果过滤** —— autojs 返回的是全局视图，relay 必须按设备集裁掉他人的部分
 *
 * 第 3 条最容易漏：不裁的话客户就能看到别人在跑什么任务、有哪些账号。
 *
 * 运行（需先启动 relay）：
 *   cd relay
 *   $env:LOGIN_MAX_ATTEMPTS='1000'; $env:REGISTER_MAX_ATTEMPTS='1000'
 *   node --import ./dev/register.mjs src/main.ts      # 另开窗口
 *   $env:TEST_ADMIN_PASSWORD='<与上面一致>'
 *   node dev/automation-routing-test.mjs
 */

import WebSocket from "ws";

const BASE = process.env.TEST_BASE ?? "http://127.0.0.1:5091";
const WS_BASE = BASE.replace(/^http/, "ws");
const ADMIN = {
  username: process.env.TEST_ADMIN_USER ?? "admin",
  password: requireEnv("TEST_ADMIN_PASSWORD")
};

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`缺少环境变量 ${name}——它应与启动 relay 时的 ADMIN_PASSWORD 一致。`);
    process.exit(1);
  }
  return value;
}

// 测试专用网段，与真实设备无关
const SERIALS = {
  cust1A: "10.99.0.1:65535",
  cust1B: "10.99.0.2:65535",
  cust2A: "10.99.0.3:65535",
  free: "10.99.0.4:65535"
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

/**
 * 两步注册：先要验证码，再带码建号。
 *
 * 验证码取自响应的 `devCode`，所以 relay 必须跑在
 * 非生产环境 + console 邮件模式下。
 *
 * 账号在共用库里往往上一轮就已注册过（此时 register 返回 409），
 * 属于预期情况，不当作失败。
 */
async function ensureRegistered(username, email, password) {
  const codeRes = await api("POST", "/api/auth/register/code", { email });
  const code = codeRes.body?.devCode;

  if (!code) {
    return { status: 0, body: null };
  }

  return api("POST", "/api/auth/register", { username, email, password, code });
}

// ────────────────────────── 假 Agent ──────────────────────────

/** 记录到达 agent 的自动化请求，用来证明「被拒的请求没有到达 agent」 */
const agentReceived = [];

/**
 * 假 Agent。模拟 autojs 的行为特点：**返回全局数据**（含他人设备）。
 * relay 若不裁剪，客户就能看到别人的东西。
 */
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

      switch (msg.action) {
        case "health":
          reply(true, { ok: true, port: 5000 });
          return;

        case "run-status":
          // 故意返回全部设备的条目（含 cust2 的），检验 relay 是否裁剪
          reply(true, {
            success: true,
            active: true,
            taskCount: 3,
            runCount: 3,
            deviceCount: 3,
            latestLabel: "养号脚本正在运行",
            entries: [
              { id: "e1", label: "养号", source: "api-dayil-start", deviceId: SERIALS.cust1A, scriptRunId: "s1", deviceCount: 1, startedAt: 1, expiresAt: 2 },
              { id: "e2", label: "养号", source: "api-dayil-start", deviceId: SERIALS.cust1B, scriptRunId: "s2", deviceCount: 1, startedAt: 1, expiresAt: 2 },
              { id: "e3", label: "发视频", source: "api-send-video-start", deviceId: SERIALS.cust2A, scriptRunId: "s3", deviceCount: 1, startedAt: 1, expiresAt: 2 }
            ]
          });
          return;

        case "accounts":
          // 同样故意返回全部账号
          reply(true, [
            { id: 1, username: "acc_cust1_a", device_id: SERIALS.cust1A },
            { id: 2, username: "acc_cust1_b", device_id: SERIALS.cust1B },
            { id: 3, username: "acc_cust2_a", device_id: SERIALS.cust2A },
            { id: 4, username: "acc_no_device", device_id: null }
          ]);
          return;

        case "dayil-work.start":
          // agent 侧纵深防御：校验请求的设备是否在 relay 给的允许集合内
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
            script_run_id: "dayil_work_test",
            script_type: "dayil_work",
            received_device_ids: msg.payload?.device_ids
          });
          return;

        case "send-video.start":
          reply(true, { success: true, script_run_id: "sendvedio_test", script_type: "sendvedio_precise" });
          return;

        default:
          reply(false, undefined, `不支持的动作: ${msg.action}`, "unsupported_action");
      }
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
        waitFor: async (predicate, timeoutMs = 5000) => {
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

/** 发一个自动化请求并等它的结果 */
async function requestAutomation(viewer, action, payload) {
  const requestId = `req-${++requestCounter}-${Date.now().toString(36)}`;
  viewer.send({ type: "automation", requestId, action, payload });

  const result = await viewer.waitFor(
    (m) => m.type === "automation-result" && m.requestId === requestId
  );

  if (!result) {
    return { ok: false, error: "TIMEOUT（未收到 automation-result）" };
  }
  return result;
}

// ────────────────────────── 主流程 ──────────────────────────

async function main() {
  console.log(`目标 relay: ${BASE}\n`);

  const agent = await startFakeAgent();
  await sleep(300);

  const adminLogin = await api("POST", "/api/auth/login", ADMIN);
  if (adminLogin.status !== 200) {
    throw new Error(`管理员登录失败: ${adminLogin.status} ${JSON.stringify(adminLogin.body)}`);
  }
  const adminToken = adminLogin.body.token;

  // 幂等：先释放测试设备、恢复测试账号
  for (const serial of Object.values(SERIALS)) {
    await api("POST", `/api/admin/devices/${encodeURIComponent(serial)}/assign`, { userId: null }, adminToken);
  }

  for (const username of ["cust1", "cust2"]) {
    const existing = (await api("GET", "/api/admin/users", undefined, adminToken)).body.users.find(
      (u) => u.username === username
    );
    if (existing && existing.status !== "active") {
      await api("PATCH", `/api/admin/users/${existing.id}`, { status: "active" }, adminToken);
    }
  }

  await ensureRegistered("cust1", "cust1@example.com", "CustomerPass123");
  await ensureRegistered("cust2", "cust2@example.com", "CustomerPass123");

  const users = (await api("GET", "/api/admin/users", undefined, adminToken)).body.users;
  const cust1 = users.find((u) => u.username === "cust1");
  const cust2 = users.find((u) => u.username === "cust2");

  // cust1：有养号权限；cust2：只有查看权限（没有 can_run_dayil）
  await api("PATCH", `/api/admin/users/${cust1.id}`, {
    quota: { maxDevices: 2 },
    capabilities: { can_view_devices: true, can_view_stream: true, can_control_input: true, can_run_dayil: true }
  }, adminToken);

  await api("PATCH", `/api/admin/users/${cust2.id}`, {
    quota: { maxDevices: 1 },
    capabilities: { can_view_devices: true, can_view_stream: true }
  }, adminToken);

  await api("POST", `/api/admin/devices/${encodeURIComponent(SERIALS.cust1A)}/assign`, { userId: cust1.id }, adminToken);
  await api("POST", `/api/admin/devices/${encodeURIComponent(SERIALS.cust1B)}/assign`, { userId: cust1.id }, adminToken);
  await api("POST", `/api/admin/devices/${encodeURIComponent(SERIALS.cust2A)}/assign`, { userId: cust2.id }, adminToken);

  const cust1Token = (await api("POST", "/api/auth/login", { username: "cust1", password: "CustomerPass123" })).body.token;
  const cust2Token = (await api("POST", "/api/auth/login", { username: "cust2", password: "CustomerPass123" })).body.token;

  const v1 = await openViewer(cust1Token);
  const v2 = await openViewer(cust2Token);
  const vAdmin = await openViewer(adminToken);
  await v1.waitFor((m) => m.type === "auth-ok");
  await v2.waitFor((m) => m.type === "auth-ok");
  await vAdmin.waitFor((m) => m.type === "auth-ok");

  // ══════════════ 1. 正常下发养号 ══════════════
  console.log("--- 1. 正常下发养号 ---");

  const before = agentReceived.length;
  const r1 = await requestAutomation(v1, "dayil-work.start", {
    device_ids: [SERIALS.cust1A, SERIALS.cust1B],
    config: { SWIPE_COUNT: 30, PLAY_DURATION: 5000 }
  });
  chk("养号下发成功", r1.ok, true);
  chk("拿到 script_run_id", r1.data?.script_run_id, "dayil_work_test");
  chk("请求到达了 agent", agentReceived.length, before + 1);
  chk("agent 收到的设备正确", agentReceived[before].payload.device_ids, [SERIALS.cust1A, SERIALS.cust1B]);
  chk("agent 收到 allowedDeviceIds", agentReceived[before].allowedDeviceIds.sort(), [SERIALS.cust1A, SERIALS.cust1B].sort());
  chk("config 原样透传", agentReceived[before].payload.config.SWIPE_COUNT, 30);

  // ══════════════ 2. 越权：操作他人设备 ══════════════
  console.log("--- 2. 越权下发 ---");

  const before2 = agentReceived.length;
  const r2 = await requestAutomation(v1, "dayil-work.start", { device_ids: [SERIALS.cust2A] });
  chk("越权被拒", r2.ok, false);
  chk("错误信息可读", /无权操作/.test(r2.error ?? ""), true);
  await sleep(300);
  chk("越权请求**没有**到达 agent", agentReceived.length, before2);

  // ══════════════ 3. 缺权限被拒 ══════════════
  console.log("--- 3. 能力开关 ---");

  const before3 = agentReceived.length;
  const r3 = await requestAutomation(v2, "dayil-work.start", { device_ids: [SERIALS.cust2A] });
  chk("无 can_run_dayil 被拒", r3.ok, false);
  chk("提示缺权限", /权限/.test(r3.error ?? ""), true);
  await sleep(300);
  chk("缺权限请求未到达 agent", agentReceived.length, before3);

  const r3b = await requestAutomation(v2, "send-video.start", { device_ids: [SERIALS.cust2A] });
  chk("无 can_send_video 被拒", r3b.ok, false);

  // ══════════════ 4. 结果按设备集过滤（核心）══════════════
  console.log("--- 4. 结果过滤（autojs 返回全局视图）---");

  const status1 = await requestAutomation(v1, "run-status", {});
  chk("cust1 的 run-status 成功", status1.ok, true);
  chk("cust1 只看到自己 2 条", status1.data?.entries?.length, 2);
  chk(
    "cust1 看不到 cust2 的任务",
    status1.data?.entries?.some((e) => e.deviceId === SERIALS.cust2A),
    false
  );
  chk("顶层计数也被收窄", status1.data?.taskCount, 2);

  const statusAdmin = await requestAutomation(vAdmin, "run-status", {});
  chk("管理员看到全部 3 条", statusAdmin.data?.entries?.length, 3);

  const acc1 = await requestAutomation(v1, "accounts", {});
  chk("cust1 的 accounts 成功", acc1.ok, true);
  chk("cust1 只看到自己 2 个账号", acc1.data?.length, 2);
  chk(
    "cust1 看不到 cust2 的账号",
    acc1.data?.some((a) => a.username === "acc_cust2_a"),
    false
  );
  chk(
    "无归属设备的账号对客户不可见",
    acc1.data?.some((a) => a.username === "acc_no_device"),
    false
  );

  const accAdmin = await requestAutomation(vAdmin, "accounts", {});
  chk("管理员看到全部 4 个账号", accAdmin.data?.length, 4);

  const health1 = await requestAutomation(v1, "health", {});
  chk("health 可达", health1.ok, true);

  // ══════════════ 5. 参数校验 ══════════════
  console.log("--- 5. 参数校验 ---");

  const r5 = await requestAutomation(v1, "dayil-work.start", {});
  chk("缺 device_ids 被拒", r5.ok, false);
  chk("提示 device_ids 不能为空", /device_ids/.test(r5.error ?? ""), true);

  const r6 = await requestAutomation(v1, "rm-rf", {});
  chk("未知动作被拒（白名单）", r6.ok, false);
  chk("提示不支持的动作", /不支持/.test(r6.error ?? ""), true);

  // ══════════════ 6. 重复 requestId / 超时兜底 ══════════════
  console.log("--- 6. 关联与清理 ---");

  const dupId = "dup-request-id";
  v1.send({ type: "automation", requestId: dupId, action: "health", payload: {} });
  const first = await v1.waitFor((m) => m.type === "automation-result" && m.requestId === dupId);
  chk("同 id 第一次有结果", first?.ok, true);

  v1.close();
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
