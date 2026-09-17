import { useState, type FormEvent } from "react";
import {
  ApiError,
  login,
  register,
  requestPasswordResetCode,
  requestRegisterCode,
  resetPassword
} from "./api/client";
import { saveSession, type SessionUser } from "./api/session";
import { useCooldown } from "./useCooldown";

interface LoginViewProps {
  onAuthenticated: (token: string) => void;
}

type Mode = "login" | "register" | "reset";

/**
 * 与后端 `EMAIL_PATTERN` 保持一致的宽松校验。
 *
 * 前端校验只为「少一次白跑的请求」，不作数——真正的有效性由
 * 「能不能收到验证码」来证明。
 */
const EMAIL_HINT = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const CODE_LENGTH = 6;

/**
 * 登录 / 注册 / 找回密码。
 *
 * 注册与找回密码都是两步：先拿验证码，再提交。注册走「验证通过才建号」，
 * 所以库里不会留下「建了号但从没验证邮箱」的半成品账号。
 *
 * 开发环境（relay 侧 `MAIL_TRANSPORT=console`）会把验证码回显并自动填入；
 * 生产环境必须配好 SMTP，否则这两个流程都走不完。
 */
export function LoginView({ onAuthenticated }: LoginViewProps) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cooldown, startCooldown] = useCooldown();

  function switchMode(next: Mode): void {
    setMode(next);
    setError("");
    setNotice("");
    setCode("");
    startCooldown(0);
  }

  /** 注册与找回密码共用：两者都是「先要码，再提交」 */
  async function handleSendCode(): Promise<void> {
    if (busy || sendingCode || cooldown > 0) {
      return;
    }

    setError("");
    setNotice("");

    const address = email.trim();
    if (!EMAIL_HINT.test(address)) {
      setError("请先填写正确的邮箱");
      return;
    }

    setSendingCode(true);

    try {
      const result =
        mode === "reset" ? await requestPasswordResetCode(address) : await requestRegisterCode(address);

      startCooldown(result.resendAfterSeconds);

      if (result.devCode) {
        // console 邮件模式：直接把码填进去，省得去翻 relay 日志
        setCode(result.devCode);
        setNotice(`开发模式：验证码 ${result.devCode} 已自动填入（真实部署会发到邮箱）`);
      } else if (mode === "reset") {
        // 找回密码接口不对「邮箱是否注册过」露口风，所以这里也不能断言「已发送」
        setNotice(`如果 ${result.email} 已注册，验证码会在几分钟内送达`);
      } else {
        setNotice(
          `验证码已发送至 ${result.email}，${Math.round(result.expiresInSeconds / 60)} 分钟内有效`
        );
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSendingCode(false);
    }
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) {
      return;
    }

    setError("");
    setNotice("");

    const name = username.trim();

    // 找回密码不需要用户名：它的身份凭据是「能收到邮箱验证码」
    if (mode === "login") {
      if (!name || !password) {
        setError("请填写用户名和密码");
        return;
      }
    } else {
      if (!EMAIL_HINT.test(email.trim())) {
        setError("请填写正确的邮箱");
        return;
      }

      if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code.trim())) {
        setError(`请填写 ${CODE_LENGTH} 位数字验证码`);
        return;
      }

      if (!password) {
        setError(mode === "reset" ? "请填写新密码" : "请填写密码");
        return;
      }

      if (password !== confirm) {
        setError(mode === "reset" ? "两次输入的新密码不一致" : "两次输入的密码不一致");
        return;
      }

      if (mode === "register" && !name) {
        setError("请填写用户名");
        return;
      }
    }

    setBusy(true);

    try {
      if (mode === "reset") {
        await resetPassword(email.trim(), code.trim(), password);

        // 服务端刻意不补发令牌：用新密码重新登录一次，顺便确认记得住
        setMode("login");
        setPassword("");
        setConfirm("");
        setCode("");
        startCooldown(0);
        setNotice("密码已重置，请用新密码登录");
        return;
      }

      if (mode === "register") {
        await register(name, email.trim(), password, code.trim());
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

  const heading = mode === "login" ? "登录" : mode === "register" ? "注册" : "找回密码";

  const description =
    mode === "login"
      ? "使用你的账号登录，查看和操作分配给你的设备。"
      : mode === "register"
        ? "用邮箱验证码完成注册，之后由管理员为你分配设备，分配完成前暂时看不到任何设备。"
        : "输入注册时使用的邮箱，我们会发送验证码；验证通过后即可设置新密码。";

  return (
    <main className="auth-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />

      <section className="auth-card">
        <div className="auth-brand">
          <div className="eyebrow">外贸易</div>
          <h1>{heading}</h1>
          <p>{description}</p>
        </div>

        <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
          {mode === "login" || mode === "register" ? (
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
          ) : null}

          {mode !== "login" ? (
            <>
              <label className="auth-field">
                <span>邮箱</span>
                <input
                  type="email"
                  value={email}
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={
                    mode === "register" ? "用于接收验证码，也是账号的找回凭据" : "注册时使用的邮箱"
                  }
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>

              <div className="auth-field">
                <span>邮箱验证码</span>
                <div className="auth-code-row">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={code}
                    maxLength={CODE_LENGTH}
                    autoComplete="one-time-code"
                    placeholder={`${CODE_LENGTH} 位数字`}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                  />
                  <button
                    type="button"
                    className="auth-code-button"
                    onClick={() => void handleSendCode()}
                    disabled={busy || sendingCode || cooldown > 0}
                  >
                    {cooldown > 0 ? `${cooldown} 秒后重发` : sendingCode ? "发送中…" : "获取验证码"}
                  </button>
                </div>
              </div>
            </>
          ) : null}

          <label className="auth-field">
            <span>{mode === "reset" ? "新密码" : "密码"}</span>
            <input
              type="password"
              value={password}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder="至少 8 位"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          {mode !== "login" ? (
            <label className="auth-field">
              <span>{mode === "reset" ? "确认新密码" : "确认密码"}</span>
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
            {busy
              ? "处理中…"
              : mode === "login"
                ? "登录"
                : mode === "register"
                  ? "注册并登录"
                  : "重置密码"}
          </button>
        </form>

        <div className="auth-switch">
          {mode === "login" ? (
            <>
              还没有账号？
              <button type="button" onClick={() => switchMode("register")}>
                注册一个
              </button>
              <span className="auth-switch-sep">·</span>
              <button type="button" onClick={() => switchMode("reset")}>
                忘记密码
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
    email: null,
    emailVerified: true,
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
