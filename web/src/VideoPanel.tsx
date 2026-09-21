import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AutomationDevice, AutomationResult } from "./api/automation";
import type { SessionUser } from "./api/session";
import { LockedBlock, LockedField, LockedToast, useLockedNotice } from "./LockedFeature";
import {
  deleteVideo,
  fetchVideos,
  formatBytes,
  uploadVideo,
  type RemoteVideo
} from "./api/videos";

interface VideoPanelProps {
  user: SessionUser;
  devices: AutomationDevice[];
  request: (
    action: "accounts" | "send-video.start",
    payload?: Record<string, unknown>
  ) => Promise<AutomationResult>;
}

/** autojs 的账号视图（relay 已按设备集裁过） */
interface AccountEntry {
  id: number | string;
  username: string;
  device_id?: string | null;
  status?: string;
}

type Mode = "precise" | "batch";

interface Assignment {
  account: string;
  video: string;
}

const MAX_TITLE_COUNT = 20;
const MAX_TITLE_LENGTH = 200;

/**
 * 发视频面板。
 *
 * 完整链路：浏览器上传 → relay 落盘 → 设备主机拉取 → autojs 推到手机。
 *
 * 界面上有两个刻意的取舍：
 *
 *   1. **账号由 autojs 决定，不由我们编造** —— 账号名会成为手机上的
 *      远程目录名（`/sdcard/SaveVideo/<account>/`），必须与 autojs 里
 *      真实存在的账号一致，所以这里是从 `accounts` 接口拉的列表。
 *   2. **批量模式只做账号↔视频的配对** —— autojs 的 batch 语义就是
 *      `assignments: [{account, video}]`，界面直接映射，不做额外发明。
 */
