import { fromBool, lastId, nowIso, toBool, type Database } from "../db/database.js";
import {
  CAPABILITIES,
  allCapabilities,
  noCapabilities,
  type Capability,
  type CapabilitySet
} from "./capabilities.js";
import { hashPassword, verifyPassword } from "./password.js";

export type UserRole = "admin" | "customer";
export type UserStatus = "active" | "disabled";

export interface UserRecord {
  id: number;
  username: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  capabilities: CapabilitySet;
  maxDevices: number;
  maxConcurrentTasks: number;
  maxStorageBytes: number;
}

/** 对外暴露的用户视图——**绝不包含 passwordHash** */
export interface PublicUser {
  id: number;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  capabilities: CapabilitySet;
  quota: {
    maxDevices: number;
    maxConcurrentTasks: number;
    maxStorageBytes: number;
  };
}

export interface UserListItem extends PublicUser {
  deviceCount: number;
}

interface UserRow {
  id: number | bigint;
  username: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: string;
  can_view_devices: number | bigint;
  can_view_stream: number | bigint;
  can_control_input: number | bigint;
  can_run_dayil: number | bigint;
  can_send_video: number | bigint;
  can_upload_video: number | bigint;
  max_devices: number | bigint;
  max_concurrent_tasks: number | bigint;
  max_storage_bytes: number | bigint;
}

const SELECT_COLUMNS = `
  id, username, password_hash, role, status, created_at,
  can_view_devices, can_view_stream, can_control_input,
  can_run_dayil, can_send_video, can_upload_video,
  max_devices, max_concurrent_tasks, max_storage_bytes
`;

export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

export function validateUsername(value: unknown): string | null {
  if (typeof value !== "string" || !USERNAME_PATTERN.test(value)) {
    return "用户名只能包含字母、数字、点、下划线、连字符，长度 3~32";
  }
  return null;
}

export function validatePassword(value: unknown): string | null {
  if (typeof value !== "string" || value.length < MIN_PASSWORD_LENGTH) {
    return `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    return `密码最长 ${MAX_PASSWORD_LENGTH} 位`;
  }
  return null;
}

/**
 * 用于「用户名不存在」时的等时校验。
 *
 * 不这样做的话，不存在的用户名会立刻返回，而存在的用户名要跑一次 scrypt，
 * 攻击者就能靠响应时间枚举出哪些用户名真实存在。
 */
const DUMMY_HASH = [
  "scrypt",
  16_384,
  8,
  1,
  Buffer.alloc(16).toString("base64"),
  Buffer.alloc(64).toString("base64")
].join("$");

function rowToUser(row: UserRow): UserRecord {
  return {
    id: Number(row.id),
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role === "admin" ? "admin" : "customer",
    status: row.status === "disabled" ? "disabled" : "active",
    createdAt: row.created_at,
    capabilities: {
      can_view_devices: toBool(row.can_view_devices),
      can_view_stream: toBool(row.can_view_stream),
      can_control_input: toBool(row.can_control_input),
      can_run_dayil: toBool(row.can_run_dayil),
      can_send_video: toBool(row.can_send_video),
      can_upload_video: toBool(row.can_upload_video)
    },
    maxDevices: Number(row.max_devices),
    maxConcurrentTasks: Number(row.max_concurrent_tasks),
    maxStorageBytes: Number(row.max_storage_bytes)
  };
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    capabilities: { ...user.capabilities },
    quota: {
      maxDevices: user.maxDevices,
      maxConcurrentTasks: user.maxConcurrentTasks,
      maxStorageBytes: user.maxStorageBytes
    }
  };
}

/**
 * 能力判定。
 *
 * **管理员恒为放行**，且不看数据库里的列——这样即使有人误改了 admin 行的开关，
 * 也不会把管理后台锁死。
 */
export function hasCapability(user: UserRecord, capability: Capability): boolean {
  if (user.role === "admin") {
    return true;
  }

  return user.capabilities[capability] === true;
}

export function findUserByUsername(db: Database, username: string): UserRecord | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM users WHERE username = ?`)
    .get(username) as UserRow | undefined;

  return row ? rowToUser(row) : null;
}

