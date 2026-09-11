import type { IncomingMessage, ServerResponse } from "node:http";
import type { Database } from "../db/database.js";
import {
  authenticate,
  countAdmins,
  createUser,
  findUserById,
  hasCapability,
  listUsers,
  setUserCapabilities,
  setUserPassword,
  setUserQuota,
  setUserStatus,
  toPublicUser,
  validatePassword,
  validateUsername,
  type UserRecord
} from "../auth/users.js";
import {
  createSession,
  resolveSession,
  revokeAllSessionsForUser,
  revokeSession
} from "../auth/sessions.js";
import { CAPABILITIES, CAPABILITY_LABELS, type CapabilitySet } from "../auth/capabilities.js";
import { assignDevice, listAllDevices, listDevicesForUser, releaseAllDevices } from "../devices/store.js";
import { writeAudit } from "../db/audit.js";
import { bumpAccessEpoch } from "../access/epoch.js";

export interface ApiContext {
  db: Database;
  /** 当前由已连接 Agent 上报的设备，用于给管理页面标注在线状态 */
  getOnlineSerials: () => Set<string>;
  /**
   * 访问控制发生变化时的回调（分配设备、开关能力、禁用账号……）。
   *
   * 由 relay 主进程提供，用于**立刻重新校验所有已建立的 WebSocket 连接**。
   * 没有它的话，管理页面刚关掉的权限对已连接的客户无效。
   */
  onAccessChanged?: () => void;
}

/**
 * 任何影响访问控制的写操作都必须调用它。
 *
 * 两件事：让权限缓存失效（纪元 +1），并让 relay 立刻重校验在线连接。
 */
function notifyAccessChanged(ctx: ApiContext): void {
  bumpAccessEpoch();
  ctx.onAccessChanged?.();
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * 登录 / 注册限流参数（可用环境变量调整）。
 *
 * 默认值面向生产：登录每 IP 每 15 分钟 10 次。
 * 但**跑自动化测试时会很快撞上**——测试脚本反复登录同一个 IP，
 * 所以这里做成可配置的。
 */
const LOGIN_MAX_ATTEMPTS = Math.max(1, Number(process.env.LOGIN_MAX_ATTEMPTS ?? "10") || 10);
const LOGIN_WINDOW_MS = Math.max(
  60_000,
  (Number(process.env.LOGIN_WINDOW_MINUTES ?? "15") || 15) * 60_000
);
const REGISTER_MAX_ATTEMPTS = Math.max(1, Number(process.env.REGISTER_MAX_ATTEMPTS ?? "10") || 10);
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

// ─────────────────────────────── 基础设施 ───────────────────────────────

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function fail(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { error });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;

    if (total > MAX_BODY_BYTES) {
      throw Object.assign(new Error("请求体过大"), { statusCode: 413 });
    }

    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { statusCode: 400 });
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket.remoteAddress ?? "unknown";
}

/**
 * 内存态限流。
 *
 * 只为挡住在线暴力破解，重启即清空——这是刻意的取舍：
 * 引入持久化计数器会让登录路径多一次写库，收益不成正比。
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

function allowRequest(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) {
        if (v.resetAt <= now) {
          buckets.delete(k);
        }
      }
    }

    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (bucket.count >= limit) {
    return false;
  }

  bucket.count += 1;
  return true;
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return "";
  }

  return header.slice("Bearer ".length).trim();
}

interface AuthResult {
  user: UserRecord;
  token: string;
}

function resolveAuth(ctx: ApiContext, req: IncomingMessage): AuthResult | null {
  const token = bearerToken(req);
  if (!token) {
    return null;
  }

  const session = resolveSession(ctx.db, token);
  if (!session) {
    return null;
  }

  const user = findUserById(ctx.db, session.userId);
  if (!user || user.status !== "active") {
    return null;
  }

  return { user, token };
}

/**
 * 供 relay 主模块复用的管理员守卫。
 *
 * 用于主模块自己处理的 `/api/devices`——那个接口原本无鉴权，
 * 会把全部设备暴露给任何能连上服务器的人。
 * 成功返回用户，失败时已写出响应，调用方直接 return 即可。
 */