export function VideoPanel({ user, devices, request }: VideoPanelProps) {
  // ── 素材库 ──────────────────────────────────────────────
  const [videos, setVideos] = useState<RemoteVideo[]>([]);
  const [usedBytes, setUsedBytes] = useState(0);
  const [quotaBytes, setQuotaBytes] = useState(0);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ── 发布表单 ────────────────────────────────────────────
  const [mode, setMode] = useState<Mode>("precise");
  const [selectedVideos, setSelectedVideos] = useState<string[]>([]);
  const [selectedDevices, setSelectedDevices] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<AccountEntry[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [accountsError, setAccountsError] = useState("");
  const [account, setAccount] = useState("");
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [sendTime, setSendTime] = useState("");
  const [titlesText, setTitlesText] = useState("");
  const [productName, setProductName] = useState("");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [resultOk, setResultOk] = useState<boolean | null>(null);
  // 试用版功能门：点置灰项 → 底部提示
  const locked = useLockedNotice();

  const onlineDevices = useMemo(() => devices.filter((d) => d.status === "online"), [devices]);

  const videoById = useMemo(() => {
    const map = new Map<string, RemoteVideo>();
    for (const video of videos) {
      map.set(video.id, video);
    }
    return map;
  }, [videos]);

  const loadLibrary = useCallback(async () => {
    setLibraryBusy(true);
    setLibraryError("");

    try {
      const library = await fetchVideos();
      setVideos(library.videos);
      setUsedBytes(library.usedBytes);
      setQuotaBytes(library.quotaBytes);
      // 列表刷新后丢掉已经不存在的选择，避免下发一个已删除的 id
      const alive = new Set(library.videos.map((video) => video.id));
      setSelectedVideos((current) => current.filter((id) => alive.has(id)));
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      setLibraryBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  const loadAccounts = useCallback(async () => {
    setAccountsError("");
    const res = await request("accounts", {});
    setAccountsLoaded(true);

    if (!res.ok) {
      setAccountsError(res.error ?? "获取账号列表失败");
      return;
    }

    const list = Array.isArray(res.data) ? (res.data as AccountEntry[]) : [];
    setAccounts(list.filter((item) => item && typeof item.username === "string" && item.username !== ""));
  }, [request]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  /** 账号优先按其所属设备过滤；autojs 没给 device_id 的账号保守地一并列出 */
  const availableAccounts = useMemo(() => {
    if (selectedDevices.length === 0) {
      return accounts;
    }

    const scoped = accounts.filter(
      (item) => !item.device_id || selectedDevices.includes(item.device_id)
    );

    return scoped.length > 0 ? scoped : accounts;
  }, [accounts, selectedDevices]);

  async function onPickFile(file: File | undefined): Promise<void> {
    if (!file || uploading) {
      return;
    }

    setLibraryError("");
    setUploading({ name: file.name, percent: 0 });

    try {
      const res = await uploadVideo(file, (sent, total) => {
        setUploading({ name: file.name, percent: Math.round((sent / total) * 100) });
      });

      setUsedBytes(res.usedBytes);
      setQuotaBytes(res.quotaBytes);
      await loadLibrary();
      // 刚上传的视频直接选中，省一次点击
      setSelectedVideos((current) =>
        current.includes(res.video.id) ? current : [...current, res.video.id]
      );
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function onDelete(video: RemoteVideo): Promise<void> {
    if (!window.confirm(`删除素材「${video.name}」？已下发的任务不受影响。`)) {
      return;
    }

    setLibraryError("");
    try {
      const res = await deleteVideo(video.id);
      setUsedBytes(res.usedBytes);
      await loadLibrary();
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    }
  }

  function toggleVideo(id: string): void {
    setSelectedVideos((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  }

  function toggleDevice(serial: string): void {
    setSelectedDevices((current) =>
      current.includes(serial) ? current.filter((item) => item !== serial) : [...current, serial]
    );
  }

  /** 把选中的视频轮转分配到账号上，省去手工一行行配 */
  function autoAssign(): void {
    if (availableAccounts.length === 0 || selectedVideos.length === 0) {
      setResultOk(false);
      setResult("需要先选好账号与视频，才能自动分配");
      return;
    }

    setAssignments(
      selectedVideos.map((videoId, index) => ({
        account: availableAccounts[index % availableAccounts.length].username,
        video: videoById.get(videoId)?.name ?? ""
      }))
    );
  }

  async function submit(): Promise<void> {
    if (busy) {
      return;
    }

    setResultOk(null);

    if (!user.capabilities.can_send_video) {
      setResultOk(false);
      setResult("当前账号没有下发发视频任务的权限");
      return;
    }

    if (selectedDevices.length === 0) {
      setResultOk(false);
      setResult("请先选择至少一台设备");
      return;
    }

    if (selectedVideos.length === 0) {
      setResultOk(false);
      setResult("请先在上方素材库里选择至少一个视频");
      return;
    }

    const titleList = titlesText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");

    if (titleList.length > MAX_TITLE_COUNT) {
      setResultOk(false);
      setResult(`标题最多 ${MAX_TITLE_COUNT} 条`);
      return;
    }

    if (titleList.some((title) => title.length > MAX_TITLE_LENGTH)) {
      setResultOk(false);
      setResult(`单条标题最长 ${MAX_TITLE_LENGTH} 字符`);
      return;
    }

    let payload: Record<string, unknown>;

    if (mode === "precise") {
      if (!account) {
        setResultOk(false);
        setResult("精准模式需要选择一个账号");
        return;
      }

      payload = {
        type: "precise",
        accounts: [account],
        device_ids: selectedDevices,
        video_ids: selectedVideos,
        send_time: sendTime,
        titles: titleList,
        product_name: productName.trim(),
        location: location.trim()
      };
    } else {
      const used = assignments.filter((item) => item.account && item.video);
      if (used.length === 0) {
        setResultOk(false);
        setResult("批量模式需要至少一条「账号 → 视频」的分配");
        return;
      }

      // 视频标识用文件名：autojs 从 video_paths 的 basename 推导，
      // 两边的名字必须完全一致，所以这里传 safeName 而不是 id。
      const usedNames = new Set(used.map((item) => item.video));
      const usedIds = selectedVideos.filter((id) => usedNames.has(videoById.get(id)?.name ?? ""));

      if (usedIds.length !== usedNames.size) {
        setResultOk(false);
        setResult("分配里引用了未被选中的视频，请重新选择");
        return;
      }

      payload = {
        type: "batch",
        accounts: [...new Set(used.map((item) => item.account))],
        device_ids: selectedDevices,
        video_ids: usedIds,
        assignments: used,
        send_time: sendTime,
        titles: titleList,
        product_name: productName.trim(),
        location: location.trim()
      };
    }

    setBusy(true);
    setResult("正在下发…（首次下发需要把视频传到设备主机，可能要几分钟）");

    const res = await request("send-video.start", payload);
    setBusy(false);
    setResultOk(res.ok);

    if (res.ok) {
      const data = res.data as { script_run_id?: string; script_type?: string } | undefined;
      setResult(`下发成功 · script_run_id = ${data?.script_run_id ?? "-"}`);
    } else {
      setResult(res.error ?? "下发失败");
    }
  }

  const quotaPercent = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 0;

  return (
    <section className="admin-grid">
      {/* ── 素材库 ── */}
      <article className="admin-panel">
        <div className="panel-header">
          <div>
            <div className="panel-kicker">素材库</div>
            <h2>已上传 {videos.length} 个</h2>
          </div>
          <div className="panel-note" style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {/* autojs 桌面端的「打开素材导入」——试用版只支持网页上传单个文件 */}
            <button
              type="button"
              className="top-bar-action neutral"
              style={{ opacity: 0.5, cursor: "not-allowed" }}
              onClick={() => locked.notify("发视频 · 从设备批量导入素材")}
            >
              素材导入 🔒
            </button>
            <button
              type="button"
              className="top-bar-action neutral"
              disabled={libraryBusy || !user.capabilities.can_upload_video}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? `上传中 ${uploading.percent}%` : "上传视频"}
            </button>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".mp4,.mov,.m4v,video/mp4,video/quicktime"
          style={{ display: "none" }}
          onChange={(event) => void onPickFile(event.target.files?.[0])}
        />

        <div className="video-quota">
          <div className="video-quota-bar">
            <span style={{ width: `${quotaPercent}%` }} />
          </div>
          <div className="admin-quota-hint">
            已用 {formatBytes(usedBytes)}
            {quotaBytes > 0 ? ` / ${formatBytes(quotaBytes)}` : "（无配额限制）"}
          </div>
        </div>

        {!user.capabilities.can_upload_video ? (
          <div className="admin-hint warn" style={{ marginTop: 12 }}>
            当前账号没有「上传视频」权限，请联系管理员开启。
          </div>
        ) : null}

        {libraryError ? (
          <div className="admin-banner error" style={{ marginTop: 12 }}>
            {libraryError}
          </div>
        ) : null}

        <div className="admin-device-list" style={{ marginTop: 14 }}>
          {videos.length === 0 ? (
            <div className="admin-empty">
              素材库是空的。上传视频后再下发——视频会先存到服务器，由设备主机拉取。
            </div>
          ) : (
            videos.map((video) => {
              const checked = selectedVideos.includes(video.id);
              return (
                <div key={video.id} className="video-row">
                  <label className="video-row-main">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleVideo(video.id)}
                    />
                    <span className="video-row-name" title={video.originalName}>
                      {video.name}
                    </span>
                    <span className="muted">{formatBytes(video.sizeBytes)}</span>
                  </label>
                  <button
                    type="button"
                    className="top-bar-action neutral"
                    onClick={() => void onDelete(video)}
                  >
                    删除
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          仅支持 mp4 / mov / m4v；文件名会自动规范化（中文保留）。
          同一批任务里不能有两个同名视频。
        </div>

        {/* autojs 素材库的两个筛选/清理能力，试用版暂未开放 */}
        <div className="locked-grid" style={{ marginTop: 14 }}>
          <LockedField
            label="筛选视频"
            name="发视频 · 筛选视频"
            onLocked={locked.notify}
            hint="按文件名或来源目录搜索"
          >
            <input type="text" placeholder="按文件名或来源目录搜索" disabled readOnly />
          </LockedField>
          <LockedBlock
            title="删除已发布"
            name="发视频 · 删除手机上已发布的视频"
            onLocked={locked.notify}
            description="批量清理手机上已经发布出去的视频文件，释放设备存储"
          >
            <button type="button" className="top-bar-action neutral" disabled>
              删除已发布
            </button>
          </LockedBlock>
        </div>
      </article>

      {/* ── 发布设置 ── */}
      <article className="admin-panel">
        <div className="panel-header">
          <div>
            <div className="panel-kicker">发布设置</div>
            <h2>
              已选 {selectedVideos.length} 个视频 / {selectedDevices.length} 台设备
            </h2>
          </div>
        </div>

        <div className="admin-tabs" style={{ marginBottom: 14 }}>
          <button type="button" className={mode === "precise" ? "active" : ""} onClick={() => setMode("precise")}>
            精准发布
          </button>
          <button type="button" className={mode === "batch" ? "active" : ""} onClick={() => setMode("batch")}>
            批量分配
          </button>
        </div>

        <h3 className="admin-section-title">目标设备</h3>
        <div className="admin-device-list">
          {devices.length === 0 ? (
            <div className="admin-empty">还没有分配到设备</div>
          ) : (
            devices.map((device) => {
              const usable = device.status === "online";
              const checked = selectedDevices.includes(device.serial);
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

        <div className="panel-header" style={{ marginTop: 18 }}>
          <h3 className="admin-section-title" style={{ margin: 0 }}>
            {mode === "precise" ? "发布账号" : "账号 → 视频 分配"}
          </h3>
          <div className="panel-note">
            <button type="button" className="top-bar-action neutral" onClick={() => void loadAccounts()}>
              刷新账号
            </button>
          </div>
        </div>

        {accountsError ? (
          <div className="admin-banner error" style={{ marginTop: 10 }}>
            {accountsError}
          </div>
        ) : null}

        {accountsLoaded && accounts.length === 0 && !accountsError ? (
          <div className="admin-hint warn" style={{ marginTop: 10 }}>
            读不到任何账号。请确认设备主机已连接，且设备上已登录 TikTok 账号。
          </div>
        ) : null}

        {/* autojs 账号列表上方的筛选框，试用版未开放 */}
        <div className="locked-grid" style={{ marginTop: 12 }}>
          <LockedField
            label="筛选账号"
            name="发视频 · 筛选账号"
            onLocked={locked.notify}
            hint="按账号名、设备或目录搜索"
          >
            <input type="text" placeholder="按账号名、设备或目录搜索" disabled readOnly />
          </LockedField>
        </div>

        {mode === "precise" ? (
          <label className="video-field">
            <span className="admin-quota-label">账号（精准模式只能选一个）</span>
            <select value={account} disabled={busy} onChange={(event) => setAccount(event.target.value)}>
              <option value="">— 请选择 —</option>
              {availableAccounts.map((item) => (
                <option key={String(item.id)} value={item.username}>
                  {item.username}
                  {item.device_id ? ` @ ${item.device_id}` : ""}
                </option>
              ))}
            </select>
            <span className="admin-quota-hint">
              选中的 {selectedVideos.length} 个视频都会发到这个账号
            </span>
          </label>
        ) : (
          <>
            <div style={{ marginTop: 10 }}>
              <button type="button" className="top-bar-action neutral" disabled={busy} onClick={autoAssign}>
                按顺序自动分配到账号
              </button>
            </div>

            <div className="video-assign-list">
              {assignments.length === 0 ? (
                <div className="admin-empty">还没有分配。点上面的按钮自动分配，或手工添加。</div>
              ) : (
                assignments.map((item, index) => (
                  <div key={`${item.video}-${index}`} className="video-assign-row">
                    <select
                      value={item.account}
                      disabled={busy}
                      onChange={(event) =>
                        setAssignments((current) =>
                          current.map((row, i) =>
                            i === index ? { ...row, account: event.target.value } : row
                          )
                        )
                      }
                    >
                      <option value="">— 账号 —</option>
                      {availableAccounts.map((entry) => (
                        <option key={String(entry.id)} value={entry.username}>
                          {entry.username}
                        </option>
                      ))}
                    </select>
                    <span className="muted">→</span>
                    <span className="video-row-name" title={item.video}>
                      {item.video || "（未选视频）"}
                    </span>
                    <button
                      type="button"
                      className="top-bar-action neutral"
                      disabled={busy}
                      onClick={() => setAssignments((current) => current.filter((_, i) => i !== index))}
                    >
                      移除
                    </button>
                  </div>
                ))
              )}
            </div>

            <button
              type="button"
              className="top-bar-action neutral"
              style={{ marginTop: 10 }}
              disabled={busy || selectedVideos.length === 0}
              onClick={() =>
                setAssignments((current) => [
                  ...current,
                  { account: "", video: videoById.get(selectedVideos[0])?.name ?? "" }
                ])
              }
            >
              添加一条分配
            </button>
          </>
        )}

        {/* autojs 桌面端在同位置提供 AI 方案生成：按品类自动写标题/商品名/地点 */}
        <LockedBlock
          title="🤖 AI 方案生成"
          name="发视频 · AI 方案生成"
          onLocked={locked.notify}
          description="输入商品 / 行业 / 品类，自动生成标题、商品名与地点，并填入下方输入框"
        >
          <div style={{ display: "flex", gap: 8 }}>
            <input type="text" placeholder="例如：budget wigs、false nails…" disabled readOnly style={{ flex: 1 }} />
            <button type="button" className="top-bar-action neutral" disabled>
              生成方案
            </button>
          </div>
        </LockedBlock>

        <h3 className="admin-section-title">可选参数</h3>
        <div className="admin-quota">
          <label className="admin-quota-field">
            <span className="admin-quota-label">定时发布</span>
            <input
              type="datetime-local"
              value={sendTime}
              disabled={busy}
              onChange={(event) => setSendTime(event.target.value)}
            />
            <span className="admin-quota-hint">留空表示立即发布，格式 YYYY-MM-DD HH:MM</span>
          </label>

          <label className="admin-quota-field">
            <span className="admin-quota-label">商品名</span>
            <input
              type="text"
              value={productName}
              disabled={busy}
              placeholder="可留空"
              onChange={(event) => setProductName(event.target.value)}
            />
            <span className="admin-quota-hint">最长 200 字符</span>
          </label>

          <label className="admin-quota-field">
            <span className="admin-quota-label">定位</span>
            <input
              type="text"
              value={location}
              disabled={busy}
              placeholder="可留空"
              onChange={(event) => setLocation(event.target.value)}
            />
            <span className="admin-quota-hint">最长 200 字符</span>
          </label>
        </div>

        <label className="video-field" style={{ marginTop: 14 }}>
          <span className="admin-quota-label">标题（每行一条，可留空）</span>
          <textarea
            className="video-textarea"
            value={titlesText}
            disabled={busy}
            rows={4}
            placeholder={"第一个标题\n第二个标题"}
            onChange={(event) => setTitlesText(event.target.value)}
          />
          <span className="admin-quota-hint">最多 {MAX_TITLE_COUNT} 条，单条最长 {MAX_TITLE_LENGTH} 字符</span>
        </label>

        {!user.capabilities.can_send_video ? (
          <div className="admin-hint warn" style={{ marginTop: 16 }}>
            当前账号没有「下发发视频任务」权限，请联系管理员开启。
          </div>
        ) : null}

        <div style={{ marginTop: 18, display: "flex", gap: 10, alignItems: "center" }}>
          <button
            type="button"
            className="auth-submit"
            style={{ width: "auto", padding: "11px 26px" }}
            disabled={busy || !user.capabilities.can_send_video}
            onClick={() => void submit()}
          >
            {busy ? "下发中…" : "下发发视频任务"}
          </button>
        </div>

        {result ? (
          <div
            className={`admin-banner ${resultOk === false ? "error" : resultOk === true ? "notice" : ""}`}
            style={{ marginTop: 16 }}
          >
            {result}
          </div>
        ) : null}
      </article>

      <LockedToast state={locked} />
    </section>
  );
}