export function findUserById(db: Database, id: number): UserRecord | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM users WHERE id = ?`).get(id) as UserRow | undefined;
  return row ? rowToUser(row) : null;
}

export interface CreateUserInput {
  username: string;
  /** 明文密码；由本模块负责哈希，调用方不接触哈希细节 */
  password: string;
  role: UserRole;
}

export async function createUser(db: Database, input: CreateUserInput): Promise<UserRecord> {
  const passwordHash = await hashPassword(input.password);

  const capabilities: CapabilitySet = input.role === "admin" ? allCapabilities() : noCapabilities();
  const timestamp = nowIso();

  const result = db.prepare(
    `INSERT INTO users(
       username, password_hash, role, status, created_at, updated_at,
       can_view_devices, can_view_stream, can_control_input,
       can_run_dayil, can_send_video, can_upload_video,
       max_devices, max_concurrent_tasks, max_storage_bytes
     ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.username,
    passwordHash,
    input.role,
    timestamp,
    timestamp,
    ...CAPABILITIES.map((capability) => fromBool(capabilities[capability])),
    0,
    1,
    0
  );

  const created = findUserById(db, lastId(result));
  if (!created) {
    throw new Error("创建用户后无法读回记录");
  }

  return created;
}

/** 修改一个或多个能力开关，未提供的保持不变。 */
export function setUserCapabilities(
  db: Database,
  userId: number,
  patch: Partial<CapabilitySet>
): UserRecord | null {
  const assignments: string[] = [];
  const values: (number | string)[] = [];

  for (const capability of CAPABILITIES) {
    const next = patch[capability];
    if (next === undefined) {
      continue;
    }

    assignments.push(`${capability} = ?`);
    values.push(fromBool(next === true));
  }

  if (assignments.length === 0) {
    return findUserById(db, userId);
  }

  assignments.push("updated_at = ?");
  values.push(nowIso(), userId);

  db.prepare(`UPDATE users SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
  return findUserById(db, userId);
}

export interface QuotaPatch {
  maxDevices?: number;
  maxConcurrentTasks?: number;
  maxStorageBytes?: number;
}

export function setUserQuota(db: Database, userId: number, patch: QuotaPatch): UserRecord | null {
  const assignments: string[] = [];
  const values: (number | string)[] = [];

  if (patch.maxDevices !== undefined) {
    assignments.push("max_devices = ?");
    values.push(Math.max(0, Math.trunc(patch.maxDevices)));
  }
  if (patch.maxConcurrentTasks !== undefined) {
    assignments.push("max_concurrent_tasks = ?");
    values.push(Math.max(1, Math.trunc(patch.maxConcurrentTasks)));
  }
  if (patch.maxStorageBytes !== undefined) {
    assignments.push("max_storage_bytes = ?");
    values.push(Math.max(0, Math.trunc(patch.maxStorageBytes)));
  }

  if (assignments.length === 0) {
    return findUserById(db, userId);
  }

  assignments.push("updated_at = ?");
  values.push(nowIso(), userId);

  db.prepare(`UPDATE users SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
  return findUserById(db, userId);
}

export function setUserStatus(db: Database, userId: number, status: UserStatus): UserRecord | null {
  db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), userId);
  return findUserById(db, userId);
}

export async function setUserPassword(db: Database, userId: number, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
    passwordHash,
    nowIso(),
    userId
  );
}

export function listUsers(db: Database, role?: UserRole): UserListItem[] {
  const rows = (
    role
      ? db.prepare(`SELECT ${SELECT_COLUMNS} FROM users WHERE role = ? ORDER BY id`).all(role)
      : db.prepare(`SELECT ${SELECT_COLUMNS} FROM users ORDER BY id`).all()
  ) as unknown as UserRow[];

  const counts = db
    .prepare(
      "SELECT assigned_user_id AS uid, COUNT(*) AS n FROM devices " +
        "WHERE assigned_user_id IS NOT NULL GROUP BY assigned_user_id"
    )
    .all() as unknown as { uid: number | bigint; n: number | bigint }[];

  const countByUser = new Map<number, number>();
  for (const row of counts) {
    countByUser.set(Number(row.uid), Number(row.n));
  }

  return rows.map((row) => {
    const user = rowToUser(row);
    return { ...toPublicUser(user), deviceCount: countByUser.get(user.id) ?? 0 };
  });
}

export function countAdmins(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as {
    n: number | bigint;
  };
  return Number(row.n);
}

/**
 * 校验用户名密码。
 *
 * 调用方仍需自行检查 status：禁用账号即使密码正确也应拒绝登录，
 * 但那属于业务判断，不属于「凭证是否正确」。
 */
export async function authenticate(
  db: Database,
  username: string,
  password: string
): Promise<UserRecord | null> {
  const user = findUserByUsername(db, username);

  if (!user) {
    await verifyPassword(password, DUMMY_HASH);
    return null;
  }

  const valid = await verifyPassword(password, user.passwordHash);
  return valid ? user : null;
}
