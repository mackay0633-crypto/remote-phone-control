import { useEffect, useState } from "react";
import { AccountSettings } from "./AccountSettings";
import { AdminView } from "./AdminView";
import { AutomationView } from "./AutomationView";
import { ConsoleView } from "./ConsoleView";
import { LoginView, createLocalUser } from "./LoginView";
import { USE_RELAY, fetchMe, logout } from "./api/client";
import { clearSession, loadSession, saveSession, type SessionUser, type StoredSession } from "./api/session";
import { ThemePicker } from "./themes/ThemePicker";
import {
  resolveLayout,
  resolveTheme,
  setLayout,
  setTheme,
  usesSidebar,
  type LayoutId,
  type ThemeId
} from "./themes/theme";
import "./styles.css";
// 主题覆盖层与五套变量必须在 styles.css **之后**加载：它们靠 [data-theme] 前缀
// 提高特异性压过基础样式，顺序反了就会被基础样式盖回去
import "./themes/palette.css";
import "./themes/themes.css";
// 布局结构的样式（只管摆位与尺寸，不管颜色）
import "./layouts/layout.css";

type View = "console" | "automation" | "admin";

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 布局与主题是两个独立的轴：布局决定"摆在哪"，主题决定"什么颜色"
  const [layout, setLayoutState] = useState<LayoutId>(resolveLayout);
  const [theme, setThemeState] = useState<ThemeId>(resolveTheme);

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

  /** 换绑邮箱后同步用户信息（用户名与令牌都不变，只有邮箱变） */
  function handleUserChanged(user: SessionUser): void {
    setSession((current) => {
      if (!current) {
        return current;
      }

      const next: StoredSession = { token: current.token, user };
      saveSession(next.token, next.user);
      return next;
    });
  }

  /**
   * 改密后换掉本地令牌。
   *
   * 服务端吊销了全部会话，只给当前设备补发了一个新令牌；不换的话，
   * 下一次请求和 WebSocket 重连都会用那个已失效的旧令牌。
   * ConsoleView 的 WS effect 依赖 token，所以这里更新后会自动重连。
   */
  function handleTokenRefreshed(token: string): void {
    setSession((current) => {
      if (!current) {
        return current;
      }

      const next: StoredSession = { token, user: current.user };
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
            <div className="eyebrow">外贸易</div>
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
  // 非管理员不能进管理页；服务端同样会 403。控制台与自动化所有人可见。
  const activeView: View = !isAdmin && view === "admin" ? "console" : view;
  const sidebar = usesSidebar(layout);

  /** 导航项只定义一次，顶栏与左栏两种摆法共用 */
  const navItems: { id: View; label: string; icon: string }[] = [
    { id: "console", label: "控制台", icon: "▤" },
    { id: "automation", label: "自动化", icon: "⚙" },
    ...(isAdmin ? [{ id: "admin" as View, label: "管理", icon: "◉" }] : [])
  ];

  const navButtons = (className: string) => (
    <div className={className}>
      {navItems.map((item) => (
        <button
          key={item.id}
          type="button"
          className={activeView === item.id ? "active" : ""}
          onClick={() => setView(item.id)}
        >
          {className === "side-rail-nav" ? <span className="side-rail-icon">{item.icon}</span> : null}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );

  const actions = (
    <div className={sidebar ? "side-rail-actions" : "top-bar-actions"}>
      {/* 只在预览模式下出现（?theme= / ?layout= / ?preview=1），正常用户看不到 */}
      <ThemePicker
        layout={layout}
        theme={theme}
        onPick={(nextLayout, nextTheme) => {
          setLayoutState(nextLayout);
          setLayout(nextLayout);
          setThemeState(nextTheme);
          setTheme(nextTheme);
        }}      />
      {USE_RELAY ? (
        <>
          <button type="button" className="top-bar-action neutral" onClick={() => setSettingsOpen(true)}>
            账号设置
          </button>
          <button type="button" className="top-bar-action" onClick={() => void handleLogout()}>
            退出登录
          </button>
        </>
      ) : (
        <span className="top-bar-note">本地直连模式</span>
      )}
    </div>
  );

  return (
    <main className={`app-shell ${sidebar ? "has-side-rail" : ""}`}>
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />

      {sidebar ? (
        <aside className="side-rail">
          <div className="side-rail-brand">
            <span className="side-rail-logo">外</span>
            <span className="side-rail-brand-text">外贸易</span>
          </div>

          {navButtons("side-rail-nav")}

          <div className="side-rail-user">
            <span className={`role-badge ${session.user.role}`}>{isAdmin ? "管理员" : "客户"}</span>
            <span className="top-bar-username">{session.user.username}</span>
          </div>

          {actions}
        </aside>
      ) : null}

      <div className={sidebar ? "shell-main" : undefined}>
        {sidebar ? null : (
          <div className="top-bar">
            <div className="top-bar-identity">
              <span className={`role-badge ${session.user.role}`}>{isAdmin ? "管理员" : "客户"}</span>
              <span className="top-bar-username">{session.user.username}</span>
            </div>
            {navButtons("top-bar-nav")}
            {actions}
          </div>
        )}

        {settingsOpen ? (
          <AccountSettings
            user={session.user}
            onClose={() => setSettingsOpen(false)}
            onUserChanged={handleUserChanged}
            onTokenRefreshed={handleTokenRefreshed}
          />
        ) : null}

        {activeView === "admin" ? (
          <AdminView user={session.user} />
        ) : activeView === "automation" ? (
          <AutomationView token={session.token} user={session.user} />
        ) : (
          <ConsoleView
            token={session.token}
            user={session.user}
            layout={layout}
            onCapabilitiesChanged={handleCapabilitiesChanged}
          />
        )}
      </div>
    </main>
  );
}