export function requireAdmin(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse
): UserRecord | null {
  const auth = resolveAuth(ctx, req);

  if (!auth) {
    fail(res, 401, "未登录或会话已过期");
    return null;
  }

  if (auth.user.role !== "admin") {
    writeAudit(ctx.db, auth.user.id, "admin.denied", req.url ?? "", null);
    fail(res, 403, "需要管理员权限");
    return null;
  }

  return auth.user;
}

// ─────────────────────────────── 路由 ───────────────────────────────

/**
 * 处理 /api 下的请求。返回 true 表示已响应，调用方不应再走 404。
 *
 * 注意：这里只做**认证与账号/设备管理**。
 * 真正决定「能不能看画面、能不能操控」的隔离校验在 WebSocket 通道那一侧，
 * 本文件里的能力检查只用于过滤读取接口。
 */
export async function handleApiRequest(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (!path.startsWith("/api/")) {
    return false;
  }

  try {
    // ── 公开接口 ──────────────────────────────────────────────
    if (method === "POST" && path === "/api/auth/register") {
      await handleRegister(ctx, req, res);
      return true;
    }

    if (method === "POST" && path === "/api/auth/login") {
      await handleLogin(ctx, req, res);
      return true;
    }

    // ── 需要登录 ──────────────────────────────────────────────
    const auth = resolveAuth(ctx, req);

    const isPublic = path === "/api/auth/register" || path === "/api/auth/login";
    if (!isPublic && !auth) {
      fail(res, 401, "未登录或会话已过期");
      return true;
    }

    if (auth) {
      // 会话有效但账号被禁用的情况已在 resolveAuth 里挡掉
      if (method === "POST" && path === "/api/auth/logout") {
        revokeSession(ctx.db, auth.token);
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (method === "GET" && path === "/api/auth/me") {
        sendJson(res, 200, { user: toPublicUser(auth.user) });
        return true;
      }

      if (method === "POST" && path === "/api/auth/password") {
        await handleChangeOwnPassword(ctx, req, res, auth);
        return true;
      }

      if (method === "GET" && path === "/api/my/devices") {
        handleMyDevices(ctx, res, auth);
        return true;
      }

      // ── 管理端 ─────────────────────────────────────────────
      if (path.startsWith("/api/admin/")) {
        if (auth.user.role !== "admin") {
          writeAudit(ctx.db, auth.user.id, "admin.denied", path, null);
          fail(res, 403, "需要管理员权限");
          return true;
        }

        await handleAdmin(ctx, req, res, auth, path, method);
        return true;
      }
    }

    return false;
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : String(error);
    if (status >= 500) {
      console.error(`[api] ${method} ${path} failed: ${message}`);
    }
    fail(res, status, message);
    return true;
  }
}

// ─────────────────────────────── 认证 ───────────────────────────────

async function handleRegister(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = clientIp(req);
  if (!allowRequest(`register:${ip}`, REGISTER_MAX_ATTEMPTS, REGISTER_WINDOW_MS)) {
    fail(res, 429, "注册过于频繁，请稍后再试");
    return;
  }

  const body = asObject(await readJsonBody(req));
  const usernameError = validateUsername(body.username);
  if (usernameError) {
    fail(res, 400, usernameError);
    return;
  }

  const passwordError = validatePassword(body.password);
  if (passwordError) {
    fail(res, 400, passwordError);
    return;
  }

  const username = String(body.username);

  try {
    // 自助注册一律是 customer，且所有能力默认关闭——在管理员分配之前什么也做不了
    const user = await createUser(ctx.db, { username, password: String(body.password), role: "customer" });
    writeAudit(ctx.db, user.id, "auth.register", username, { ip });
    sendJson(res, 201, { user: toPublicUser(user) });
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      fail(res, 409, "用户名已被占用");
      return;
    }
    throw error;
  }
}

