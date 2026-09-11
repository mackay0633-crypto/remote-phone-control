import { useEffect, useState } from "react";
import { AdminView } from "./AdminView";
import { ConsoleView } from "./ConsoleView";
import { LoginView, createLocalUser } from "./LoginView";
import { USE_RELAY, fetchMe, logout } from "./api/client";
import { clearSession, loadSession, saveSession, type SessionUser, type StoredSession } from "./api/session";
import "./styles.css";

type View = "console" | "admin";

/**
 * 应用外壳：会话生命周期 + 视图切换。
 *
 * 两种模式：
 *   - 中继模式：走账号系统。未登录显示登录页；登录后 WS 首条消息携带令牌
 *   - 本地模式：直连本机 Agent（Agent 没有账号体系），跳过登录
 */
export function App() {
  const [session, setSession] = useState<StoredSession | null>(() =>
    USE_RELAY ? loadSession() : { token: "", user: createLocalUser() }
  );

  // 只有「中继模式 + 本地存有令牌」才需要先向服务端确认一次
  const [verifying, setVerifying] = useState(() => USE_RELAY && loadSession() !== null);
  const [view, setView] = useState<View>("console");

  useEffect(() => {
    if (!USE_RELAY) {
      return;
    }

    const stored = loadSession();
    if (!stored) {
      setVerifying(false);
      return;
    }

    let cancelled = false;

    // 令牌可能已过期或被吊销；顺便拿回最新的权限与配额
    fetchMe()
      .then((result) => {
        if (cancelled) {
          return;
        }
        saveSession(stored.token, result.user);
        setSession({ token: stored.token, user: result.user });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        clearSession();
        setSession(null);
      })
      .finally(() => {
        if (!cancelled) {
          setVerifying(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function handleAuthenticated(): void {
    // 登录页已把令牌写入 localStorage，这里同步进组件状态
    const stored = loadSession();
    if (stored) {
      setSession(stored);
      setView("console");
    }
  }

  async function handleLogout(): Promise<void> {
    try {
      await logout();
    } catch {
      // 服务端失败也要清本地，否则用户会卡在无法登出的状态
    }

    clearSession();
    setSession(USE_RELAY ? null : { token: "", user: createLocalUser() });
    setView("console");
  }

  /**
   * 服务端推来的权限变更（管理员刚改了开关）。
   *
   * 同步更新组件状态与 localStorage，让页面上的按钮立刻反映新权限——
   * 服务端本身已拒绝越权操作，这一步是为了 UI 不撒谎。
   */
  function handleCapabilitiesChanged(capabilities: SessionUser["capabilities"], role: SessionUser["role"]): void {
    setSession((current) => {
      if (!current) {
        return current;
      }

      const next: StoredSession = { token: current.token, user: { ...current.user, capabilities, role } };
      saveSession(next.token, next.user);
      return next;
    });
  }

  if (verifying) {
    return (
      <main className="auth-shell">
        <div className="ambient ambient-a" />
        <div className="ambient ambient-b" />
        <section className="auth-card">
          <div className="auth-brand">
            <div className="eyebrow">Remote Phone Control</div>
            <h1>正在恢复会话…</h1>
          </div>
        </section>
      </main>
    );
  }

  if (!session) {
    return <LoginView onAuthenticated={handleAuthenticated} />;
  }

  const isAdmin = session.user.role === "admin";
  // 非管理员即使把 view 改成 admin 也进不去；服务端同样会 403
  const activeView: View = isAdmin ? view : "console";

  return (
    <main className="app-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />

      <div className="top-bar">
        <div className="top-bar-identity">
          <span className={`role-badge ${session.user.role}`}>{isAdmin ? "管理员" : "客户"}</span>
          <span className="top-bar-username">{session.user.username}</span>
        </div>

        {isAdmin ? (
          <div className="top-bar-nav">
            <button
              type="button"
              className={activeView === "console" ? "active" : ""}
              onClick={() => setView("console")}
            >
              控制台
            </button>
            <button
              type="button"
              className={activeView === "admin" ? "active" : ""}
              onClick={() => setView("admin")}
            >
              管理
            </button>
          </div>
        ) : (
          <div className="top-bar-nav" />
        )}

        {USE_RELAY ? (
          <button type="button" className="top-bar-action" onClick={() => void handleLogout()}>
            退出登录
          </button>
        ) : (
          <span className="top-bar-note">本地直连模式</span>
        )}
      </div>

      {activeView === "admin" ? (
        <AdminView user={session.user} />
      ) : (
        <ConsoleView
          token={session.token}
          user={session.user}
          onCapabilitiesChanged={handleCapabilitiesChanged}
        />
      )}
    </main>
  );
}
