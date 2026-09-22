import type { ConsoleLayoutProps, DeviceInfo, DeviceStatus } from "./types";
import { STATUS_TEXT, deviceKey } from "./types";

/**
 * 可复用的零件。
 *
 * 五种布局的差别在**怎么摆**，而零件本身是共享的 —— 视频画面、控制按钮、
 * 元信息、状态点这些东西在五套里长得不一样，但行为和文案必须一致，
 * 所以只写一遍。
 */

export function StatusPill({ status, compact = false }: { status: DeviceStatus; compact?: boolean }) {
  return <span className={`status-pill ${status} ${compact ? "compact" : ""}`}>{status}</span>;
}

export function StatusDot({ status }: { status: DeviceStatus }) {
  return <span className={`device-dot ${status === "online" ? "online" : status === "offline" ? "offline" : ""}`} />;
}

/** 指标卡（经典布局用） */
export function MetricCard({
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

/** 细长统计条（表格 / 工作台 / 设备墙布局用）：占一行高度，不是四张大卡 */
export function StatStrip({ items }: { items: { label: string; value: string }[] }) {
  return (
    <div className="stat-strip">
      {items.map((item) => (
        <div key={item.label} className="stat-strip-item">
          <span className="stat-strip-label">{item.label}</span>
          <span className="stat-strip-value">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

export function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="meta-item">
      <div className="meta-label">{label}</div>
      <div className="meta-value">{value}</div>
    </div>
  );
}

/** 元信息（五套共用同一批字段） */
export function metaFields(props: ConsoleLayoutProps): { label: string; value: string }[] {
  const { selectedDevice, canControl, connectionState, updatedAt } = props;

  return [
    { label: "Serial", value: selectedDevice?.serial ?? "-" },
    { label: "Agent", value: selectedDevice?.agentId ?? "local" },
    { label: "Android", value: selectedDevice?.androidVersion ?? "-" },
    { label: "Transport", value: selectedDevice?.transport ?? "-" },
    { label: "Control", value: canControl ? (selectedDevice?.controlStatus ?? "-") : "disabled" },
    { label: "Device Sync", value: connectionState },
    { label: "Updated", value: updatedAt ? formatClockSafe(updatedAt) : "-" }
  ];
}

function formatClockSafe(value: string): string {
  try {
    return new Date(value).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch {
    return value;
  }
}

/**
 * 手机画面。
 *
 * 五种布局里位置和尺寸都不同，但**触摸转发必须完全一致** ——
 * 拖动、滑动、系统键都靠这里，任何一套摆错都会让操作失灵，
 * 所以只写一遍，靠容器 CSS 决定大小。
 */
export function FocusScreen({ props, variant }: { props: ConsoleLayoutProps; variant?: string }) {
  const {
    selectedDevice,
    streamState,
    streamMessage,
    canControl,
    videoRef,
    videoShellRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel
  } = props;

  return (
    <div className={`screen-frame ${variant ? `screen-frame-${variant}` : ""}`}>
      <div className="screen-glow" />
      <div className="screen-content video-stage">
        {selectedDevice ? (
          <>
            <div
              ref={videoShellRef}
              className={`device-video-shell ${streamState === "live" && canControl ? "interactive" : ""}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onContextMenu={(event) => event.preventDefault()}
            >
              <video
                ref={videoRef}
                className={`device-video ${streamState === "live" ? "visible" : ""}`}
                autoPlay
                muted
                playsInline
              />
            </div>
            <div className={`video-overlay ${streamState === "live" ? "subtle" : ""}`}>
              <div className="screen-label">
                {streamState === "live"
                  ? canControl
                    ? "点击轻触，拖动滑动"
                    : "仅查看（无操控权限）"
                  : "等待视频流"}
              </div>
              <div className="screen-resolution">
                {selectedDevice.width} x {selectedDevice.height} · {streamMessage}
              </div>
            </div>
          </>
        ) : (
          <div className="screen-label">等待设备接入</div>
        )}
      </div>
    </div>
  );
}

/** 控制条：状态文案 + Home/Back/Recent */
export function ControlBar({ props }: { props: ConsoleLayoutProps }) {
  const { controlMessage, controlPending, canControl, onSystemKey } = props;

  return (
    <div className="control-toolbar">
      <div className={`control-status ${controlPending ? "busy" : ""}`}>{controlMessage}</div>
      <div className="control-button-row">
        <button type="button" className="control-button" disabled={!canControl} onClick={() => onSystemKey("HOME")}>
          Home
        </button>
        <button type="button" className="control-button" disabled={!canControl} onClick={() => onSystemKey("BACK")}>
          Back
        </button>
        <button
          type="button"
          className="control-button"
          disabled={!canControl}
          onClick={() => onSystemKey("APP_SWITCH")}
        >
          Recent
        </button>
      </div>
    </div>
  );
}

/** 设备卡片（经典布局） */
export function DeviceCards({ props }: { props: ConsoleLayoutProps }) {
  const { devices, selectedKey, onSelect } = props;

  return (
    <div className="device-grid">
      {devices.map((device, index) => (
        <button
          key={deviceKey(device)}
          className={`device-card ${deviceKey(device) === selectedKey ? "selected" : ""}`}
          onClick={() => onSelect(deviceKey(device))}
          type="button"
        >
          <div className="device-card-top">
            <span className="device-index">#{String(index + 1).padStart(2, "0")}</span>
            <StatusPill status={device.status} compact />
          </div>
          <div className="device-model">{device.model}</div>
          <div className="device-serial">{device.serial}</div>
          <div className="device-details">
            <span>{device.transport.toUpperCase()}</span>
            <span>
              {device.width} x {device.height}
            </span>
            <span>Android {device.androidVersion}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

/**
 * 设备列表（侧边导航 / 工作台布局）：一行一台，横向排布。
 *
 * 与卡片墙的区别不只是样式：**一屏能扫到的设备数量差 3~4 倍**，
 * 设备多的时候这一列是可滚动的，而卡片墙会一直往下长。
 */
export function DeviceList({
  props,
  showMeta = false,
  compact = false
}: {
  props: ConsoleLayoutProps;
  showMeta?: boolean;
  compact?: boolean;
}) {
  const { devices, selectedKey, onSelect } = props;

  return (
    <div className={`device-list ${compact ? "compact" : ""}`}>
      {devices.map((device) => {
        const active = deviceKey(device) === selectedKey;

        return (
          <button
            key={deviceKey(device)}
            type="button"
            className={`device-list-row ${active ? "selected" : ""}`}
            onClick={() => onSelect(deviceKey(device))}
          >
            <StatusDot status={device.status} />
            <span className="device-list-main">
              <span className="device-list-title">{device.model}</span>
              <span className="device-list-sub">{device.serial}</span>
            </span>
            <span className="device-list-tail">
              {showMeta ? <span className="device-list-meta">{device.transport.toUpperCase()}</span> : null}
              <span className={`device-list-status ${device.status}`}>{STATUS_TEXT[device.status]}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 设备表格（表格布局）：列式，最省纵向空间 */
export function DeviceTable({ props }: { props: ConsoleLayoutProps }) {
  const { devices, selectedKey, onSelect } = props;

  return (
    <div className="device-table">
      <div className="device-table-head">
        <span>#</span>
        <span>状态</span>
        <span>型号</span>
        <span>序列号</span>
        <span>传输</span>
        <span>分辨率</span>
        <span>Android</span>
        <span>控制</span>
      </div>

      {devices.map((device, index) => {
        const active = deviceKey(device) === selectedKey;

        return (
          <button
            key={deviceKey(device)}
            type="button"
            className={`device-table-row ${active ? "selected" : ""}`}
            onClick={() => onSelect(deviceKey(device))}
          >
            <span className="device-table-index">{String(index + 1).padStart(2, "0")}</span>
            <span>
              <StatusDot status={device.status} />
              <span className={`device-list-status ${device.status}`}>{STATUS_TEXT[device.status]}</span>
            </span>
            <span className="device-table-strong">{device.model}</span>
            <span className="device-table-mono">{device.serial}</span>
            <span>{device.transport.toUpperCase()}</span>
            <span className="device-table-mono">
              {device.width}x{device.height}
            </span>
            <span>{device.androidVersion}</span>
            <span className="device-table-mono">{device.controlStatus}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 设备芯片（工作台布局右侧那一条）：只留型号，点一下切换 */
export function DeviceChips({ props }: { props: ConsoleLayoutProps }) {
  const { devices, selectedKey, onSelect } = props;

  return (
    <div className="device-chips">
      {devices.map((device) => {
        const active = deviceKey(device) === selectedKey;

        return (
          <button
            key={deviceKey(device)}
            type="button"
            className={`device-chip ${active ? "selected" : ""} ${device.status}`}
            onClick={() => onSelect(deviceKey(device))}
            title={`${device.model} · ${device.serial}`}
          >
            {device.model}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 设备砖块（设备墙布局）：最小最密的一格，只有状态点 + 型号 + 序列号尾巴。
 * 目的是"一眼看完整面墙有没有掉线的"。
 */
export function DeviceTiles({ props }: { props: ConsoleLayoutProps }) {
  const { devices, selectedKey, onSelect } = props;

  return (
    <div className="device-tiles">
      {devices.map((device) => {
        const active = deviceKey(device) === selectedKey;

        return (
          <button
            key={deviceKey(device)}
            type="button"
            className={`device-tile ${active ? "selected" : ""} ${device.status}`}
            onClick={() => onSelect(deviceKey(device))}
            title={`${device.model} · ${device.serial}`}
          >
            <StatusDot status={device.status} />
            <span className="device-tile-model">{device.model}</span>
            {/*
              去掉端口再显示。第一版写的是 `serial.split(":").pop()`，
              结果拿到的是端口 —— 20 台机器全显示 "5555"，砖块之间毫无区分度
              （ADB over TCP 的端口都一样）。这里取 IP 部分。
            */}
            <span className="device-tile-serial">{device.serial.replace(/:\d+$/, "")}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 无设备空态 */
export function EmptyDevices() {
  return (
    <section className="empty-panel">
      <div className="empty-icon">⌛</div>
      <h2>等待管理员分配设备</h2>
      <p>你的账号目前还看不到任何设备。请联系管理员为你分配手机，并开启「查看设备列表」权限。</p>
    </section>
  );
}

export function metaGrid(fields: { label: string; value: string }[], compact = false) {
  return (
    <div className={`device-meta-grid ${compact ? "compact" : ""}`}>
      {fields.map((field) => (
        <MetaItem key={field.label} label={field.label} value={field.value} />
      ))}
    </div>
  );
}

export type { ConsoleLayoutProps, DeviceInfo };
