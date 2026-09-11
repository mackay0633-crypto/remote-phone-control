/**
 * 数据库表结构。
 *
 * 驱动是 `better-sqlite3`（见 database.ts 里的选型说明）。
 *
 * 注意 SQLite 的取值类型限制：只接受 number / string / bigint / null /
 * Uint8Array。**布尔值不被支持**，因此所有开关与标志一律存 0 / 1 整数。
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS users (
     id                   INTEGER PRIMARY KEY AUTOINCREMENT,
     username             TEXT    NOT NULL UNIQUE COLLATE NOCASE,
     password_hash        TEXT    NOT NULL,
     role                 TEXT    NOT NULL CHECK (role IN ('admin', 'customer')),
     status               TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
     created_at           TEXT    NOT NULL,
     updated_at           TEXT    NOT NULL,

     -- 能力开关（管理员恒为全开；客户由管理页面控制）
     can_view_devices     INTEGER NOT NULL DEFAULT 0,
     can_view_stream      INTEGER NOT NULL DEFAULT 0,
     can_control_input    INTEGER NOT NULL DEFAULT 0,
     can_run_dayil        INTEGER NOT NULL DEFAULT 0,
     can_send_video       INTEGER NOT NULL DEFAULT 0,
     can_upload_video     INTEGER NOT NULL DEFAULT 0,

     -- 配额
     max_devices          INTEGER NOT NULL DEFAULT 0,
     max_concurrent_tasks INTEGER NOT NULL DEFAULT 1,
     max_storage_bytes    INTEGER NOT NULL DEFAULT 0
   )`,

  `CREATE TABLE IF NOT EXISTS devices (
     serial           TEXT PRIMARY KEY,
     agent_id         TEXT,
     assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     assigned_at      TEXT,
     last_seen_at     TEXT
   )`,

  `CREATE INDEX IF NOT EXISTS idx_devices_assigned_user
     ON devices(assigned_user_id)`,

  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash   TEXT    PRIMARY KEY,
     user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at   TEXT    NOT NULL,
     expires_at   TEXT    NOT NULL,
     last_seen_at TEXT
   )`,

  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,

  `CREATE TABLE IF NOT EXISTS audit_log (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     actor_user_id INTEGER,
     action        TEXT NOT NULL,
     target        TEXT,
     detail        TEXT,
     created_at    TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)`
];
