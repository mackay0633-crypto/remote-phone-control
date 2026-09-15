import { useState, type FormEvent } from "react";
import { ApiError, changeEmail, changePassword, requestEmailChangeCode } from "./api/client";
import type { SessionUser } from "./api/session";
import { useCooldown } from "./useCooldown";

interface AccountSettingsProps {
  user: SessionUser;
  onClose: () => void;
  /** 换绑邮箱成功后同步新的用户信息 */
  onUserChanged: (user: SessionUser) => void;
  /** 改密会吊销全部会话并补发一个，本地令牌必须跟着换掉 */
  onTokenRefreshed: (token: string) => void;
}

/** 与后端 `EMAIL_PATTERN` 保持一致的宽松校验 */
const EMAIL_HINT = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const CODE_LENGTH = 6;

/**
 * 账号设置：换绑邮箱 + 修改密码。
 *
 * 两件事都用「输入当前密码」作为额外门槛——它们是仅有的两个能改变
 * 账号找回方式的操作，只凭一个被盗的会话就能完成的话，等于白送账号。
 */
export function AccountSettings({ user, onClose, onUserChanged, onTokenRefreshed }: AccountSettingsProps) {
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [emailNotice, setEmailNotice] = useState("");
  const [cooldown, startCooldown] = useCooldown();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordNotice, setPasswordNotice] = useState("");

  async function handleSendCode(): Promise<void> {
    if (sendingCode || emailBusy || cooldown > 0) {
      return;
    }

    setEmailError("");
    setEmailNotice("");

    const address = email.trim();
    if (!EMAIL_HINT.test(address)) {
      setEmailError("请先填写正确的新邮箱");
      return;
    }

    if (user.email && address.toLowerCase() === user.email.toLowerCase()) {
      setEmailError("新邮箱与当前邮箱相同");
      return;
    }

    setSendingCode(true);

    try {
      const result = await requestEmailChangeCode(address);
      startCooldown(result.resendAfterSeconds);

      if (result.devCode) {
        setEmailCode(result.devCode);
        setEmailNotice(`开发模式：验证码 ${result.devCode} 已自动填入（真实部署会发到邮箱）`);
      } else {
        setEmailNotice(`验证码已发送至 ${result.email}，请查收后填入`);
      }
    } catch (err) {
      setEmailError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSendingCode(false);
    }
  }

  async function handleEmailSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (emailBusy) {
      return;
    }

    setEmailError("");
    setEmailNotice("");

    const address = email.trim();
    if (!EMAIL_HINT.test(address)) {
      setEmailError("请填写正确的新邮箱");
      return;
    }

    if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(emailCode.trim())) {
      setEmailError(`请填写 ${CODE_LENGTH} 位数字验证码`);
      return;
    }

    if (!emailPassword) {
      setEmailError("请输入当前密码");
      return;
    }

    setEmailBusy(true);

    try {
      const result = await changeEmail(address, emailCode.trim(), emailPassword);
      if (result.user) {
        onUserChanged(result.user);
      }

      setEmail("");
      setEmailCode("");
      setEmailPassword("");
      setEmailNotice(`邮箱已更换为 ${address}`);
    } catch (err) {
      setEmailError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setEmailBusy(false);
    }
  }

  async function handlePasswordSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (passwordBusy) {
      return;
    }

    setPasswordError("");
    setPasswordNotice("");

    if (!currentPassword || !newPassword) {
      setPasswordError("请填写当前密码与新密码");
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError("两次输入的新密码不一致");
      return;
    }

    setPasswordBusy(true);

    try {
      const result = await changePassword(currentPassword, newPassword);
      // 服务端吊销了全部会话并补发了当前设备的令牌，必须换掉本地的旧令牌
      onTokenRefreshed(result.token);

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordNotice("密码已修改，其它设备上的登录已全部失效");
    } catch (err) {
      setPasswordError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setPasswordBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      {/* 点内容区不应该关掉弹窗，所以拦一下冒泡 */}
      <section className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="panel-kicker">账号设置</div>
            <h2>{user.username}</h2>
          </div>
          <button type="button" className="top-bar-action neutral" onClick={onClose}>
            关闭
          </button>
        </div>

        <h3 className="admin-section-title">邮箱</h3>
        <p className="admin-hint">
          当前邮箱：
          {user.email ? (
            <>
              <strong>{user.email}</strong>
              {user.emailVerified ? "（已验证）" : "（未验证）"}
            </>
          ) : (
            "未绑定"
          )}
          。邮箱是找回密码的唯一凭据，换绑需要同时通过新邮箱验证码与当前密码。
        </p>

        <form className="auth-form" onSubmit={(event) => void handleEmailSubmit(event)}>
          <label className="auth-field">
            <span>新邮箱</span>
            <input
              type="email"
              value={email}
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="要换成的邮箱"
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          <div className="auth-field">
            <span>验证码</span>
            <div className="auth-code-row">
              <input
                type="text"
                inputMode="numeric"
                value={emailCode}
                maxLength={CODE_LENGTH}
                autoComplete="one-time-code"
                placeholder={`${CODE_LENGTH} 位数字`}
                onChange={(event) => setEmailCode(event.target.value.replace(/\D/g, ""))}
              />
              <button
                type="button"
                className="auth-code-button"
                onClick={() => void handleSendCode()}
                disabled={sendingCode || emailBusy || cooldown > 0}
              >
                {cooldown > 0 ? `${cooldown} 秒后重发` : sendingCode ? "发送中…" : "获取验证码"}
              </button>
            </div>
          </div>

          <label className="auth-field">
            <span>当前密码</span>
            <input
              type="password"
              value={emailPassword}
              autoComplete="current-password"
              placeholder="确认是你本人操作"
              onChange={(event) => setEmailPassword(event.target.value)}
            />
          </label>

          {emailError ? <div className="auth-message error">{emailError}</div> : null}
          {emailNotice ? <div className="auth-message notice">{emailNotice}</div> : null}

          <button type="submit" className="auth-submit" disabled={emailBusy}>
            {emailBusy ? "处理中…" : "更换邮箱"}
          </button>
        </form>

        <h3 className="admin-section-title">密码</h3>
        <p className="admin-hint">修改密码会吊销全部已登录的会话，只在当前设备保留登录状态。</p>

        <form className="auth-form" onSubmit={(event) => void handlePasswordSubmit(event)}>
          <label className="auth-field">
            <span>当前密码</span>
            <input
              type="password"
              value={currentPassword}
              autoComplete="current-password"
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </label>

          <label className="auth-field">
            <span>新密码</span>
            <input
              type="password"
              value={newPassword}
              autoComplete="new-password"
              placeholder="至少 8 位"
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>

          <label className="auth-field">
            <span>确认新密码</span>
            <input
              type="password"
              value={confirmPassword}
              autoComplete="new-password"
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </label>

          {passwordError ? <div className="auth-message error">{passwordError}</div> : null}
          {passwordNotice ? <div className="auth-message notice">{passwordNotice}</div> : null}

          <button type="submit" className="auth-submit" disabled={passwordBusy}>
            {passwordBusy ? "处理中…" : "修改密码"}
          </button>
        </form>
      </section>
    </div>
  );
}
