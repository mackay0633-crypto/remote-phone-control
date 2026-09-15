import { randomInt } from "node:crypto";
import { nowIso, type Database } from "../db/database.js";
import { hashPassword, verifyPassword } from "./password.js";

/**
 * 邮箱验证码的签发与校验。
 *
 * ── 设计取舍 ────────────────────────────────────────────────────
 *
 * **只存哈希**：验证码是 6 位数字，只有 100 万种组合。攻击者一旦拿到库
 * （备份泄漏、SQL 注入、运维误拷），明文存法可以瞬间反推出所有人的在途验证码，
 * 直接接管账号。走 scrypt 后即使库被拖走，也只有拿到原码才能通过校验。
 *
 * **尝试次数上限**：哈希挡的是离线爆破，挡不住在线猜。
 * 100 万种组合配上一个宽松的限流，几分钟就能撞开一个账号，
 * 所以每条验证码自带 `attempts` 计数，超过上限即作废。
 *
 * **一个邮箱同一用途只有一个有效码**：发新码时把旧码置为已消费。
 * 否则用户可以连点「重新发送」，把有效码撒得满邮箱都是。
 */

/**
 * 验证码用途。
 *
 * 三者彼此隔离：注册的码不能拿去重置密码，重置的码不能拿去换绑邮箱。
 * 新增用途必须同步改 `db/schema.ts` 里的 CHECK 约束（走一次表重建迁移）。
 */
export type VerificationPurpose = "register" | "reset" | "change_email";

/** 验证码位数。6 位是「够短好输入」与「够长不易猜」的平衡点 */
export const CODE_LENGTH = 6;

function positiveIntEnv(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min ? Math.trunc(parsed) : fallback;
}

/** 有效期。够慢条斯理地切到邮箱再切回来，又不至于躺一整天等人猜 */
export const CODE_TTL_MS =
  positiveIntEnv(process.env.VERIFICATION_CODE_TTL_MINUTES, 10, 1) * 60_000;

/** 重发冷却。防连点，也防拿同一邮箱当短信炮台 */
export const RESEND_COOLDOWN_MS =
  positiveIntEnv(process.env.VERIFICATION_RESEND_SECONDS, 60, 5) * 1000;

/** 单条验证码允许的最大尝试次数 */
export const MAX_ATTEMPTS = positiveIntEnv(process.env.VERIFICATION_MAX_ATTEMPTS, 5, 1);

/**
 * 用于「没有待验证的码」时的等时校验。
 *
 * 不这样做的话，`no_code` 会在 1ms 内返回，而「有码但不对」要跑一次 scrypt（几十毫秒），
 * 攻击者就能靠响应时间判断某个邮箱是否正处于验证流程中。
 * 与 users.ts 里处理「用户名不存在」是同一套路。
 */
const DUMMY_HASH = [
  "scrypt",
  16_384,
  8,
  1,
  Buffer.alloc(16).toString("base64"),
  Buffer.alloc(64).toString("base64")
].join("$");

interface VerificationRow {
  id: number | bigint;
  code_hash: string;
  attempts: number | bigint;
  created_at: string;
  expires_at: string;
}

/**
 * 生成验证码。
 *
 * `randomInt` 是密码学安全随机源；**不要**改成 `Math.random()`——
 * 它的输出可预测，等于把验证码送给攻击者。
 */
export function generateCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
}

function findLatestActive(
  db: Database,
  email: string,
  purpose: VerificationPurpose
): VerificationRow | null {
  const row = db
    .prepare(
      "SELECT id, code_hash, attempts, created_at, expires_at FROM email_verifications " +
        "WHERE email = ? AND purpose = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1"
    )
    .get(email, purpose) as VerificationRow | undefined;

  return row ?? null;
}

/** 距离可以再次发码还剩多少毫秒；0 表示现在就能发。 */
export function cooldownRemainingMs(
  db: Database,
  email: string,
  purpose: VerificationPurpose
): number {
  const row = findLatestActive(db, email, purpose);
  if (!row) {
    return 0;
  }

  const issuedAt = Date.parse(row.created_at);
  if (!Number.isFinite(issuedAt)) {
    return 0;
  }

  return Math.max(0, RESEND_COOLDOWN_MS - (Date.now() - issuedAt));
}

export interface IssuedCode {
  /** 明文验证码，只在这一次返回——库里存的是哈希，之后再也读不回来 */
  code: string;
  expiresAt: string;
}

export async function issueVerificationCode(
  db: Database,
  email: string,
  purpose: VerificationPurpose
): Promise<IssuedCode> {
  // scrypt 是异步的，而 better-sqlite3 的事务必须是同步的，
  // 所以先把哈希算完，再进事务写库
  const code = generateCode();
  const codeHash = await hashPassword(code);

  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
  const consumedAt = nowIso();

  // 过期记录没人会再看，顺手清掉，避免表随注册量无限增长
  const purgeBefore = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  db.transaction(() => {
    // 旧码立即作废：一个邮箱同一用途只留一个有效码
    db.prepare(
      "UPDATE email_verifications SET consumed_at = ? " +
        "WHERE email = ? AND purpose = ? AND consumed_at IS NULL"
    ).run(consumedAt, email, purpose);

    db.prepare(
      "INSERT INTO email_verifications(email, purpose, code_hash, attempts, created_at, expires_at, consumed_at) " +
        "VALUES (?, ?, ?, 0, ?, ?, NULL)"
    ).run(email, purpose, codeHash, createdAt, expiresAt);

    db.prepare("DELETE FROM email_verifications WHERE expires_at < ?").run(purgeBefore);
  })();

  return { code, expiresAt };
}

export type VerifyFailure = "no_code" | "expired" | "mismatch" | "too_many_attempts";

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

/**
 * 校验验证码。
 *
 * 注意：**成功时不会自动消费**。调用方要先完成自己的业务
 * （建号、改密），确认成功后再调 `consumeCode`——
 * 否则「用户名已被占用」这类失败会把用户的验证码一起吃掉，只能重新收信。
 */
export async function verifyCode(
  db: Database,
  email: string,
  purpose: VerificationPurpose,
  code: string
): Promise<VerifyResult> {
  const row = findLatestActive(db, email, purpose);

  if (!row) {
    await verifyPassword(code, DUMMY_HASH);
    return { ok: false, reason: "no_code" };
  }

  if (Date.parse(row.expires_at) <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  const attempts = Number(row.attempts);
  if (attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: "too_many_attempts" };
  }

  const matches = await verifyPassword(code, row.code_hash);
  if (!matches) {
    const next = attempts + 1;
    db.prepare("UPDATE email_verifications SET attempts = ? WHERE id = ?").run(next, row.id);

    return { ok: false, reason: next >= MAX_ATTEMPTS ? "too_many_attempts" : "mismatch" };
  }

  return { ok: true };
}

/** 消费掉当前有效码，防止同一个码被重复使用。 */
export function consumeCode(db: Database, email: string, purpose: VerificationPurpose): void {
  db.prepare(
    "UPDATE email_verifications SET consumed_at = ? " +
      "WHERE email = ? AND purpose = ? AND consumed_at IS NULL"
  ).run(nowIso(), email, purpose);
}

/** 面向用户的失败原因文案。刻意不区分「没发过码」和「码已作废」，少一条探测路径。 */
export function describeFailure(reason: VerifyFailure): string {
  switch (reason) {
    case "expired":
      return "验证码已过期，请重新获取";
    case "too_many_attempts":
      return "验证码错误次数过多，请重新获取";
    case "mismatch":
      return "验证码不正确";
    case "no_code":
    default:
      return "验证码不存在或已失效，请重新获取";
  }
}
