import { useCallback, useEffect, useMemo, useState } from "react";
import { USE_RELAY } from "./api/client";
import { useAutomation, type AutomationDevice } from "./api/automation";
import type { SessionUser } from "./api/session";
import { LockedBlock, LockedField, LockedToast, useLockedNotice } from "./LockedFeature";
import { VideoPanel } from "./VideoPanel";

interface AutomationViewProps {
  token: string;
  user: SessionUser;
}

interface RunStatusEntry {
  id: string;
  label: string;
  source: string;
  deviceId: string;
  scriptRunId: string;
  deviceCount: number;
  startedAt: number;
  expiresAt: number;
}

type Tab = "dayil" | "video";

/** 养号参数：界面填秒/次，下发时按 autojs 的约定转换 */
interface DayilForm {
  swipeCount: number;
  playSeconds: number;
  likeProbability: number;
  followProbability: number;
  commentProbability: number;
}

const DEFAULT_DAYIL: DayilForm = {
  swipeCount: 30,
  playSeconds: 5,
  likeProbability: 20,
  followProbability: 5,
  commentProbability: 0
};

/**
 * 置灰项里展示的默认值。
 *
 * 必须与 **agent 侧 `DAYIL_DEFAULTS`**（`agent/src/autojs/autojs-validation.ts`）
 * 以及 autojs 表单的初始值（`scripts_pages/DayilWork.html`）保持一致 ——
 * 否则界面显示 3，实际下发的是别的数，客户按界面理解就会对不上。
 * 将来开放这些项时，这里直接换成可编辑的 state 即可。
 */
const DEFAULT_DAYIL_MIN_SWIPE = 3;
const DEFAULT_DAYIL_MAX_SWIPE = 6;

/**
 * 自动化面板。
 *
 * 所有请求都经由 relay 转到设备主机上的 autojs——
 * 浏览器拿不到 autojs 的地址，也不会直接接触它。
 */
