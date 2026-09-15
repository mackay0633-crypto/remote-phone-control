/**
 * 数据库表结构。
 *
 * 驱动是 `better-sqlite3`（见 database.ts 里的选型说明）。
 *
 * 注意 SQLite 的取值类型限制：只接受 number / string / bigint / null /
 * Uint8Array。**布尔值不被支持**，因此所有开关与标志一律存 0 / 1 整数。
 *
 * ── 加字段的正确姿势 ────────────────────────────────────────────
 *
 * `SCHEMA_STATEMENTS` 里全是 `CREATE TABLE IF NOT EXISTS`，对**已存在的表是空操作**。
 * 也就是说：只改这里的建表语句，老库不会有新列，启动后查询会直接报
 * "no such column"，而全新的库却完全正常——这类 bug 只在升级时炸。
 *
 * 所以**每次改表都要在 `MIGRATIONS` 里补一条同版本号的迁移**（见 database.ts）。
 * 建表语句给新库，迁移给老库，两边都要写。
 *
 * `SCHEMA_VERSION` 由 `MIGRATIONS` 推导（见文件末尾），刻意**不手写**：
 * 手写的版本号会与迁移列表漂移，而漂移的后果很难看——
 * 曾经出现过「结构已经升到 v3、版本号还记着 v2」的错位状态，
 * 下次真把版本号改对时，v3 的表重建会在已迁移的库上再跑一次，把表清空。
 */

export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS users (
     id                   INTEGER PRIMARY KEY AUTOINCREMENT,
     username             TEXT    NOT NULL UNIQUE COLLATE NOCASE,
     password_hash        TEXT    NOT NULL,
     -- 邮箱只用于注册验证与联系，可以为空（管理员直接建的号、以及 v1 老账号都是空）
     email                TEXT,
     -- 非空表示邮箱已通过验证码确认；老账号为 NULL，一律按「已验证」对待
     email_verified_at    TEXT,
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

  // 邮箱唯一但允许为空：SQLite 的 UNIQUE 允许多个 NULL，用部分索引更明确。
  // COLLATE NOCASE 让 Alice@x.com 与 alice@x.com 视为同一个邮箱。
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
     ON users(email COLLATE NOCASE) WHERE email IS NOT NULL`,

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

  /**
   * 邮箱验证码。
   *
   * 只存**哈希**：库被拖走时不能直接拿验证码去注册/改密。
   * attempts 用来限制猜码次数——6 位数字只有 100 万种组合，
   * 没有这个计数器的话，限流一过就能被在线爆破。
   *
   * purpose 把「注册」「找回密码」「换绑邮箱」三种码彼此隔离：
   * 注册的码不能拿去重置密码，反之亦然。
   */
  `CREATE TABLE IF NOT EXISTS email_verifications (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     email       TEXT    NOT NULL COLLATE NOCASE,
     purpose     TEXT    NOT NULL CHECK (purpose IN ('register', 'reset', 'change_email')),
     code_hash   TEXT    NOT NULL,
     attempts    INTEGER NOT NULL DEFAULT 0,
     created_at  TEXT    NOT NULL,
     expires_at  TEXT    NOT NULL,
     consumed_at TEXT
   )`,

  // 取「某邮箱某用途最近一条」是热路径（发码前查冷却、收码时校验）
  `CREATE INDEX IF NOT EXISTS idx_email_verifications_lookup
     ON email_verifications(email, purpose, id DESC)`,

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

export interface Migration {
  /** 迁移完成后写回 schema_meta 的版本号 */
  version: number;
  /** 说明，仅在日志里出现 */
  description: string;
  statements: string[];
}

/**
 * 版本迁移：把老库从 version-1 升到 version。
 *
 * 规则：**只追加，不修改历史条目**——已经跑过的迁移在别人的机器上不会再跑，
 * 改了历史条目只会让两台机器的表结构悄悄分叉。
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 2,
    description: "注册邮箱验证：users 增加 email / email_verified_at，新增 email_verifications",
    statements: [
      "ALTER TABLE users ADD COLUMN email TEXT",
      "ALTER TABLE users ADD COLUMN email_verified_at TEXT",
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
         ON users(email COLLATE NOCASE) WHERE email IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS email_verifications (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         email       TEXT    NOT NULL COLLATE NOCASE,
         purpose     TEXT    NOT NULL CHECK (purpose IN ('register', 'reset')),
         code_hash   TEXT    NOT NULL,
         attempts    INTEGER NOT NULL DEFAULT 0,
         created_at  TEXT    NOT NULL,
         expires_at  TEXT    NOT NULL,
         consumed_at TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_email_verifications_lookup
         ON email_verifications(email, purpose, id DESC)`
    ]
  },
  {
    version: 3,
    description: "验证码新增 change_email 用途（SQLite 改 CHECK 约束需重建表）",
    /**
     * SQLite 不支持直接修改 CHECK 约束，只能重建表。
     *
     * 这是当初选「先验证后建号」而非「pending 状态」的原因之一：
     * 那条路要为 users.status 做同样的重建，而 users 上挂着
     * devices / sessions 的外键，重建要处理的关系复杂得多。
     *
     * email_verifications 只是一张短生命周期的验证码表：
     * 没有外键引用它，重建就是「建新表 → 拷数据 → 删旧表 → 改名」四步。
     * 注意 DROP TABLE 会连索引一起删掉，所以索引必须重建。
     */
    statements: [
      `CREATE TABLE email_verifications_v3 (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         email       TEXT    NOT NULL COLLATE NOCASE,
         purpose     TEXT    NOT NULL CHECK (purpose IN ('register', 'reset', 'change_email')),
         code_hash   TEXT    NOT NULL,
         attempts    INTEGER NOT NULL DEFAULT 0,
         created_at  TEXT    NOT NULL,
         expires_at  TEXT    NOT NULL,
         consumed_at TEXT
       )`,
      `INSERT INTO email_verifications_v3(id, email, purpose, code_hash, attempts, created_at, expires_at, consumed_at)
         SELECT id, email, purpose, code_hash, attempts, created_at, expires_at, consumed_at
         FROM email_verifications`,
      "DROP TABLE email_verifications",
      "ALTER TABLE email_verifications_v3 RENAME TO email_verifications",
      `CREATE INDEX IF NOT EXISTS idx_email_verifications_lookup
         ON email_verifications(email, purpose, id DESC)`
    ]
  }
];

/**
 * 当前代码所支持的结构版本 = 已知迁移里的最高版本。
 *
 * **刻意从 `MIGRATIONS` 推导而不是手写**：手写就会出现「加了迁移却忘了改版本号」
 * 或反过来的漂移。而 `runMigrations` 是按「版本号大于当前就执行」来跑的，
 * 一旦漂移，比声明版本更新的迁移也会被执行，随后版本号又被写回较小的值——
 * 结果是结构升了、版本号没升。等下次把版本号补对，那次迁移会**再跑一遍**，
 * 表重建类的迁移就会把数据清空。
 *
 * 基线是 1：没有迁移时的原始结构。
 */
export const SCHEMA_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  1
);
