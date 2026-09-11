import { nowIso, type Database } from "../db/database.js";
import { findUserById } from "../auth/users.js";

export interface DeviceRecord {
  serial: string;
  agentId: string | null;
  assignedUserId: number | null;
  assignedAt: string | null;
  lastSeenAt: string | null;
}

export interface AdminDeviceView extends DeviceRecord {
  assignedUsername: string | null;
  /** 该设备当前是否由已连接的 Agent 上报中 */
  online: boolean;
}

interface DeviceRow {
  serial: string;
  agent_id: string | null;
  assigned_user_id: number | bigint | null;
  assigned_at: string | null;
  last_seen_at: string | null;
}

function rowToDevice(row: DeviceRow): DeviceRecord {
  return {
    serial: row.serial,
    agentId: row.agent_id,
    assignedUserId: row.assigned_user_id === null ? null : Number(row.assigned_user_id),
    assignedAt: row.assigned_at,
    lastSeenAt: row.last_seen_at
  };
}

/**
 * 把某个 Agent 上报的设备同步进库。
 *
 * 只做新增与「在线时间」更新，**绝不触碰 assigned_user_id**——
 * 归属是管理员手工决定的，不能被设备上报覆盖掉。
 */
export function syncAgentDevices(db: Database, agentId: string, serials: string[]): void {
  const timestamp = nowIso();

  const insert = db.prepare(
    "INSERT INTO devices(serial, agent_id, assigned_user_id, assigned_at, last_seen_at) " +
      "VALUES (?, ?, NULL, NULL, ?) " +
      "ON CONFLICT(serial) DO UPDATE SET agent_id = excluded.agent_id, last_seen_at = excluded.last_seen_at"
  );

  for (const serial of serials) {
    insert.run(serial, agentId, timestamp);
  }
}

export function getDevice(db: Database, serial: string): DeviceRecord | null {
  const row = db
    .prepare(
      "SELECT serial, agent_id, assigned_user_id, assigned_at, last_seen_at FROM devices WHERE serial = ?"
    )
    .get(serial) as DeviceRow | undefined;

  return row ? rowToDevice(row) : null;
}

export function listDevicesForUser(db: Database, userId: number): DeviceRecord[] {
  const rows = db
    .prepare(
      "SELECT serial, agent_id, assigned_user_id, assigned_at, last_seen_at FROM devices " +
        "WHERE assigned_user_id = ? ORDER BY serial"
    )
    .all(userId) as unknown as DeviceRow[];

  return rows.map(rowToDevice);
}

/** 供隔离校验使用：一次性取出某用户被分配的 serial 集合 */
export function listSerialsForUser(db: Database, userId: number): Set<string> {
  const rows = db
    .prepare("SELECT serial FROM devices WHERE assigned_user_id = ?")
    .all(userId) as unknown as { serial: string }[];

  return new Set(rows.map((row) => row.serial));
}

export function countDevicesForUser(db: Database, userId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM devices WHERE assigned_user_id = ?")
    .get(userId) as { n: number | bigint };

  return Number(row.n);
}

export function listAllDevices(db: Database, onlineSerials?: Set<string>): AdminDeviceView[] {
  const rows = db
    .prepare(
      "SELECT d.serial, d.agent_id, d.assigned_user_id, d.assigned_at, d.last_seen_at, " +
        "       u.username AS assigned_username " +
        "FROM devices d LEFT JOIN users u ON u.id = d.assigned_user_id " +
        "ORDER BY d.serial"
    )
    .all() as unknown as (DeviceRow & { assigned_username: string | null })[];

  return rows.map((row) => ({
    ...rowToDevice(row),
    assignedUsername: row.assigned_username,
    online: onlineSerials ? onlineSerials.has(row.serial) : false
  }));
}

export type AssignResult = { ok: true } | { ok: false; error: string };

/**
 * 分配或收回设备。
 *
 * 这里是**配额的唯一执行点**：`max_devices` 在写入归属之前校验。
 * `userId` 传 null 表示收回。
 */
export function assignDevice(db: Database, serial: string, userId: number | null): AssignResult {
  const device = getDevice(db, serial);
  if (!device) {
    return { ok: false, error: `设备不存在：${serial}` };
  }

  if (userId !== null) {
    const user = findUserById(db, userId);
    if (!user) {
      return { ok: false, error: `用户不存在：${userId}` };
    }

    if (user.role !== "customer") {
      return { ok: false, error: "只能把设备分配给客户账号" };
    }

    if (user.status !== "active") {
      return { ok: false, error: `账号 ${user.username} 已被禁用` };
    }

    if (device.assignedUserId !== null && device.assignedUserId !== userId) {
      return { ok: false, error: `设备已分配给其它账号（用户 id ${device.assignedUserId}），请先收回` };
    }

    const alreadyMine = device.assignedUserId === userId;
    if (!alreadyMine) {
      const current = countDevicesForUser(db, userId);
      if (current >= user.maxDevices) {
        return {
          ok: false,
          error: `超出配额：${user.username} 最多 ${user.maxDevices} 台，当前已分配 ${current} 台`
        };
      }
    }
  }

  db.prepare("UPDATE devices SET assigned_user_id = ?, assigned_at = ? WHERE serial = ?").run(
    userId,
    userId === null ? null : nowIso(),
    serial
  );

  return { ok: true };
}

/** 账号被删除或禁用时，把其名下设备全部收回。 */
export function releaseAllDevices(db: Database, userId: number): number {
  const result = db
    .prepare("UPDATE devices SET assigned_user_id = NULL, assigned_at = NULL WHERE assigned_user_id = ?")
    .run(userId);

  return Number(result.changes);
}
