import { getToken, type SessionUser } from "./session";

/**
 * API 基址。
 *
 * 中继模式：前端与 relay 同源部署（nginx 托管静态文件并反代 relay），
 * 因此直接复用 VITE_RELAY_WS_BASE_URL 的主机部分，把 ws(s) 换成 http(s)。
 *
 * 本地模式：直连本机 Agent。
 */
function resolveApiBase(): string {
  const relayWs = (import.meta.env.VITE_RELAY_WS_BASE_URL as string | undefined)?.trim();

  if (relayWs) {
    return relayWs.replace(/^ws/, "http").replace(/\/+$/, "");
  }

  return "http://127.0.0.1:5071";
}

/** 中继 WebSocket 基址（去掉末尾斜杠）；为空表示本地直连模式。 */
export const RELAY_WS_BASE_URL = ((import.meta.env.VITE_RELAY_WS_BASE_URL as string | undefined) ?? "")
  .trim()
  .replace(/\/+$/, "");

/** 是否处于中继模式 —— 决定要不要走账号系统。 */
export const USE_RELAY = RELAY_WS_BASE_URL.length > 0;

export const API_BASE_URL = resolveApiBase();

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown, withAuth = true): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json"
  };

  if (withAuth) {
    const token = getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  let response: Response;
  try {
    response = await fetch(API_BASE_URL + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    throw new ApiError(`无法连接服务器（${API_BASE_URL}）：${error instanceof Error ? error.message : String(error)}`, 0);
  }

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && typeof (payload as { error?: unknown }).error === "string"
        ? ((payload as { error: string }).error)
        : `请求失败（HTTP ${response.status}）`;
    throw new ApiError(message, response.status);
  }

  return payload as T;
}

// ─────────────────────────── 认证 ───────────────────────────

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: SessionUser;
}

export function login(username: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>("POST", "/api/auth/login", { username, password }, false);
}

export function register(username: string, password: string): Promise<{ user: SessionUser }> {
  return request<{ user: SessionUser }>("POST", "/api/auth/register", { username, password }, false);
}

export function logout(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("POST", "/api/auth/logout");
}

export function fetchMe(): Promise<{ user: SessionUser }> {
  return request<{ user: SessionUser }>("GET", "/api/auth/me");
}

export function changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean; token: string }> {
  return request<{ ok: boolean; token: string }>("POST", "/api/auth/password", { currentPassword, newPassword });
}

// ─────────────────────────── 我的设备 ───────────────────────────

export interface MyDevice {
  serial: string;
  online: boolean;
  assignedAt: string | null;
}

export function fetchMyDevices(): Promise<{ devices: MyDevice[]; permissionDenied?: boolean }> {
  return request<{ devices: MyDevice[]; permissionDenied?: boolean }>("GET", "/api/my/devices");
}

// ─────────────────────────── 管理端 ───────────────────────────

export interface AdminUser extends SessionUser {
  deviceCount: number;
}

export interface AdminDevice {
  serial: string;
  agentId: string | null;
  assignedUserId: number | null;
  assignedUsername: string | null;
  assignedAt: string | null;
  lastSeenAt: string | null;
  online: boolean;
}

export interface CapabilityMeta {
  key: keyof SessionUser["capabilities"];
  label: string;
}

export interface AuditEntry {
  id: number;
  actor_user_id: number | null;
  actor_username: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: string;
}

export const adminApi = {
  meta: () => request<{ capabilities: CapabilityMeta[] }>("GET", "/api/admin/meta"),

  listUsers: () => request<{ users: AdminUser[] }>("GET", "/api/admin/users"),

  createUser: (username: string, password: string) =>
    request<{ user: SessionUser }>("POST", "/api/admin/users", { username, password }),

  updateUser: (
    userId: number,
    patch: {
      capabilities?: Partial<SessionUser["capabilities"]>;
      quota?: Partial<SessionUser["quota"]>;
      status?: "active" | "disabled";
    }
  ) => request<{ user: SessionUser | null }>("PATCH", `/api/admin/users/${userId}`, patch),

  resetPassword: (userId: number, password: string) =>
    request<{ ok: boolean }>("POST", `/api/admin/users/${userId}/password`, { password }),

  deleteUser: (userId: number) => request<{ ok: boolean }>("DELETE", `/api/admin/users/${userId}`),

  listDevices: () => request<{ devices: AdminDevice[] }>("GET", "/api/admin/devices"),

  /** userId 传 null 表示收回设备 */
  assignDevice: (serial: string, userId: number | null) =>
    request<{ ok: boolean }>("POST", `/api/admin/devices/${encodeURIComponent(serial)}/assign`, { userId }),

  audit: (limit = 100) => request<{ entries: AuditEntry[] }>("GET", `/api/admin/audit?limit=${limit}`)
};
