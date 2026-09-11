import { nowIso, type Database } from "./database.js";

/**
 * 审计日志写入。
 *
 * 单独成模块是为了让 relay 主进程（WS 通道的越权尝试）和 API 层
 * 共用同一份实现，避免出现两套写法。
 */
export function writeAudit(
  db: Database,
  actorUserId: number | null,
  action: string,
  target: string | null,
  detail?: unknown
): void {
  db.prepare(
    "INSERT INTO audit_log(actor_user_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(
    actorUserId,
    action,
    target,
    detail === undefined ? null : JSON.stringify(detail),
    nowIso()
  );
}
