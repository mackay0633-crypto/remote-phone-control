import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  adminApi,
  type AdminDevice,
  type AdminUser,
  type AuditEntry,
  type CapabilityMeta
} from "./api/client";
import type { SessionCapabilities, SessionUser } from "./api/session";

interface AdminViewProps {
  user: SessionUser;
}

type Busy = string | null;
type Tab = "customers" | "devices" | "audit";

/**
 * 管理页面。
 *
 * 三块：客户与权限、设备分配、审计日志。
 *
 * 设计上刻意让每个动作都**立即回读服务端结果**，而不是本地乐观更新——
 * 因为分配设备会被配额拒绝、改权限可能失败，
 * 乐观更新会让界面显示一个并不存在的状态。
 */
export function AdminView({ user }: AdminViewProps) {
  const [tab, setTab] = useState<Tab>("customers");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [devices, setDevices] = useState<AdminDevice[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityMeta[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);

  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);

  const refreshAll = useCallback(async (): Promise<void> => {
    const [meta, userList, deviceList] = await Promise.all([
      adminApi.meta(),
      adminApi.listUsers(),
      adminApi.listDevices()
    ]);

    setCapabilities(meta.capabilities);
    setUsers(userList.users);
    setDevices(deviceList.devices);
  }, []);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    refreshAll()
      .then(() => {
        if (!cancelled) {
          setError("");
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [refreshAll]);

  // 默认选中第一个客户账号（列表里第一个就是 admin，跳过它）
  useEffect(() => {
    if (selectedUserId !== null || users.length === 0) {
      return;
    }

    const firstCustomer = users.find((item) => item.role === "customer");
    setSelectedUserId(firstCustomer ? firstCustomer.id : null);
  }, [users, selectedUserId]);

  const selectedUser = useMemo(
    () => users.find((item) => item.id === selectedUserId) ?? null,
    [users, selectedUserId]
  );

  const assignedDevices = useMemo(
    () => (selectedUser ? devices.filter((device) => device.assignedUserId === selectedUser.id) : []),
    [devices, selectedUser]
  );

  const availableDevices = useMemo(() => devices.filter((device) => device.assignedUserId === null), [devices]);

  /** 包一层：统一处理忙碌标记、错误提示、以及动作后的重新拉取 */
  async function run(key: string, action: () => Promise<void>, successText?: string): Promise<void> {
    if (busy) {
      return;
    }

    setBusy(key);
    setError("");
    setNotice("");

    try {
      await action();
      await refreshAll();
      if (successText) {
        setNotice(successText);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function toggleCapability(key: keyof SessionCapabilities, next: boolean): void {
    if (!selectedUser) {
      return;
    }

    void run(
      `cap:${key}`,
      async () => {
        await adminApi.updateUser(selectedUser.id, { capabilities: { [key]: next } });
      },
      "权限已更新，在线连接会立即生效"
    );
  }

  function updateQuota(field: "maxDevices" | "maxConcurrentTasks" | "maxStorageBytes", raw: string): void {
    if (!selectedUser) {
      return;
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      setError("配额必须是非负数字");
      return;
    }

    void run(`quota:${field}`, async () => {
      await adminApi.updateUser(selectedUser.id, { quota: { [field]: Math.trunc(value) } });
    });
  }

  function setStatus(status: "active" | "disabled"): void {
    if (!selectedUser) {
      return;
    }

    void run(
      "status",
      async () => {
        await adminApi.updateUser(selectedUser.id, { status });
      },
      status === "disabled" ? "账号已禁用，其在线连接已被断开" : "账号已启用"
    );
  }

  function assign(serial: string, userId: number | null): void {
    void run(
      `assign:${serial}`,
      async () => {
        await adminApi.assignDevice(serial, userId);
      },
      userId === null ? `已收回 ${serial}` : `已分配 ${serial}`
    );
  }

  function loadAudit(): void {
    void run("audit", async () => {
      const result = await adminApi.audit(200);
      setAudit(result.entries);
    });
  }

  const customers = users.filter((item) => item.role === "customer");

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">Administration</div>
          <h1>管理后台</h1>
          <p>分配手机、开关权限、查看操作记录。改动对已登录的连接立即生效。</p>
        </div>

        <div className="stats-grid">
          <MetricCard label="客户账号" value={String(customers.length).padStart(2, "0")} hint="不含管理员" />
          <MetricCard
            label="设备总数"
            value={String(devices.length).padStart(2, "0")}
            hint={`在线 ${devices.filter((device) => device.online).length} 台`}
          />
          <MetricCard
            label="已分配"
            value={String(devices.filter((device) => device.assignedUserId !== null).length).padStart(2, "0")}
            hint="归属某个客户"
          />
          <MetricCard
            label="空闲设备"
            value={String(availableDevices.length).padStart(2, "0")}
            hint="可分配"
            accent={availableDevices.length > 0}
          />
        </div>
      </section>

      <div className="admin-tabs">
        <button type="button" className={tab === "customers" ? "active" : ""} onClick={() => setTab("customers")}>
          客户与权限
        </button>
        <button type="button" className={tab === "devices" ? "active" : ""} onClick={() => setTab("devices")}>
          设备分配
        </button>
        <button
          type="button"
          className={tab === "audit" ? "active" : ""}
          onClick={() => {
            setTab("audit");
            loadAudit();
          }}
        >
          审计日志
        </button>
      </div>

      {error ? <div className="admin-banner error">{error}</div> : null}
      {notice ? <div className="admin-banner notice">{notice}</div> : null}

      {loading ? <div className="admin-loading">正在加载…</div> : null}

      {!loading && tab === "customers" ? (
        <section className="admin-grid">
          <article className="admin-panel">
            <div className="panel-header">
              <div>
                <div className="panel-kicker">客户列表</div>
                <h2>{customers.length} 个账号</h2>
              </div>
            </div>

            <div className="admin-user-list">
              {customers.length === 0 ? (
                <div className="admin-empty">还没有客户注册。客户在登录页自行注册后会出现在这里。</div>
              ) : (
                customers.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`admin-user-card ${item.id === selectedUserId ? "selected" : ""} ${
                      item.status === "disabled" ? "disabled" : ""
                    }`}
                    onClick={() => setSelectedUserId(item.id)}
                  >
                    <div className="admin-user-top">
                      <span className="admin-user-name">{item.username}</span>
                      <span className={`status-pill ${item.status === "active" ? "online" : "offline"} compact`}>
                        {item.status === "active" ? "启用" : "已禁用"}
                      </span>
                    </div>
                    <div className="admin-user-meta">
                      设备 {item.deviceCount} / {item.quota.maxDevices}
                    </div>
                  </button>
                ))
              )}
            </div>
          </article>

          <article className="admin-panel">
            {!selectedUser ? (
              <div className="admin-empty">左侧选择一个客户账号</div>
            ) : (
              <>
                <div className="panel-header">
                  <div>
                    <div className="panel-kicker">选中账号</div>
                    <h2>{selectedUser.username}</h2>
                  </div>
                  <button
                    type="button"
                    className="top-bar-action"
                    disabled={busy !== null}
                    onClick={() => setStatus(selectedUser.status === "active" ? "disabled" : "active")}
                  >
                    {selectedUser.status === "active" ? "禁用账号" : "启用账号"}
                  </button>
                </div>

                <h3 className="admin-section-title">权限开关</h3>
                <p className="admin-hint">
                  「查看设备列表」是基础开关，关掉后其余权限都失去意义。
                </p>
                <div className="admin-capabilities">
                  {capabilities.map((capability) => {
                    const checked = selectedUser.capabilities[capability.key] === true;
                    return (
                      <label key={capability.key} className={`admin-capability ${checked ? "on" : ""}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy !== null}
                          onChange={(event) => toggleCapability(capability.key, event.target.checked)}
                        />
                        <span>{capability.label}</span>
                      </label>
                    );
                  })}
                </div>

                <h3 className="admin-section-title">配额</h3>
                <div className="admin-quota">
                  <QuotaField
                    label="最多设备"
                    value={selectedUser.quota.maxDevices}
                    hint={`当前已分配 ${selectedUser.deviceCount} 台`}
                    disabled={busy !== null}
                    onCommit={(value) => updateQuota("maxDevices", value)}
                  />
                  <QuotaField
                    label="并发任务"
                    value={selectedUser.quota.maxConcurrentTasks}
                    hint="同时可运行的任务数"
                    disabled={busy !== null}
                    onCommit={(value) => updateQuota("maxConcurrentTasks", value)}
                  />
                  <QuotaField
                    label="存储上限 (MB)"
                    value={Math.round(selectedUser.quota.maxStorageBytes / (1024 * 1024))}
                    hint="视频素材总容量"
                    disabled={busy !== null}
                    onCommit={(value) => updateQuota("maxStorageBytes", String(Number(value) * 1024 * 1024))}
                  />
                </div>

                <h3 className="admin-section-title">
                  已分配设备（{assignedDevices.length} / {selectedUser.quota.maxDevices}）
                </h3>
                {selectedUser.quota.maxDevices === 0 ? (
                  <div className="admin-hint warn">
                    配额为 0，无法分配任何设备。请先把「最多设备」调大。
                  </div>
                ) : null}
                <div className="admin-device-list">
                  {assignedDevices.length === 0 ? (
                    <div className="admin-empty">尚未分配设备</div>
                  ) : (
                    assignedDevices.map((device) => (
                      <div key={device.serial} className="admin-device-row">
                        <span className={`device-dot ${device.online ? "online" : "offline"}`} />
                        <span className="admin-device-serial">{device.serial}</span>
                        <button
                          type="button"
                          className="top-bar-action"
                          disabled={busy !== null}
                          onClick={() => assign(device.serial, null)}
                        >
                          收回
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </article>
        </section>
      ) : null}

      {!loading && tab === "devices" ? (
        <section className="admin-panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">全部设备</div>
              <h2>{devices.length} 台</h2>
            </div>
            <div className="panel-note">选择客户后点击「分配」即可把设备归属过去</div>
          </div>

          <div className="admin-assign-target">
            <span>分配到：</span>
            <select
              value={selectedUserId ?? ""}
              onChange={(event) => setSelectedUserId(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">（未选择）</option>
              {customers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.username}（已用 {item.deviceCount}/{item.quota.maxDevices}）
                </option>
              ))}
            </select>
          </div>

          <div className="admin-table">
            <div className="admin-table-head">
              <span>设备</span>
              <span>状态</span>
              <span>归属</span>
              <span>操作</span>
            </div>
            {devices.map((device) => (
              <div key={device.serial} className="admin-table-row">
                <span className="admin-device-serial">{device.serial}</span>
                <span>
                  <span className={`device-dot ${device.online ? "online" : "offline"}`} />
                  {device.online ? "在线" : "离线"}
                </span>
                <span>{device.assignedUsername ?? <em className="muted">空闲</em>}</span>
                <span className="admin-row-actions">
                  {device.assignedUserId !== null ? (
                    <button
                      type="button"
                      className="top-bar-action"
                      disabled={busy !== null}
                      onClick={() => assign(device.serial, null)}
                    >
                      收回
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="top-bar-action primary"
                      disabled={busy !== null || selectedUserId === null}
                      onClick={() => selectedUserId !== null && assign(device.serial, selectedUserId)}
                    >
                      分配
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {!loading && tab === "audit" ? (
        <section className="admin-panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">操作记录</div>
              <h2>最近 {audit.length} 条</h2>
            </div>
            <button type="button" className="top-bar-action" disabled={busy !== null} onClick={loadAudit}>
              刷新
            </button>
          </div>

          <div className="admin-table audit">
            <div className="admin-table-head">
              <span>时间</span>
              <span>操作者</span>
              <span>动作</span>
              <span>目标</span>
            </div>
            {audit.map((entry) => (
              <div key={entry.id} className="admin-table-row">
                <span>{new Date(entry.created_at).toLocaleString("zh-CN")}</span>
                <span>{entry.actor_username ?? "-"}</span>
                <span className="admin-action">{entry.action}</span>
                <span className="admin-device-serial">{entry.target ?? "-"}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

function QuotaField({
  label,
  value,
  hint,
  disabled,
  onCommit
}: {
  label: string;
  value: number;
  hint: string;
  disabled: boolean;
  onCommit: (raw: string) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  // 外部值变化（刷新后）要同步回输入框；用 value 作 key 会重建组件，这里手动同步
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <label className="admin-quota-field">
      <span className="admin-quota-label">{label}</span>
      <input
        type="number"
        min={0}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== String(value)) {
            onCommit(draft);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
      />
      <span className="admin-quota-hint">{hint}</span>
    </label>
  );
}

function MetricCard({
  label,
  value,
  hint,
  accent = true
}: {
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <article className={`metric-card ${accent ? "accent" : ""}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      <div className="metric-hint">{hint}</div>
    </article>
  );
}