async function handleLogin(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = asObject(await readJsonBody(req));
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!username || !password) {
    fail(res, 400, "请提供用户名和密码");
    return;
  }

  // 按 用户名 + IP 双维度限流：只按 IP 会被分布式绕过，只按用户名会被人拿来锁定他人账号
  const ip = clientIp(req);
  const keys = [`login:u:${username.toLowerCase()}`, `login:ip:${ip}`];
  if (keys.some((key) => !allowRequest(key, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS))) {
    writeAudit(ctx.db, null, "auth.login_ratelimited", username, { ip });
    fail(res, 429, `登录尝试过多，请 ${Math.round(LOGIN_WINDOW_MS / 60_000)} 分钟后再试`);
    return;
  }

  const user = await authenticate(ctx.db, username, password);

  if (!user) {
    writeAudit(ctx.db, null, "auth.login_failed", username, { ip });
    fail(res, 401, "用户名或密码错误");
    return;
  }

  if (user.status !== "active") {
    writeAudit(ctx.db, user.id, "auth.login_disabled", username, { ip });
    fail(res, 403, "账号已被禁用，请联系管理员");
    return;
  }

  const session = createSession(ctx.db, user.id);
  writeAudit(ctx.db, user.id, "auth.login", username, { ip });

  sendJson(res, 200, {
    token: session.token,
    expiresAt: session.expiresAt,
    user: toPublicUser(user)
  });
}

async function handleChangeOwnPassword(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthResult
): Promise<void> {
  const body = asObject(await readJsonBody(req));

  const verified = await authenticate(ctx.db, auth.user.username, String(body.currentPassword ?? ""));
  if (!verified) {
    fail(res, 401, "当前密码不正确");
    return;
  }

  const passwordError = validatePassword(body.newPassword);
  if (passwordError) {
    fail(res, 400, passwordError);
    return;
  }

  await setUserPassword(ctx.db, auth.user.id, String(body.newPassword));

  // 改密后吊销所有会话，再给当前设备补发一个，避免把自己踢下线
  revokeAllSessionsForUser(ctx.db, auth.user.id);
  const session = createSession(ctx.db, auth.user.id);

  writeAudit(ctx.db, auth.user.id, "auth.password_changed", auth.user.username, null);

  sendJson(res, 200, { ok: true, token: session.token, expiresAt: session.expiresAt });
}

function handleMyDevices(ctx: ApiContext, res: ServerResponse, auth: AuthResult): void {
  if (!hasCapability(auth.user, "can_view_devices")) {
    // 没有基础能力就看不到任何设备，但返回空列表而非 403 ——
    // 前端据此显示「等待管理员分配」，比直接报错友好
    sendJson(res, 200, { devices: [], permissionDenied: true });
    return;
  }

  const online = ctx.getOnlineSerials();
  const devices = listDevicesForUser(ctx.db, auth.user.id).map((device) => ({
    serial: device.serial,
    online: online.has(device.serial),
    assignedAt: device.assignedAt
  }));

  sendJson(res, 200, { devices });
}

// ─────────────────────────────── 管理端 ───────────────────────────────

