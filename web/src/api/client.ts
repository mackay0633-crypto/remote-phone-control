import { getToken, type SessionUser } from "./session";

/**
 * 中继模式判定。
 *
 * 两种来源，按优先级：
 *
 *   1. **显式指定** `VITE_RELAY_WS_BASE_URL` —— 构建时变量
 *   2. **按页面来源自动判断**（未指定时）：
 *        从 localhost / 127.0.0.1 打开  → 本地直连模式（连本机 Agent 5071）
 *        从其它地址打开                 → 同源中继模式
 *
 * 为什么要第 2 条：构建时变量会被**烤进产物**，意味着「构建一次只能部署到一个地址」。
 * 按来源判断后，同一份 `dist` 部署到任何域名都能工作，
 * 而且 nginx 反代同源不需要配 CORS。
 */
const EXPLICIT_RELAY_BASE = ((import.meta.env.VITE_RELAY_WS_BASE_URL as string | undefined) ?? "")
  .trim()
  .replace(/\/+$/, "");

/** 从当前页面地址推导同源中继基址；本地或 file:// 返回空串。 */
function detectSameOriginRelay(): string {
  if (typeof window === "undefined") {
    return "";
  }

  const { protocol, hostname, host } = window.location;

  // 直接用文件打开，或本地开发服务器 —— 走本地直连
  if (protocol === "file:" || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return "";
  }

  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}`;
}

/** 中继 WebSocket 基址（去掉末尾斜杠）；为空表示本地直连模式。 */
export const RELAY_WS_BASE_URL = EXPLICIT_RELAY_BASE || detectSameOriginRelay();

/** 是否处于中继模式 —— 决定要不要走账号系统。 */
export const USE_RELAY = RELAY_WS_BASE_URL.length > 0;

/**
 * API 基址。
 *
 * 同源部署时用**相对路径**（空串），请求直接打到当前域名，由 nginx 反代到 relay。
 * 这样换域名、换协议（http/https）都不用重新构建。
 */
export const API_BASE_URL = !USE_RELAY
  ? "http://127.0.0.1:5071"
  : EXPLICIT_RELAY_BASE
    ? EXPLICIT_RELAY_BASE.replace(/^ws/, "http")
    : "";

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
