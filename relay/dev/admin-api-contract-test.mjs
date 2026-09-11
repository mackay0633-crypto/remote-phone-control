/**
 * 管理页面接口契约测试。
 *
 * 前端无法在受限沙箱内启动（Vite 需要 esbuild 子进程），
 * 但页面依赖的**响应结构**可以在这里逐字段验证——
 * 结构不对 UI 会静默出错（显示 undefined、按钮判断失效），比报错更难查。
 *
 * 运行：
 *   cd relay
 *   node --import ./dev/register.mjs src/main.ts        # 另开窗口
 *   node dev/admin-api-contract-test.mjs
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startFakeAgent(serials) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/agent`);
    ws.on("open", () => {
      const devices = serials.map((serial) => ({
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
  });
}

async function main() {
  // 测试专用网段，与真实设备无关
  const serials = [51, 52, 53].map((n) => `10.99.0.${n}:65535`);

  console.log(`目标 relay: ${BASE}\n`);

  const agent = await startFakeAgent(serials);
  await sleep(300);

  const login = await api("POST", "/api/auth/login", ADMIN);
  if (login.status !== 200) {
    throw new Error(`管理员登录失败: ${login.status}`);
  }
  const token = login.body.token;

  // 幂等：先把本测试用的设备从任何归属中释放，保证可重复运行
  for (const serial of serials) {
    await api("POST", `/api/admin/devices/${encodeURIComponent(serial)}/assign`, { userId: null }, token);
  }

  // 每次运行用不同的用户名，保证测试可重复执行（共用库时不会撞 409）
  const username = `shop${Date.now().toString(36).slice(-6)}`;
  const register = await api("POST", "/api/auth/register", { username, password: "CustomerPass123" });

  if (register.status !== 201) {
    console.error(`\n注册测试账号失败（HTTP ${register.status}）：${JSON.stringify(register.body)}`);
    if (register.status === 429) {
      console.error("这是注册限流。放宽后重试：$env:REGISTER_MAX_ATTEMPTS='1000'");
    }
    process.exit(1);
  }

  // ══════════════ 1. /api/admin/meta ══════════════
  console.log("--- 1. 权限元数据（渲染勾选框用）---");
  const meta = await api("GET", "/api/admin/meta", undefined, token);
  chk("meta HTTP 200", meta.status, 200);
  chk("meta.capabilities 是数组", Array.isArray(meta.body.capabilities), true);
  chk("meta 有 6 个能力", meta.body.capabilities.length, 6);
  chk(
    "每项含 key 与 label",
    meta.body.capabilities.every((c) => typeof c.key === "string" && typeof c.label === "string"),
    true
  );
  const keys = meta.body.capabilities.map((c) => c.key);
  chk("含 can_view_devices", keys.includes("can_view_devices"), true);
  chk("含 can_control_input", keys.includes("can_control_input"), true);

  // ══════════════ 2. /api/admin/users ══════════════
  console.log("--- 2. 客户列表（渲染卡片用）---");
  const usersRes = await api("GET", "/api/admin/users", undefined, token);
  const users = usersRes.body.users;
  const shop1 = users.find((u) => u.username === username);

  chk("users 是数组", Array.isArray(users), true);
  chk("含新注册客户", shop1 !== undefined, true);
  chk("deviceCount 是数字", typeof shop1.deviceCount, "number");
  chk("status 是字符串", typeof shop1.status, "string");
  chk("capabilities.can_view_devices 是布尔", typeof shop1.capabilities.can_view_devices, "boolean");
  chk("capabilities 含全部 6 项", Object.keys(shop1.capabilities).length, 6);
  chk("quota.maxDevices 是数字", typeof shop1.quota.maxDevices, "number");
  chk("quota.maxConcurrentTasks 是数字", typeof shop1.quota.maxConcurrentTasks, "number");
  chk("quota.maxStorageBytes 是数字", typeof shop1.quota.maxStorageBytes, "number");
  chk("不含 passwordHash 字段", "passwordHash" in shop1, false);

  // ══════════════ 3. /api/admin/devices ══════════════
  console.log("--- 3. 设备列表（渲染分配表格用）---");
  const devicesRes = await api("GET", "/api/admin/devices", undefined, token);
  const devices = devicesRes.body.devices;

  // 只断言本测试自己的设备：与其它测试共用同一个库时不会被干扰
  const own = devices.filter((d) => serials.includes(d.serial));

  chk("devices 是数组", Array.isArray(devices), true);
  chk("本测试的 3 台设备都在列表里", own.length, 3);
  chk("serial 是字符串", typeof own[0].serial, "string");
  chk("online 是布尔", typeof own[0].online, "boolean");
  chk("online 为 true（agent 已连接）", own[0].online, true);
  chk("assignedUserId 初始为 null", own[0].assignedUserId, null);
  chk("assignedUsername 初始为 null", own[0].assignedUsername, null);

  // ══════════════ 4. 改权限 ══════════════
  console.log("--- 4. 权限开关 ---");
  const setCaps = await api(
    "PATCH",
    `/api/admin/users/${shop1.id}`,
    { capabilities: { can_view_devices: true, can_view_stream: true, can_control_input: true } },
    token
  );
  chk("改权限 HTTP 200", setCaps.status, 200);
  chk("返回值含 user", typeof setCaps.body.user, "object");
  chk("回读 can_view_devices", setCaps.body.user.capabilities.can_view_devices, true);
  chk("未提及的字段保持关闭", setCaps.body.user.capabilities.can_send_video, false);
  chk("返回 changes 供界面提示", typeof setCaps.body.changes, "object");

  // ══════════════ 5. 改配额 ══════════════
  console.log("--- 5. 配额 ---");
  const setQuota = await api(
    "PATCH",
    `/api/admin/users/${shop1.id}`,
    { quota: { maxDevices: 2, maxStorageBytes: 1048576 } },
    token
  );
  chk("改配额 HTTP 200", setQuota.status, 200);
  chk("回读 maxDevices", setQuota.body.user.quota.maxDevices, 2);
  chk("回读 maxStorageBytes", setQuota.body.user.quota.maxStorageBytes, 1048576);

  const badQuota = await api("PATCH", `/api/admin/users/${shop1.id}`, { quota: { maxDevices: -1 } }, token);
  chk("负数配额被拒 400", badQuota.status, 400);

  const emptyPatch = await api("PATCH", `/api/admin/users/${shop1.id}`, {}, token);
  chk("空变更被拒 400", emptyPatch.status, 400);

  // ══════════════ 6. 分配设备 ══════════════
  console.log("--- 6. 设备分配 ---");
  const a1 = await api("POST", `/api/admin/devices/${encodeURIComponent(serials[0])}/assign`, { userId: shop1.id }, token);
  chk("分配第 1 台 200", a1.status, 200);

  const a2 = await api("POST", `/api/admin/devices/${encodeURIComponent(serials[1])}/assign`, { userId: shop1.id }, token);
  chk("分配第 2 台 200", a2.status, 200);

  const a3 = await api("POST", `/api/admin/devices/${encodeURIComponent(serials[2])}/assign`, { userId: shop1.id }, token);
  chk("分配第 3 台超配额 400", a3.status, 400);
  chk("超配额错误信息可读", /超出配额/.test(a3.body.error ?? ""), true);

  const devicesAfter = (await api("GET", "/api/admin/devices", undefined, token)).body.devices;
  const mine = devicesAfter.filter((d) => d.assignedUserId === shop1.id);
  chk("归属已写入", mine.length, 2);
  chk("表格能显示归属用户名", mine[0].assignedUsername, username);
  chk("已分配设备 online 仍为 true", mine[0].online, true);

  const usersAfter = (await api("GET", "/api/admin/users", undefined, token)).body.users;
  chk("客户卡片显示已用数量", usersAfter.find((u) => u.id === shop1.id).deviceCount, 2);

  // ══════════════ 7. 收回设备 ══════════════
  console.log("--- 7. 收回设备 ---");
  const release = await api(
    "POST",
    `/api/admin/devices/${encodeURIComponent(serials[0])}/assign`,
    { userId: null },
    token
  );
  chk("收回 HTTP 200", release.status, 200);

  const afterRelease = (await api("GET", "/api/admin/devices", undefined, token)).body.devices;
  chk("该设备已回到空闲", afterRelease.find((d) => d.serial === serials[0]).assignedUserId, null);
  chk(
    "客户已用数量减 1",
    (await api("GET", "/api/admin/users", undefined, token)).body.users.find((u) => u.id === shop1.id).deviceCount,
    1
  );

  const badAssign = await api(
    "POST",
    `/api/admin/devices/${encodeURIComponent(serials[0])}/assign`,
    { userId: 999999 },
    token
  );
  chk("不存在的用户被拒 400", badAssign.status, 400);

  // ══════════════ 8. 禁用 / 启用 ══════════════
  console.log("--- 8. 禁用与启用 ---");
  const disable = await api("PATCH", `/api/admin/users/${shop1.id}`, { status: "disabled" }, token);
  chk("禁用 HTTP 200", disable.status, 200);
  chk("回读状态", disable.body.user.status, "disabled");
  chk("报告吊销的会话数", typeof disable.body.changes.revokedSessions, "number");

  const enable = await api("PATCH", `/api/admin/users/${shop1.id}`, { status: "active" }, token);
  chk("启用 HTTP 200", enable.status, 200);
  chk("回读状态", enable.body.user.status, "active");

  const badStatus = await api("PATCH", `/api/admin/users/${shop1.id}`, { status: "whatever" }, token);
  chk("非法状态被拒 400", badStatus.status, 400);

  // ══════════════ 9. 审计日志 ══════════════
  console.log("--- 9. 审计日志 ---");
  const audit = await api("GET", "/api/admin/audit?limit=200", undefined, token);
  chk("audit HTTP 200", audit.status, 200);
  chk("entries 是数组", Array.isArray(audit.body.entries), true);

  const entry = audit.body.entries[0];
  chk("含 created_at（用于渲染时间）", typeof entry.created_at, "string");
  chk("含 actor_username", "actor_username" in entry, true);
  chk("含 action", typeof entry.action, "string");
  chk("含 target", "target" in entry, true);

  const actions = audit.body.entries.map((e) => e.action);
  chk("记录了分配动作", actions.includes("admin.device_assigned"), true);
  chk("记录了收回动作", actions.includes("admin.device_released"), true);
  chk("记录了权限变更", actions.includes("admin.user_updated"), true);

  // ══════════════ 10. 非管理员不得访问 ══════════════
  console.log("--- 10. 非管理员访问管理端 ---");
  const shopToken = (await api("POST", "/api/auth/login", { username, password: "CustomerPass123" })).body.token;
  chk("客户访问 users 403", (await api("GET", "/api/admin/users", undefined, shopToken)).status, 403);
  chk("客户访问 devices 403", (await api("GET", "/api/admin/devices", undefined, shopToken)).status, 403);
  chk("客户访问 meta 403", (await api("GET", "/api/admin/meta", undefined, shopToken)).status, 403);
  chk(
    "客户尝试改权限 403",
    (await api("PATCH", `/api/admin/users/${shop1.id}`, { capabilities: { can_send_video: true } }, shopToken)).status,
    403
  );
  chk(
    "客户尝试自分配设备 403",
    (await api("POST", `/api/admin/devices/${encodeURIComponent(serials[2])}/assign`, { userId: shop1.id }, shopToken))
      .status,
    403
  );

  agent.close();

  console.log(`\n=========== pass=${pass}  fail=${fail} ===========`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\n测试执行失败:", error);
  process.exit(1);
});