async function handleAdmin(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthResult,
  path: string,
  method: string
): Promise<void> {
  // 能力定义，供管理页面渲染勾选框
  if (method === "GET" && path === "/api/admin/meta") {
    sendJson(res, 200, {
      capabilities: CAPABILITIES.map((key) => ({ key, label: CAPABILITY_LABELS[key] }))
    });
    return;
  }

  if (method === "GET" && path === "/api/admin/users") {
    sendJson(res, 200, { users: listUsers(ctx.db) });
    return;
  }

  if (method === "POST" && path === "/api/admin/users") {
    const body = asObject(await readJsonBody(req));
    const usernameError = validateUsername(body.username);
    if (usernameError) {
      fail(res, 400, usernameError);
      return;
    }

    const passwordError = validatePassword(body.password);
    if (passwordError) {
      fail(res, 400, passwordError);
      return;
    }

    try {
      const user = await createUser(ctx.db, {
        username: String(body.username),
        password: String(body.password),
        role: "customer"
      });
      writeAudit(ctx.db, auth.user.id, "admin.user_created", user.username, null);
      sendJson(res, 201, { user: toPublicUser(user) });
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        fail(res, 409, "用户名已被占用");
        return;
      }
      throw error;
    }
    return;
  }

  const userMatch = path.match(/^\/api\/admin\/users\/(\d+)$/);
  if (userMatch && method === "PATCH") {
    await handleAdminPatchUser(ctx, req, res, auth, Number(userMatch[1]));
    return;
  }

  const passwordMatch = path.match(/^\/api\/admin\/users\/(\d+)\/password$/);
  if (passwordMatch && method === "POST") {
    await handleAdminResetPassword(ctx, req, res, auth, Number(passwordMatch[1]));
    return;
  }

  if (userMatch && method === "DELETE") {
    handleAdminDeleteUser(ctx, res, auth, Number(userMatch[1]));
    return;
  }

  if (method === "GET" && path === "/api/admin/devices") {
    sendJson(res, 200, { devices: listAllDevices(ctx.db, ctx.getOnlineSerials()) });
    return;
  }

  const assignMatch = path.match(/^\/api\/admin\/devices\/([^/]+)\/assign$/);
  if (assignMatch && method === "POST") {
    await handleAdminAssignDevice(ctx, req, res, auth, decodeURIComponent(assignMatch[1]));
    return;
  }

  if (method === "GET" && path === "/api/admin/audit") {
    const limit = Math.min(Number(new URL(req.url ?? "/", "http://x").searchParams.get("limit") ?? 100) || 100, 500);
    const rows = ctx.db
      .prepare(
        "SELECT a.id, a.actor_user_id, u.username AS actor_username, a.action, a.target, a.detail, a.created_at " +
          "FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id " +
          "ORDER BY a.id DESC LIMIT ?"
      )
      .all(limit);

    sendJson(res, 200, { entries: rows });
    return;
  }

  fail(res, 404, "接口不存在");
}

async function handleAdminPatchUser(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthResult,
  userId: number
): Promise<void> {
  const target = findUserById(ctx.db, userId);
  if (!target) {
    fail(res, 404, "用户不存在");
    return;
  }

  const body = asObject(await readJsonBody(req));
  const changes: Record<string, unknown> = {};

  // 能力开关
  const rawCapabilities = body.capabilities;
  if (rawCapabilities !== undefined) {
    const patch: Partial<CapabilitySet> = {};
    const source = asObject(rawCapabilities);

    for (const capability of CAPABILITIES) {
      const value = source[capability];
      if (value !== undefined) {
        patch[capability] = value === true;
      }
    }

    if (Object.keys(patch).length > 0) {
      setUserCapabilities(ctx.db, userId, patch);
      changes.capabilities = patch;
    }
  }

  // 配额
  const rawQuota = asObject(body.quota);
  if (Object.keys(rawQuota).length > 0) {
    const quota: { maxDevices?: number; maxConcurrentTasks?: number; maxStorageBytes?: number } = {};

    for (const key of ["maxDevices", "maxConcurrentTasks", "maxStorageBytes"] as const) {
      const value = rawQuota[key];
      if (value === undefined) {
        continue;
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        fail(res, 400, `quota.${key} 必须是非负数字`);
        return;
      }
      quota[key] = Math.trunc(value);
    }

    if (Object.keys(quota).length > 0) {
      setUserQuota(ctx.db, userId, quota);
      changes.quota = quota;
    }
  }

  // 状态
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled") {
      fail(res, 400, "status 只能是 active 或 disabled");
      return;
    }

    // 不允许把最后一个管理员禁用，否则管理后台会被锁死
    if (target.role === "admin" && body.status === "disabled" && countAdmins(ctx.db) <= 1) {
      fail(res, 400, "不能禁用最后一个管理员账号");
      return;
    }

    setUserStatus(ctx.db, userId, body.status);
    changes.status = body.status;

    // 禁用即刻吊销所有会话——否则已登录的连接能一直用到会话过期
    if (body.status === "disabled") {
      const revoked = revokeAllSessionsForUser(ctx.db, userId);
      changes.revokedSessions = revoked;
    }
  }

  if (Object.keys(changes).length === 0) {
    fail(res, 400, "没有可应用的变更");
    return;
  }

  // 权限或归属变了：让所有在线连接立刻重新校验
  notifyAccessChanged(ctx);
  writeAudit(ctx.db, auth.user.id, "admin.user_updated", target.username, changes);

  const updated = findUserById(ctx.db, userId);
  sendJson(res, 200, { user: updated ? toPublicUser(updated) : null, changes });
}

