import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS, SCHEMA_STATEMENTS, SCHEMA_VERSION } from "./schema.js";

export type Database = BetterSqlite3.Database;

/**
 * 打开数据库，确保表结构就绪，并把老库迁移到当前版本。
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

  // 先判断是不是全新的库：全新建表不需要迁移（建表语句本身就是最新的）。
  const isFresh = !tableExists(db, "users");

  /**
   * 顺序很关键：**老库必须迁移完再跑建表语句**。
   *
   * 因为建表语句里含依赖新列的索引（如 `users(email)`），
   * 在还没迁移的老库上执行会直接报 "no such column: email"。
   * 迁移只对老库有意义，全新库跳过即可。
   */
  if (!isFresh) {
    runMigrations(db);
  }

  for (const statement of SCHEMA_STATEMENTS) {
    db.exec(statement);
  }

  writeSchemaVersion(db, SCHEMA_VERSION);

  return db;
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;

  return row !== undefined;
}

function readSchemaVersion(db: Database): number {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
    | { value: string }
    | undefined;

  const version = Number(row?.value);
  return Number.isFinite(version) ? version : 0;
}

function writeSchemaVersion(db: Database, version: number): void {
  db.prepare(
    "INSERT INTO schema_meta(key, value) VALUES ('version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(version));
}

/**
 * 把已有数据库逐版本升级到 `SCHEMA_VERSION`。
 *
 * 每个迁移**连同版本号写入放在同一个事务里**：SQLite 的 DDL 是可回滚的，
 * 所以中途崩掉不会留下「表改了但版本没记」的半成品状态。
 *
 * 库版本高于程序时直接拒绝启动——那说明代码被回滚了，
 * 用旧代码去操作新结构，大概率是静默写坏数据，不如立刻报错。
 */
function runMigrations(db: Database): void {
  // 建表语句存在但版本号缺失（手工建的库）按 v1 处理，让它走完整条迁移链
  const current = readSchemaVersion(db) || 1;

  if (current === SCHEMA_VERSION) {
    return;
  }

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `数据库版本 v${current} 高于本程序支持的 v${SCHEMA_VERSION}——` +
        "代码很可能被回滚了。请升级 relay，或改用匹配版本的代码。"
    );
  }

  const pending = MIGRATIONS.filter(
    // 上界这一条在当前实现下是冗余的（SCHEMA_VERSION 由 MIGRATIONS 推导），
    // 但写出来之后，runMigrations 就不再依赖「版本号恰好等于最高迁移」这个隐含前提：
    // 将来若有人把 SCHEMA_VERSION 改回手写，也不会执行代码并不支持的迁移。
    (migration) => migration.version > current && migration.version <= SCHEMA_VERSION
  ).sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    db.transaction(() => {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      writeSchemaVersion(db, migration.version);
    })();

    console.log(`[db] 已迁移到 v${migration.version}：${migration.description}`);
  }
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
