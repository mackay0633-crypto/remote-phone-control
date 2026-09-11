import { useState, type FormEvent } from "react";
import { ApiError, login, register } from "./api/client";
import { saveSession, type SessionUser } from "./api/session";

interface LoginViewProps {
  onAuthenticated: (token: string) => void;
}

/**
 * 登录 / 注册页。
 *
 * 注册后立即自动登录：新账号的权限与配额都是 0，
 * 进去后会看到「等待管理员分配设备」的提示——
 * 比直接拒绝登录更友好，也少一堆「为什么登不上」的询问。
 */
export function LoginView({ onAuthenticated }: LoginViewProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function switchMode(next: "login" | "register"): void {
    setMode(next);
    setError("");
    setNotice("");
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) {
      return;
    }

    setError("");
    setNotice("");

    const name = username.trim();
    if (!name || !password) {
      setError("请填写用户名和密码");
      return;
    }

    if (mode === "register" && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }

    setBusy(true);

    try {
      if (mode === "register") {
        await register(name, password);
        setNotice("注册成功，正在登录…");
      }

      const result = await login(name, password);
      saveSession(result.token, result.user);
      onAuthenticated(result.token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />

      <section className="auth-card">
        <div className="auth-brand">
          <div className="eyebrow">Remote Phone Control</div>
          <h1>{mode === "login" ? "登录" : "注册"}</h1>
          <p>
            {mode === "login"
              ? "使用你的账号登录，查看和操作分配给你的设备。"
              : "注册后由管理员为你分配设备，分配完成前暂时看不到任何设备。"}
          </p>
        </div>

        <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
          <label className="auth-field">
            <span>用户名</span>
            <input
              type="text"
              value={username}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="3~32 位字母、数字、点、下划线或连字符"
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>

          <label className="auth-field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder="至少 8 位"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          {mode === "register" ? (
            <label className="auth-field">
              <span>确认密码</span>
              <input
                type="password"
                value={confirm}
                autoComplete="new-password"
                onChange={(event) => setConfirm(event.target.value)}
              />
            </label>
          ) : null}

          {error ? <div className="auth-message error">{error}</div> : null}
          {notice ? <div className="auth-message notice">{notice}</div> : null}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? "处理中…" : mode === "login" ? "登录" : "注册并登录"}
          </button>
        </form>

        <div className="auth-switch">
          {mode === "login" ? (
            <>
              还没有账号？
              <button type="button" onClick={() => switchMode("register")}>
                注册一个
              </button>
            </>
          ) : (
            <>
              已有账号？
              <button type="button" onClick={() => switchMode("login")}>
                去登录
              </button>
            </>
          )}
        </div>
      </section>
    </main>
  );
}

/** 本地模式下的占位用户：Agent 没有账号系统，视为本机管理员。 */
export function createLocalUser(): SessionUser {
  return {
    id: 0,
    username: "local",
    role: "admin",
    status: "active",
    createdAt: new Date().toISOString(),
    capabilities: {
      can_view_devices: true,
      can_view_stream: true,
      can_control_input: true,
      can_run_dayil: true,
      can_send_video: true,
      can_upload_video: true
    },
    quota: { maxDevices: 0, maxConcurrentTasks: 1, maxStorageBytes: 0 }
  };
}
