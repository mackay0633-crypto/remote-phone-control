import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "./schema.js";

export type Database = BetterSqlite3.Database;

/**
 * 打开数据库并确保表结构就绪。
 *
 * ── 选型说明（含一次踩坑记录）────────────────────────────────
 *
 * 最初用的是 Node 内置的 `node:sqlite`，理由是「零原生依赖」。
 * 但那个判断只验证了**开发机**（Node 24），没有确认**部署服务器的 Node 版本**，
 * 结果生产服务器是 Node 20，直接报错起不来：
 *
 *     Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
 *
 * `node:sqlite` 直到 Node 22.5 才加入、23.4 才默认可用，覆盖面太窄。
 *
 * 现在改用 `better-sqlite3`：覆盖 Node 18 / 20 / 22 / 24，
 * 预编译包覆盖主流平台，`npm install` 即可，不需要额外工具链。
 * 代价是原生模块，但换来了「装到哪台机器都能跑」。
 *
 * 两个库的 API 几乎一致（同步、`prepare/get/all/run/exec`），
 * 所以这次切换只动了本文件。
 */
export function openDatabase(file: string): Database {
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
  }

  const db = new BetterSqlite3(file);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

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
