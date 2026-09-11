import { createHash, randomBytes } from "node:crypto";
import type { Database } from "../db/database.js";

/** 会话滑动有效期（每次使用向后顺延） */
const SLIDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 绝对有效期上限，滑动续期也不能超过它 */
const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 两次写回 last_seen_at 的最小间隔，避免每个请求都写库 */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

interface SessionRow {
  user_id: number | bigint;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
}

/**
 * 会话令牌只存哈希。
 *
 * 用 sha256 而不是 scrypt：令牌本身是 32 字节随机数，熵已经足够，
 * 不存在被字典爆破的风险，因此不需要慢哈希——这里要的是「库被读走也无法直接冒用」。
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreatedSession {
  token: string;
  expiresAt: string;
}

export function createSession(db: Database, userId: number, ttlMs = SLIDING_TTL_MS): CreatedSession {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = new Date(now + ttlMs).toISOString();

  db.prepare(
    "INSERT INTO sessions(token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)"
  ).run(hashToken(token), userId, new Date(now).toISOString(), expiresAt, new Date(now).toISOString());

  return { token, expiresAt };
}

/**
 * 用令牌换回 userId。
 *
 * 同时处理三件事：过期即删除、滑动续期、节流写回 last_seen_at。
 * 返回 null 表示令牌无效或已过期，调用方应一律按未认证处理。
 */
export function resolveSession(db: Database, token: string): { userId: number } | null {
  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);
  const row = db
    .prepare("SELECT user_id, created_at, expires_at, last_seen_at FROM sessions WHERE token_hash = ?")
    .get(tokenHash) as SessionRow | undefined;

  if (!row) {
    return null;
  }

  const now = Date.now();
  const absoluteDeadline = Date.parse(row.created_at) + ABSOLUTE_TTL_MS;

  if (Date.parse(row.expires_at) <= now || now >= absoluteDeadline) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }

  const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
  if (now - lastSeen >= TOUCH_INTERVAL_MS) {
    const nextExpiry = new Date(Math.min(now + SLIDING_TTL_MS, absoluteDeadline)).toISOString();
    db.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?").run(
      nextExpiry,
      new Date(now).toISOString(),
      tokenHash
    );
  }

  return { userId: Number(row.user_id) };
}

export function revokeSession(db: Database, token: string): void {
  if (!token) {
    return;
  }

  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

/**
 * 吊销某用户的全部会话。
 *
 * 用于这几处：管理员禁用账号、重置密码、用户自己改密码。
 * 否则旧令牌会一直有效到过期，权限收紧就形同虚设。
 */
export function revokeAllSessionsForUser(db: Database, userId: number): number {
  const result = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  return Number(result.changes);
}

export function purgeExpiredSessions(db: Database): number {
  const result = db
    .prepare("DELETE FROM sessions WHERE expires_at <= ?")
    .run(new Date().toISOString());
  return Number(result.changes);
}
