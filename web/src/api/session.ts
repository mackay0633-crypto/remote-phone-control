/**
 * 会话令牌的本地存储。
 *
 * ⚠️ 安全性说明：这里用 localStorage 存令牌，实现简单、无需处理跨域 Cookie，
 * 但**无法抵御 XSS**——任何注入到页面的脚本都能读走令牌。
 *
 * 更稳妥的方案是 httpOnly Cookie + CSRF 防护（脚本读不到令牌）。
 * 选择 localStorage 是因为本项目前端与 API 可能不同源，Cookie 需要额外配置。
 * **上线前建议重新评估这一点**，尤其是页面会渲染用户上传内容时。
 */

const TOKEN_KEY = "rpc.session.token";
const USER_KEY = "rpc.session.user";

export type UserRole = "admin" | "customer";
export type UserStatus = "active" | "disabled";

export interface SessionCapabilities {
  can_view_devices: boolean;
  can_view_stream: boolean;
  can_control_input: boolean;
  can_run_dayil: boolean;
  can_send_video: boolean;
  can_upload_video: boolean;
}

export interface SessionQuota {
  maxDevices: number;
  maxConcurrentTasks: number;
  maxStorageBytes: number;
}

export interface SessionUser {
  id: number;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  capabilities: SessionCapabilities;
  quota: SessionQuota;
}

export interface StoredSession {
  token: string;
  user: SessionUser;
}

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 隐私模式下 localStorage 可能不可用，此时退化为「仅本次会话有效」
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 忽略
  }
}

export function loadSession(): StoredSession | null {
  const token = safeGet(TOKEN_KEY);
  const rawUser = safeGet(USER_KEY);

  if (!token || !rawUser) {
    return null;
  }

  try {
    return { token, user: JSON.parse(rawUser) as SessionUser };
  } catch {
    clearSession();
    return null;
  }
}

export function saveSession(token: string, user: SessionUser): void {
  safeSet(TOKEN_KEY, token);
  safeSet(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  safeRemove(TOKEN_KEY);
  safeRemove(USER_KEY);
}

export function getToken(): string {
  return safeGet(TOKEN_KEY) ?? "";
}
