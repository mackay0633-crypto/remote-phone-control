import type { IncomingMessage, ServerResponse } from "node:http";
import { nowIso, type Database } from "../db/database.js";
import {
  authenticate,
  countAdmins,
  createUser,
  findUserByEmail,
  findUserById,
  findUserByUsername,
  hasCapability,
  listUsers,
  normalizeEmail,
  setUserCapabilities,
  setUserEmail,
  setUserPassword,
  setUserQuota,
  setUserStatus,
  toPublicUser,
  validateEmail,
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
import type { Mailer } from "../mail/mailer.js";
import {
  CODE_LENGTH,
  CODE_TTL_MS,
  RESEND_COOLDOWN_MS,
  cooldownRemainingMs,
  consumeCode,
  describeFailure,
  issueVerificationCode,
  verifyCode,
  type VerificationPurpose
} from "../auth/emailVerification.js";

export interface ApiContext {
  db: Database;
  /** 邮件发送通道。注册验证码经由它发出，测试环境是 console 实现 */
  mailer: Mailer;
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

/**
 * 验证码发送限流：按 IP 与邮箱双维度各 5 次 / 15 分钟。
 *
 * 双维度是必须的：只按 IP，攻击者换代理就能把别人的邮箱当炮台刷；
 * 只按邮箱，分布式 IP 一样能刷爆。真实用户正常注册只会用到 1~2 次。
 */
const REGCODE_MAX_ATTEMPTS = Math.max(1, Number(process.env.REGCODE_MAX_ATTEMPTS ?? "5") || 5);
const REGCODE_WINDOW_MS = 15 * 60 * 1000;

/** 找回密码的「提交新密码」这一步单独限流，防拿验证码接口当猜码器 */
const RESET_MAX_ATTEMPTS = Math.max(1, Number(process.env.RESET_MAX_ATTEMPTS ?? "10") || 10);
const RESET_WINDOW_MS = 60 * 60 * 1000;

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
    if (method === "POST" && path === "/api/auth/register/code") {
      await handleRegisterCode(ctx, req, res);
      return true;
    }

    if (method === "POST" && path === "/api/auth/register") {
      await handleRegister(ctx, req, res);
      return true;
    }

    if (method === "POST" && path === "/api/auth/login") {
      await handleLogin(ctx, req, res);
      return true;
    }

    if (method === "POST" && path === "/api/auth/password/reset/code") {
      await handlePasswordResetCode(ctx, req, res);
      return true;
    }

    if (method === "POST" && path === "/api/auth/password/reset") {
      await handlePasswordReset(ctx, req, res);
      return true;
    }

    // ── 需要登录 ──────────────────────────────────────────────
    const auth = resolveAuth(ctx, req);

    const isPublic =
      path === "/api/auth/register" ||
      path === "/api/auth/register/code" ||
      path === "/api/auth/password/reset" ||
      path === "/api/auth/password/reset/code" ||
      path === "/api/auth/login";
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

      if (method === "POST" && path === "/api/auth/email/code") {
        await handleEmailChangeCode(ctx, req, res, auth);
        return true;
      }

      if (method === "POST" && path === "/api/auth/email") {
        await handleEmailChange(ctx, req, res, auth);
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

/**
 * UNIQUE 约束冲突时区分是用户名还是邮箱，好给出准确提示。
 *
 * better-sqlite3 的报错形如 `UNIQUE constraint failed: users.email`，
 * 直接匹配字段名即可；匹配不到就退回一句模糊的提示。
 */
function uniqueConflictMessage(error: unknown): string | null {
  const text = String(error);
  if (!text.includes("UNIQUE")) {
    return null;
  }

  if (text.includes("users.email")) {
    return "该邮箱已被注册，请直接登录或使用其它邮箱";
  }

  if (text.includes("users.username")) {
    return "用户名已被占用";
  }

  return "用户名或邮箱已被占用";
}

/**
 * 验证码发送的公共部分：限流 → 冷却 → 签发 → （可选）定投 → 审计 → 响应。
 *
 * 「注册 / 找回密码 / 换绑邮箱」三条流程的差别只在文案与是否定投，
 * 其余规则必须一致——分开写三遍迟早会在某一条上漏掉冷却或限流。
 */
interface SendCodeOptions {
  purpose: VerificationPurpose;
  email: string;
  ip: string;
  /** 限流键前缀：按用途分开计数，注册的额度不会被找回密码吃掉 */
  ratePrefix: string;
  /** 审计动作前缀，实际写成 `${prefix}_sent` / `_failed` / `_ratelimited` */
  auditPrefix: string;
  subject: string;
  body: (code: string) => string[];
  /**
   * false = 只签发、不定投（「这个邮箱没有账号」时用）。
   *
   * 关键：**无论是否定投，响应体都完全一致**，否则这个接口就成了
   * 「某邮箱是否注册过」的查询工具。
   */
  deliver: boolean;
  /**
   * true = 不等邮件发完就响应。
   *
   * 找回密码必须用它：定投要走一次 SMTP 往返（几百毫秒），不定投则立刻返回，
   * 这个时间差本身就能用来判断邮箱是否注册过。代价是发信失败只能进日志与审计，
   * 没法当场告诉用户（用户收不到信自然会重试，而重试会撞上冷却/限流）。
   */
  background: boolean;
}

async function issueAndSendCode(
  ctx: ApiContext,
  res: ServerResponse,
  options: SendCodeOptions
): Promise<void> {
  const { email, ip } = options;

  if (
    !allowRequest(`${options.ratePrefix}:ip:${ip}`, REGCODE_MAX_ATTEMPTS, REGCODE_WINDOW_MS) ||
    !allowRequest(`${options.ratePrefix}:email:${email}`, REGCODE_MAX_ATTEMPTS, REGCODE_WINDOW_MS)
  ) {
    writeAudit(ctx.db, null, `${options.auditPrefix}_ratelimited`, email, { ip });
    fail(res, 429, "验证码发送过于频繁，请稍后再试");
    return;
  }

  const remaining = cooldownRemainingMs(ctx.db, email, options.purpose);
  if (remaining > 0) {
    fail(res, 429, `请 ${Math.ceil(remaining / 1000)} 秒后再获取验证码`);
    return;
  }

  const { code, expiresAt } = await issueVerificationCode(ctx.db, email, options.purpose);

  if (options.deliver) {
    const message = {
      to: email,
      subject: options.subject,
      text: options.body(code).join("\n")
    };

    const reportFailure = (error: unknown): void => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[api] 向 ${email} 发送验证码失败（${options.purpose}）: ${detail}`);
      writeAudit(ctx.db, null, `${options.auditPrefix}_failed`, email, { ip, error: detail });
    };

    if (options.background) {
      // 刻意不 await：见 SendCodeOptions.background 的说明
      void ctx.mailer.send(message).catch(reportFailure);
    } else {
      try {
        await ctx.mailer.send(message);
      } catch (error) {
        reportFailure(error);
        fail(res, 502, "验证码发送失败，请稍后重试或联系管理员");
        return;
      }
    }
  }

  writeAudit(ctx.db, null, `${options.auditPrefix}_sent`, email, { ip, delivered: options.deliver });

  /**
   * `devCode` 只在本地/测试的 console 模式下出现（见 mailer.ts），
   * 生产（NODE_ENV=production）永远不回显；
   * 没真正定投时也不回显——那种情况本来就没有码可填。
   */
  sendJson(res, 200, {
    ok: true,
    email,
    expiresAt,
    expiresInSeconds: Math.round(CODE_TTL_MS / 1000),
    resendAfterSeconds: Math.round(RESEND_COOLDOWN_MS / 1000),
    ...(ctx.mailer.exposesCodes && options.deliver ? { devCode: code } : {})
  });
}

/**
 * 注册第一步：发送注册验证码。
 *
 * 先证明邮箱可用再建号，这样库里不会留下「建了号但从没验证」的半成品账号，
 * 也不需要为了「待验证」状态去改 users.status 的 CHECK 约束。
 */
async function handleRegisterCode(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = asObject(await readJsonBody(req));

  const emailError = validateEmail(body.email);
  if (emailError) {
    fail(res, 400, emailError);
    return;
  }

  await issueAndSendCode(ctx, res, {
    purpose: "register",
    email: normalizeEmail(String(body.email)),
    ip: clientIp(req),
    ratePrefix: "regcode",
    auditPrefix: "auth.register_code",
    subject: "【Remote Phone Control】注册验证码",
    // 注册本来就要发给尚未注册的邮箱，不存在真假之分
    deliver: true,
    background: false,
    body: (code) => [
      `你的注册验证码是 ${code}`,
      "",
      `验证码 ${Math.round(CODE_TTL_MS / 60_000)} 分钟内有效，请勿转发给他人。`,
      "如果不是你本人操作，忽略这封邮件即可，你的邮箱不会被注册。"
    ]
  });
}

/**
 * 自助注册（第二步）：校验验证码后建号。
 *
 * 自助注册一律是 customer，且所有能力默认关闭——在管理员分配之前什么也做不了。
 */
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

  const emailError = validateEmail(body.email);
  if (emailError) {
    fail(res, 400, emailError);
    return;
  }

  const passwordError = validatePassword(body.password);
  if (passwordError) {
    fail(res, 400, passwordError);
    return;
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code)) {
    fail(res, 400, `请填写 ${CODE_LENGTH} 位数字验证码`);
    return;
  }

  const username = String(body.username);
  const email = normalizeEmail(String(body.email));

  // 先验码再查重：没通过邮箱验证的人，连「这个用户名/邮箱是否已存在」都问不出来
  const verdict = await verifyCode(ctx.db, email, "register", code);
  if (!verdict.ok) {
    writeAudit(ctx.db, null, "auth.register_code_rejected", email, { ip, reason: verdict.reason });
    fail(res, 400, describeFailure(verdict.reason));
    return;
  }

  // 占用冲突时**不消费验证码**：换个用户名还能接着用，不必重新收信
  if (findUserByUsername(ctx.db, username)) {
    fail(res, 409, "用户名已被占用");
    return;
  }

  if (findUserByEmail(ctx.db, email)) {
    fail(res, 409, "该邮箱已被注册，请直接登录或使用其它邮箱");
    return;
  }

  try {
    const user = await createUser(ctx.db, {
      username,
      email,
      password: String(body.password),
      role: "customer",
      // 邮箱刚被验证码证明过，直接记为已验证，不再需要第二步激活
      emailVerifiedAt: nowIso()
    });

    consumeCode(ctx.db, email, "register");
    writeAudit(ctx.db, user.id, "auth.register", username, { ip, email });
    sendJson(res, 201, { user: toPublicUser(user) });
  } catch (error) {
    const conflict = uniqueConflictMessage(error);
    if (conflict) {
      fail(res, 409, conflict);
      return;
    }
    throw error;
  }
}

/**
 * 找回密码第一步：发送重置验证码。
 *
 * 与注册不同：这里**只给已注册的邮箱发信**，但无论邮箱是否存在，
 * 响应体、状态码与限流行为都完全一致——否则它就成了「某邮箱是否注册过」
 * 的查询工具。
 *
 * 两个容易被忽略的细节：
 *   - 即使不发信也照常签发并记录验证码（`deliver: false`），
 *     否则「验证码不存在」与「验证码不正确」的差异又变成了探测信号；
 *   - 发信不等待（`background: true`），把 SMTP 往返的时间差抹平。
 */
async function handlePasswordResetCode(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = asObject(await readJsonBody(req));

  const emailError = validateEmail(body.email);
  if (emailError) {
    fail(res, 400, emailError);
    return;
  }

  const email = normalizeEmail(String(body.email));
  const user = findUserByEmail(ctx.db, email);

  await issueAndSendCode(ctx, res, {
    purpose: "reset",
    email,
    ip: clientIp(req),
    ratePrefix: "resetcode",
    auditPrefix: "auth.password_reset_code",
    subject: "【Remote Phone Control】重置密码验证码",
    // 账号不存在就不发信——但响应与发信时一模一样（见上面的说明）
    deliver: user !== null,
    background: true,
    body: (code) => [
      `你的密码重置验证码是 ${code}`,
      "",
      `验证码 ${Math.round(CODE_TTL_MS / 60_000)} 分钟内有效，请勿转发给他人。`,
      "如果不是你本人操作，说明有人误填了你的邮箱，你的密码不会被修改；" +
        "不过仍建议你尽快更换一次密码。"
    ]
  });
}

/**
 * 找回密码第二步：校验验证码并设置新密码。
 *
 * 刻意**不补发 token**：让用户用新密码重新登录一次，
 * 顺便确认新密码真的记得住。
 */
async function handlePasswordReset(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const ip = clientIp(req);
  if (!allowRequest(`reset:${ip}`, RESET_MAX_ATTEMPTS, RESET_WINDOW_MS)) {
    fail(res, 429, "操作过于频繁，请稍后再试");
    return;
  }

  const body = asObject(await readJsonBody(req));

  const emailError = validateEmail(body.email);
  if (emailError) {
    fail(res, 400, emailError);
    return;
  }

  const passwordError = validatePassword(body.newPassword);
  if (passwordError) {
    fail(res, 400, passwordError);
    return;
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code)) {
    fail(res, 400, `请填写 ${CODE_LENGTH} 位数字验证码`);
    return;
  }

  const email = normalizeEmail(String(body.email));

  // 先验码：账号不存在时也照常走一遍，不让「有没有账号」影响这里的耗时与文案
  const verdict = await verifyCode(ctx.db, email, "reset", code);
  if (!verdict.ok) {
    writeAudit(ctx.db, null, "auth.password_reset_rejected", email, { ip, reason: verdict.reason });
    fail(res, 400, describeFailure(verdict.reason));
    return;
  }

  const user = findUserByEmail(ctx.db, email);
  if (!user) {
    // 这个邮箱从来没注册过，我们也没给它发过码——能走到这里基本只能是撞运气
    writeAudit(ctx.db, null, "auth.password_reset_unknown_email", email, { ip });
    fail(res, 400, "验证码不正确");
    return;
  }

  if (user.status !== "active") {
    // 被禁用的账号我们照常发信（否则等于告诉外人「这个号被禁了」），在这里明确拒绝
    writeAudit(ctx.db, user.id, "auth.password_reset_disabled", user.username, { ip });
    fail(res, 403, "账号已被禁用，请联系管理员");
    return;
  }

  await setUserPassword(ctx.db, user.id, String(body.newPassword));
  consumeCode(ctx.db, email, "reset");

  // 改密后必须让所有旧会话立刻失效：否则被盗的会话能一直用到过期
  const revoked = revokeAllSessionsForUser(ctx.db, user.id);
  notifyAccessChanged(ctx);

  writeAudit(ctx.db, user.id, "auth.password_reset", user.username, { ip, revokedSessions: revoked });

  sendJson(res, 200, { ok: true, revokedSessions: revoked });
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

/**
 * 换绑邮箱第一步：给**新邮箱**发验证码。
 *
 * 验证的是「你确实拥有要换成的那个邮箱」，而不是旧邮箱——
 * 旧邮箱此时可能已经收不到信了（这正是很多人换绑的原因）。
 */
async function handleEmailChangeCode(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthResult
): Promise<void> {
  const body = asObject(await readJsonBody(req));

  const emailError = validateEmail(body.email);
  if (emailError) {
    fail(res, 400, emailError);
    return;
  }

  const email = normalizeEmail(String(body.email));
  if (auth.user.email && normalizeEmail(auth.user.email) === email) {
    fail(res, 400, "新邮箱与当前邮箱相同");
    return;
  }

  await issueAndSendCode(ctx, res, {
    purpose: "change_email",
    email,
    ip: clientIp(req),
    ratePrefix: "emailcode",
    auditPrefix: "auth.email_change_code",
    subject: "【Remote Phone Control】更换邮箱验证码",
    // 换绑必须真能收到信才有意义，这里不存在「账号是否存在」的真假之分
    deliver: true,
    background: false,
    body: (code) => [
      `你的换绑邮箱验证码是 ${code}`,
      "",
      `验证码 ${Math.round(CODE_TTL_MS / 60_000)} 分钟内有效，请勿转发给他人。`,
      "如果不是你本人操作，请忽略这封邮件，并检查你的账号是否已被他人登录。"
    ]
  });
}

/**
 * 换绑邮箱第二步：密码 + 验证码双重确认后落库。
 *
 * 为什么要额外要当前密码：邮箱是账号的找回通道，
 * 只凭一个被盗的会话就能改走邮箱，等于把账号彻底送给对方（之后走找回密码即可）。
 */
async function handleEmailChange(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthResult
): Promise<void> {
  const ip = clientIp(req);
  const body = asObject(await readJsonBody(req));

  const emailError = validateEmail(body.email);
  if (emailError) {
    fail(res, 400, emailError);
    return;
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code)) {
    fail(res, 400, `请填写 ${CODE_LENGTH} 位数字验证码`);
    return;
  }

  const verified = await authenticate(ctx.db, auth.user.username, String(body.currentPassword ?? ""));
  if (!verified) {
    writeAudit(ctx.db, auth.user.id, "auth.email_change_bad_password", auth.user.username, { ip });
    fail(res, 401, "当前密码不正确");
    return;
  }

  const email = normalizeEmail(String(body.email));
  if (auth.user.email && normalizeEmail(auth.user.email) === email) {
    fail(res, 400, "新邮箱与当前邮箱相同");
    return;
  }

  const verdict = await verifyCode(ctx.db, email, "change_email", code);
  if (!verdict.ok) {
    writeAudit(ctx.db, auth.user.id, "auth.email_change_rejected", email, { ip, reason: verdict.reason });
    fail(res, 400, describeFailure(verdict.reason));
    return;
  }

  // 验码之后再查重：不能让这个接口变成「某邮箱是否已注册」的查询工具
  const owner = findUserByEmail(ctx.db, email);
  if (owner && owner.id !== auth.user.id) {
    fail(res, 409, "该邮箱已被其它账号使用");
    return;
  }

  const updated = setUserEmail(ctx.db, auth.user.id, email, nowIso());
  consumeCode(ctx.db, email, "change_email");

  writeAudit(ctx.db, auth.user.id, "auth.email_changed", auth.user.username, {
    from: auth.user.email,
    to: email,
    ip
  });

  sendJson(res, 200, { user: updated ? toPublicUser(updated) : null });
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

    // 邮箱可选。管理员建号相当于人工担保，填了就记为已验证，不要求走验证码流程
    const hasEmail = body.email !== undefined && body.email !== null && String(body.email).trim() !== "";
    if (hasEmail) {
      const emailError = validateEmail(body.email);
      if (emailError) {
        fail(res, 400, emailError);
        return;
      }
    }

    try {
      const user = await createUser(ctx.db, {
        username: String(body.username),
        password: String(body.password),
        role: "customer",
        email: hasEmail ? String(body.email) : null,
        emailVerifiedAt: hasEmail ? nowIso() : null
      });
      writeAudit(ctx.db, auth.user.id, "admin.user_created", user.username, { email: user.email });
      sendJson(res, 201, { user: toPublicUser(user) });
    } catch (error) {
      const conflict = uniqueConflictMessage(error);
      if (conflict) {
        fail(res, 409, conflict);
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