export function AutomationView({ token, user }: AutomationViewProps) {
  const [tab, setTab] = useState<Tab>("dayil");
  const { state, error: connectionError, devices, request } = useAutomation(token);

  if (!USE_RELAY) {
    return (
      <section className="empty-panel">
        <div className="empty-icon">🔌</div>
        <h2>自动化仅在部署环境下可用</h2>
        <p>
          本地直连模式没有账号系统与 relay，自动化请求无法路由到设备主机。
          请通过服务器地址访问。
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">Automation</div>
          <h1>养号与发视频</h1>
          <p>任务由设备主机上的 autojs 执行，你只需要选设备、填参数、下发。</p>
        </div>

        <div className="stats-grid">
          <MetricCard
            label="连接状态"
            value={state === "ready" ? "READY" : state === "connecting" ? "SYNC" : "ERR"}
            hint={connectionError || "与服务器已就绪"}
            accent={state === "ready"}
          />
          <MetricCard label="可用设备" value={String(devices.length).padStart(2, "0")} hint="分配给你的设备" />
          <MetricCard
            label="养号权限"
            value={user.capabilities.can_run_dayil ? "YES" : "NO"}
            hint="can_run_dayil"
            accent={user.capabilities.can_run_dayil}
          />
          <MetricCard
            label="发视频权限"
            value={user.capabilities.can_send_video ? "YES" : "NO"}
            hint="can_send_video"
            accent={user.capabilities.can_send_video}
          />
        </div>
      </section>

      <div className="admin-tabs">
        <button type="button" className={tab === "dayil" ? "active" : ""} onClick={() => setTab("dayil")}>
          养号
        </button>
        <button type="button" className={tab === "video" ? "active" : ""} onClick={() => setTab("video")}>
          发视频
        </button>
      </div>

      {tab === "dayil" ? (
        <DayilPanel devices={devices} user={user} request={request} />
      ) : (
        <VideoPanel user={user} devices={devices} request={request} />
      )}
    </>
  );
}

// ────────────────────────── 养号 ──────────────────────────

function DayilPanel({
  devices,
  user,
  request
}: {
  devices: AutomationDevice[];
  user: SessionUser;
  request: (action: "dayil-work.start" | "run-status", payload?: Record<string, unknown>) => Promise<{
    ok: boolean;
    data?: unknown;
    error?: string;
  }>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [form, setForm] = useState<DayilForm>(DEFAULT_DAYIL);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [resultOk, setResultOk] = useState<boolean | null>(null);
  const [status, setStatus] = useState<RunStatusEntry[]>([]);
  const [statusBusy, setStatusBusy] = useState(false);
  // 试用版功能门：点置灰项 → 底部提示
  const locked = useLockedNotice();

  const onlineDevices = useMemo(() => devices.filter((d) => d.status === "online"), [devices]);

  const loadStatus = useCallback(async () => {
    setStatusBusy(true);
    const res = await request("run-status", {});
    setStatusBusy(false);

    if (!res.ok) {
      return;
    }

    const data = res.data as { entries?: RunStatusEntry[] } | undefined;
    setStatus(data?.entries ?? []);
  }, [request]);

  // 首次进入拉一次运行状态
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  function toggleDevice(serial: string): void {
    setSelected((current) =>
      current.includes(serial) ? current.filter((s) => s !== serial) : [...current, serial]
    );
  }

  async function submit(): Promise<void> {
    if (busy) {
      return;
    }

    if (selected.length === 0) {
      setResultOk(false);
      setResult("请先选择至少一台设备");
      return;
    }

    if (!user.capabilities.can_run_dayil) {
      setResultOk(false);
      setResult("当前账号没有下发养号的权限");
      return;
    }

    setBusy(true);
    setResultOk(null);
    setResult("正在下发…");

    // 参数名与取值范围必须与 agent 侧校验层一致（见 autojs-validation.ts）
    const res = await request("dayil-work.start", {
      device_ids: selected,
      config: {
        SWIPE_COUNT: form.swipeCount,
        PLAY_DURATION: Math.round(form.playSeconds * 1000),
        LIKE_PROBABILITY: form.likeProbability,
        FOLLOW_PROBABILITY: form.followProbability,
        COMMENT_PROBABILITY: form.commentProbability
      }
    });

    setBusy(false);
    setResultOk(res.ok);

    if (res.ok) {
      const data = res.data as { script_run_id?: string; script_type?: string } | undefined;
      setResult(`下发成功 · script_run_id = ${data?.script_run_id ?? "-"}`);
      void loadStatus();
    } else {
      setResult(res.error ?? "下发失败");
    }
  }

  return (
    <section className="admin-grid">
      <article className="admin-panel">
        <div className="panel-header">
          <div>
            <div className="panel-kicker">选择设备</div>
            <h2>
              已选 {selected.length} / {onlineDevices.length}
            </h2>
          </div>
          <div className="panel-note">
            <button
              type="button"
              className="top-bar-action neutral"
              onClick={() =>
                setSelected(
                  selected.length === onlineDevices.length ? [] : onlineDevices.map((d) => d.serial)
                )
              }
            >
              {selected.length === onlineDevices.length ? "全不选" : "全选"}
            </button>
          </div>
        </div>

        <div className="admin-device-list">
          {devices.length === 0 ? (
            <div className="admin-empty">还没有分配到设备</div>
          ) : (
            devices.map((device) => {
              const checked = selected.includes(device.serial);
              const usable = device.status === "online";
              return (
                <label
                  key={device.serial}
                  className={`admin-capability ${checked ? "on" : ""}`}
                  style={{ opacity: usable ? 1 : 0.5 }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!usable || busy}
                    onChange={() => toggleDevice(device.serial)}
                  />
                  <span>
                    <span className={`device-dot ${usable ? "online" : "offline"}`} />
                    {device.serial}
                    <em className="muted" style={{ marginLeft: 8 }}>
                      {device.model}
                    </em>
                  </span>
                </label>
              );
            })
          )}
        </div>
      </article>

      <article className="admin-panel">
        <div className="panel-header">
          <div>
            <div className="panel-kicker">养号参数</div>
            <h2>行为模拟</h2>
          </div>
        </div>

        <div className="admin-quota">
          <NumberField
            label="滑动次数"
            value={form.swipeCount}
            hint="0 ~ 10000"
            disabled={busy}
            onChange={(v) => setForm({ ...form, swipeCount: v })}
          />
          <NumberField
            label="每次观看（秒）"
            value={form.playSeconds}
            hint="换算成毫秒下发给脚本"
            disabled={busy}
            onChange={(v) => setForm({ ...form, playSeconds: v })}
          />
          <NumberField
            label="点赞概率 %"
            value={form.likeProbability}
            hint="0 ~ 100"
            disabled={busy}
            onChange={(v) => setForm({ ...form, likeProbability: v })}
          />
          <NumberField
            label="关注概率 %"
            value={form.followProbability}
            hint="0 ~ 100"
            disabled={busy}
            onChange={(v) => setForm({ ...form, followProbability: v })}
          />
          <NumberField
            label="评论概率 %"
            value={form.commentProbability}
            hint="0 ~ 100"
            disabled={busy}
            onChange={(v) => setForm({ ...form, commentProbability: v })}
          />
        </div>

        {/*
          以下选项来自 autojs 桌面端的「执行养号配置」页面，试用版暂未开放。
          全部照原样展示（含原来两列排布的项），让客户看得见完整能力；
          点击任意一项弹出统一的升级提示。
        */}
        <h3 className="admin-section-title">更多养号参数（正式版）</h3>

        <div className="locked-grid">
          <LockedField label="最少滑动次数" name="养号 · 最少滑动次数" onLocked={locked.notify} hint="默认 3">
            <input type="number" value={DEFAULT_DAYIL_MIN_SWIPE} disabled readOnly />
          </LockedField>
          <LockedField label="最多滑动次数" name="养号 · 最多滑动次数" onLocked={locked.notify} hint="默认 6">
            <input type="number" value={DEFAULT_DAYIL_MAX_SWIPE} disabled readOnly />
          </LockedField>
          <LockedField label="收藏概率 %" name="养号 · 收藏概率" onLocked={locked.notify} hint="默认 25">
            <input type="number" value={25} disabled readOnly />
          </LockedField>
          <LockedField label="搜索概率 %" name="养号 · 搜索概率" onLocked={locked.notify} hint="默认 50">
            <input type="number" value={50} disabled readOnly />
          </LockedField>
          <LockedField
            label="搜索后等待（毫秒）"
            name="养号 · 搜索后等待"
            onLocked={locked.notify}
            hint="默认 7000"
          >
            <input type="number" value={7000} disabled readOnly />
          </LockedField>
          <LockedField label="看播时间（毫秒）" name="养号 · 看播时间" onLocked={locked.notify} hint="默认 15000">
            <input type="number" value={15000} disabled readOnly />
          </LockedField>
          <LockedField
            label="定时运行时间"
            name="养号 · 定时运行"
            onLocked={locked.notify}
            hint="到点自动开跑，无需人工守着"
          >
            <input type="datetime-local" disabled readOnly />
          </LockedField>
        </div>

        <LockedBlock
          title="🤖 AI 方案生成"
          name="养号 · AI 方案生成"
          onLocked={locked.notify}
          description="输入商品 / 行业 / 品类，自动生成评论内容、搜索关键词与直播互动话术，并填入下方输入框"
        >
          <div style={{ display: "flex", gap: 8 }}>
            <input type="text" placeholder="例如：budget wigs、false nails…" disabled readOnly style={{ flex: 1 }} />
            <button type="button" className="top-bar-action neutral" disabled>
              生成方案
            </button>
          </div>
        </LockedBlock>

        <div className="locked-grid" style={{ marginTop: 14 }}>
          <LockedField
            label="直播互动内容（每行一个）"
            name="养号 · 直播互动内容"
            onLocked={locked.notify}
            hint="进入直播间时随机发送"
          >
            <textarea rows={4} value={"hello\nnice live\ngreat show"} disabled readOnly className="video-textarea" />
          </LockedField>
          <LockedField
            label="评论内容（每行一个）"
            name="养号 · 评论内容"
            onLocked={locked.notify}
            hint="命中评论概率时随机取一条"
          >
            <textarea rows={4} value={"cool\nawesome\nwow\nnice"} disabled readOnly className="video-textarea" />
          </LockedField>
          <LockedField
            label="搜索关键词（每行一个）"
            name="养号 · 搜索关键词"
            onLocked={locked.notify}
            hint="命中搜索概率时随机取一条"
          >
            <textarea rows={4} value={"technology\nmusic\ntravel"} disabled readOnly className="video-textarea" />
          </LockedField>
        </div>

        {!user.capabilities.can_run_dayil ? (
          <div className="admin-hint warn" style={{ marginTop: 16 }}>
            当前账号没有「下发养号任务」权限，请联系管理员开启。
          </div>
        ) : null}

        <div style={{ marginTop: 18, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            className="auth-submit"
            style={{ width: "auto", padding: "11px 26px" }}
            disabled={busy || !user.capabilities.can_run_dayil}
            onClick={() => void submit()}
          >
            {busy ? "下发中…" : `下发养号到 ${selected.length} 台`}
          </button>
          <button type="button" className="top-bar-action neutral" disabled={statusBusy} onClick={() => void loadStatus()}>
            {statusBusy ? "刷新中…" : "刷新运行状态"}
          </button>
          {/* autojs 桌面端把「生成」和「立即运行」拆成两步；试用版只提供合并的下发 */}
          <button
            type="button"
            className="top-bar-action neutral"
            style={{ opacity: 0.5, cursor: "not-allowed" }}
            onClick={() => locked.notify("养号 · 只生成不下发")}
          >
            仅生成脚本 🔒
          </button>
        </div>

        {result ? (
          <div className={`admin-banner ${resultOk === false ? "error" : resultOk === true ? "notice" : ""}`} style={{ marginTop: 16 }}>
            {result}
          </div>
        ) : null}

        <h3 className="admin-section-title">正在运行的任务（{status.length}）</h3>
        <div className="admin-device-list">
          {status.length === 0 ? (
            <div className="admin-empty">当前没有在跑的任务</div>
          ) : (
            status.map((entry) => (
              <div key={entry.id} className="admin-device-row">
                <span className="device-dot online" />
                <span className="admin-device-serial">{entry.deviceId}</span>
                <span className="muted">{entry.label}</span>
              </div>
            ))
          )}
        </div>
      </article>

      <LockedToast state={locked} />
    </section>
  );
}

// ────────────────────────── 小组件 ──────────────────────────

function NumberField({
  label,
  value,
  hint,
  disabled,
  onChange
}: {
  label: string;
  value: number;
  hint: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="admin-quota-field">
      <span className="admin-quota-label">{label}</span>
      <input
        type="number"
        min={0}
        value={String(value)}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value);
          onChange(Number.isFinite(next) && next >= 0 ? next : 0);
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
