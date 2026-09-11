import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "./schema.js";

export type Database = DatabaseSync;

/**
 * 打开数据库并确保表结构就绪。
 *
 * 选型说明：使用 Node 24 内置的 `node:sqlite` 而不是 better-sqlite3，
 * 换来的是**零原生依赖**（无需编译、无需预编译包，Linux 服务器上同样开箱即用）。
 * 代价是它目前仍标记为 experimental。所有数据库调用都收敛在本目录的几个模块里，
 * 若将来要换回 better-sqlite3，改动范围仅限 `relay/src/db/` 与 `relay/src/auth/`。
 */
export function openDatabase(file: string): Database {
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
  }

  const db = new DatabaseSync(file);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  for (const statement of SCHEMA_STATEMENTS) {
    db.exec(statement);
  }

  db.prepare(
    "INSERT INTO schema_meta(key, value) VALUES ('version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(SCHEMA_VERSION));

  return db;
}

/** 把 SQLite 的 0/1 还原成布尔。 */
export function toBool(value: unknown): boolean {
  return value === 1 || value === 1n || value === true;
}

/** 把布尔写回 SQLite 需要的整数。 */
export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

/** lastInsertRowid 可能是 bigint，统一转成 number。 */
export function lastId(result: { lastInsertRowid: number | bigint }): number {
  return Number(result.lastInsertRowid);
}

/** 统一的 ISO 时间戳，便于日志与审计阅读。 */
export function nowIso(): string {
  return new Date().toISOString();
}