async function handleAdminResetPassword(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthResult,
  userId: number
): Promise<void> {
  const target = findUserById(ctx.db, userId);
  if (!target) {
    fail(res, 404, "用户不存在");
    return;
  }

  const body = asObject(await readJsonBody(req));
  const passwordError = validatePassword(body.password);
  if (passwordError) {
    fail(res, 400, passwordError);
    return;
  }

  await setUserPassword(ctx.db, userId, String(body.password));
  const revoked = revokeAllSessionsForUser(ctx.db, userId);

  notifyAccessChanged(ctx);
  writeAudit(ctx.db, auth.user.id, "admin.password_reset", target.username, { revokedSessions: revoked });

  sendJson(res, 200, { ok: true, revokedSessions: revoked });
}

function handleAdminDeleteUser(ctx: ApiContext, res: ServerResponse, auth: AuthResult, userId: number): void {
  const target = findUserById(ctx.db, userId);
  if (!target) {
    fail(res, 404, "用户不存在");
    return;
  }

  if (target.role === "admin" && countAdmins(ctx.db) <= 1) {
    fail(res, 400, "不能删除最后一个管理员账号");
    return;
  }

  // 先收回设备再删账号，避免留下悬空的归属
  const released = releaseAllDevices(ctx.db, userId);
  ctx.db.prepare("DELETE FROM users WHERE id = ?").run(userId);

  notifyAccessChanged(ctx);
  writeAudit(ctx.db, auth.user.id, "admin.user_deleted", target.username, { releasedDevices: released });

  sendJson(res, 200, { ok: true, releasedDevices: released });
}

async function handleAdminAssignDevice(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthResult,
  serial: string
): Promise<void> {
  const body = asObject(await readJsonBody(req));
  const rawUserId = body.userId;

  let userId: number | null;
  if (rawUserId === null || rawUserId === undefined) {
    userId = null;
  } else if (typeof rawUserId === "number" && Number.isInteger(rawUserId) && rawUserId > 0) {
    userId = rawUserId;
  } else {
    fail(res, 400, "userId 必须是正整数，传 null 表示收回");
    return;
  }

  const result = assignDevice(ctx.db, serial, userId);
  if (!result.ok) {
    writeAudit(ctx.db, auth.user.id, "admin.device_assign_failed", serial, {
      userId,
      error: result.error
    });
    fail(res, 400, result.error);
    return;
  }

  // 归属变了：立刻让相关连接的可见设备集刷新
  notifyAccessChanged(ctx);
  writeAudit(ctx.db, auth.user.id, userId === null ? "admin.device_released" : "admin.device_assigned", serial, {
    userId
  });

  sendJson(res, 200, { ok: true, serial, userId });
}
