import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import JMuxer from "jmuxer";
import "./styles.css";

type DeviceStatus = "online" | "offline" | "unauthorized" | "unknown";
type StreamStatus = "idle" | "starting" | "streaming" | "error";
type ControlStatus = "idle" | "ready" | "error";
type ConnectionState = "connecting" | "live" | "disconnected";
type StreamConnectionState = "idle" | "connecting" | "live" | "error";
type DeviceSystemKey = "HOME" | "BACK" | "APP_SWITCH";
type TouchPhase = "down" | "move" | "up";

interface DeviceInfo {
  agentId?: string;
  serial: string;
  status: DeviceStatus;
  model: string;
  androidVersion: string;
  width: number;
  height: number;
  streamStatus: StreamStatus;
  controlStatus: ControlStatus;
  transport: "usb" | "tcp";
}

interface DevicePayload {
  devices: DeviceInfo[];
  updatedAt: string;
}

type DeviceInputCommand =
  | {
      action: "touch";
      phase: TouchPhase;
      pointerId: number;
      x: number;
      y: number;
      screenWidth: number;
      screenHeight: number;
    }
  | {
      action: "tap";
      x: number;
      y: number;
    }
  | {
      action: "swipe";
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      durationMs: number;
    }
  | {
      action: "keyevent";
      key: DeviceSystemKey;
    };

interface GestureSnapshot {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  lastDispatchClientX: number;
  lastDispatchClientY: number;
  lastDispatchAt: number;
  startedAt: number;
}

const API_BASE_URL = "http://127.0.0.1:5071";
const LOCAL_WS_URL = "ws://127.0.0.1:5071/ws";
const LOCAL_STREAM_WS_BASE_URL = "ws://127.0.0.1:5071/ws/stream";
const RELAY_WS_BASE_URL = readEnvString("VITE_RELAY_WS_BASE_URL");
const USE_RELAY = RELAY_WS_BASE_URL.length > 0;
const VIEWER_WS_URL = USE_RELAY ? `${RELAY_WS_BASE_URL}/ws/viewer` : LOCAL_WS_URL;

export function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string>("");
  const [selectedDeviceKey, setSelectedDeviceKey] = useState<string>("");
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [streamState, setStreamState] = useState<StreamConnectionState>("idle");
  const [streamMessage, setStreamMessage] = useState<string>("等待选择设备");
  const [controlMessage, setControlMessage] = useState<string>("点击轻触，拖动滑动");
  const [controlPending, setControlPending] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoShellRef = useRef<HTMLDivElement | null>(null);
  const jmuxerRef = useRef<JMuxer | null>(null);
  const streamSocketRef = useRef<WebSocket | null>(null);
  const deviceSocketRef = useRef<WebSocket | null>(null);
  const gestureRef = useRef<GestureSnapshot | null>(null);

  useEffect(() => {
    let ignore = false;

    async function loadDevices(): Promise<void> {
      if (USE_RELAY) {
        return;
      }

      try {
        const response = await fetch(`${API_BASE_URL}/api/devices`);
        const payload = (await response.json()) as DevicePayload;

        if (!ignore) {
          setDevices(payload.devices);
          setUpdatedAt(payload.updatedAt);
          setErrorMessage("");
          setConnectionState("live");
        }
      } catch (error) {
        if (!ignore) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
          setConnectionState("disconnected");
        }
      }
    }

    void loadDevices();

    const socket = new WebSocket(VIEWER_WS_URL);
    deviceSocketRef.current = socket;

    socket.addEventListener("open", () => {
      if (!ignore) {
        setConnectionState("live");
      }
    });

    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data) as {
        type: string;
        devices?: DeviceInfo[];
        updatedAt?: string;
        message?: string;
        agentId?: string;
      };
      if (payload.type === "devices" && !ignore) {
        setDevices(payload.devices ?? []);
        setUpdatedAt(payload.updatedAt ?? "");
        setErrorMessage("");
        setConnectionState("live");
      }

      if (payload.type === "input-error" && !ignore) {
        setControlMessage(payload.message ?? "控制发送失败");
      }
    });

    socket.addEventListener("close", () => {
      if (!ignore) {
        setConnectionState("disconnected");
      }
    });

    socket.addEventListener("error", () => {
      if (!ignore) {
        setConnectionState("disconnected");
      }
    });

    return () => {
      ignore = true;
      if (deviceSocketRef.current === socket) {
        deviceSocketRef.current = null;
      }
      socket.close();
    };
  }, []);

  useEffect(() => {
    if (devices.length === 0) {
      setSelectedDeviceKey("");
      return;
    }

    const currentSelectedStillExists = devices.some((device) => getDeviceKey(device) === selectedDeviceKey);
    if (!currentSelectedStillExists) {
      setSelectedDeviceKey(getDeviceKey(devices[0]));
    }
  }, [devices, selectedDeviceKey]);

  const selectedDevice = useMemo(
    () => devices.find((device) => getDeviceKey(device) === selectedDeviceKey) ?? devices[0],
    [devices, selectedDeviceKey]
  );

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement || !selectedDevice) {
      setStreamState("idle");
      setStreamMessage("等待选择设备");
      return;
    }

    const streamKey = getDeviceKey(selectedDevice);

    streamSocketRef.current?.close();
    jmuxerRef.current?.destroy();
    jmuxerRef.current = new JMuxer({
      node: videoElement,
      mode: "video",
      fps: 15,
      flushingTime: 0,
      clearBuffer: true,
      debug: false,
      onError: () => {
        setStreamState("error");
        setStreamMessage("浏览器播放器缓冲异常");
      }
    });

    const socket = new WebSocket(buildStreamUrl(selectedDevice));
    socket.binaryType = "arraybuffer";
    streamSocketRef.current = socket;

    setStreamState("connecting");
    setStreamMessage(`正在连接 ${selectedDevice.serial}`);

    socket.addEventListener("open", () => {
      if (streamSocketRef.current !== socket) {
        return;
      }

      setStreamState("live");
      setStreamMessage("视频流已连接");
    });

    socket.addEventListener("message", (event) => {
      if (streamSocketRef.current !== socket) {
        return;
      }

      if (typeof event.data === "string") {
        const payload = JSON.parse(event.data) as {
          type: "stream-ready" | "stream-log" | "stream-error";
          message?: string;
        };

        if (payload.type === "stream-ready") {
          setStreamState("live");
          setStreamMessage("正在接收设备画面");
        }

        if (payload.type === "stream-log" && payload.message) {
          setStreamMessage(payload.message);
        }

        if (payload.type === "stream-error") {
          setStreamState("error");
          setStreamMessage(payload.message ?? "视频流启动失败");
        }

        return;
      }

      const chunk = new Uint8Array(event.data as ArrayBuffer);
      jmuxerRef.current?.feed({
        video: chunk,
        duration: 66
      });
    });

    socket.addEventListener("close", () => {
      if (streamSocketRef.current !== socket) {
        return;
      }

      setStreamState("idle");
      setStreamMessage("视频流已断开");
    });

    socket.addEventListener("error", () => {
      if (streamSocketRef.current !== socket) {
        return;
      }

      setStreamState("error");
      setStreamMessage("视频流连接异常");
    });

    return () => {
      if (streamSocketRef.current === socket) {
        streamSocketRef.current = null;
      }
      socket.close();
      if (streamSocketRef.current === null) {
        jmuxerRef.current?.destroy();
        jmuxerRef.current = null;
      }
    };
  }, [selectedDeviceKey]);

  function sendInputCommand(command: DeviceInputCommand, options?: { silent?: boolean }): void {
    if (!selectedDevice) {
      setControlMessage("当前没有可控制设备");
      return;
    }

    try {
      const socket = deviceSocketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("控制通道未连接");
      }

      socket.send(JSON.stringify(buildInputPayload(selectedDevice, command)));

      if (!options?.silent) {
        setControlMessage(describeCommand(command));
      }
    } catch (error) {
      setControlMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!selectedDevice || streamState !== "live") {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    gestureRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      lastDispatchClientX: event.clientX,
      lastDispatchClientY: event.clientY,
      lastDispatchAt: Date.now(),
      startedAt: Date.now()
    };

    const shellRect = videoShellRef.current?.getBoundingClientRect();
    if (!shellRect) {
      return;
    }

    const point = mapClientPointToDevice(
      event.clientX,
      event.clientY,
      shellRect,
      selectedDevice.width,
      selectedDevice.height
    );

    if (!point) {
      setControlMessage("手势落点超出画面范围");
      return;
    }

    sendInputCommand(
      {
        action: "touch",
        phase: "down",
        pointerId: event.pointerId,
        x: point.x,
        y: point.y,
        screenWidth: selectedDevice.width,
        screenHeight: selectedDevice.height
      },
      { silent: true }
    );

    setControlMessage(`按下 ${Math.round(point.x)}, ${Math.round(point.y)}`);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const gesture = gestureRef.current;
    if (!selectedDevice || !gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    const nextGesture = {
      ...gesture,
      lastClientX: event.clientX,
      lastClientY: event.clientY
    };
    gestureRef.current = nextGesture;

    const elapsed = Date.now() - nextGesture.lastDispatchAt;
    const distance = Math.hypot(
      event.clientX - nextGesture.lastDispatchClientX,
      event.clientY - nextGesture.lastDispatchClientY
    );

    if (elapsed < 16 && distance < 4) {
      return;
    }

    const shellRect = videoShellRef.current?.getBoundingClientRect();
    if (!shellRect) {
      return;
    }

    const point = mapClientPointToDevice(
      event.clientX,
      event.clientY,
      shellRect,
      selectedDevice.width,
      selectedDevice.height
    );

    if (!point) {
      return;
    }

    gestureRef.current = {
      ...nextGesture,
      lastDispatchClientX: event.clientX,
      lastDispatchClientY: event.clientY,
      lastDispatchAt: Date.now()
    };

    sendInputCommand(
      {
        action: "touch",
        phase: "move",
        pointerId: event.pointerId,
        x: point.x,
        y: point.y,
        screenWidth: selectedDevice.width,
        screenHeight: selectedDevice.height
      },
      { silent: true }
    );
  }

  async function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>): Promise<void> {
    const gesture = gestureRef.current;
    gestureRef.current = null;

    if (!selectedDevice || !gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    event.currentTarget.releasePointerCapture(event.pointerId);

    const shellRect = videoShellRef.current?.getBoundingClientRect();
    if (!shellRect) {
      return;
    }

    const endPoint = mapClientPointToDevice(
      gesture.lastClientX,
      gesture.lastClientY,
      shellRect,
      selectedDevice.width,
      selectedDevice.height
    );

    if (!endPoint) {
      setControlMessage("手势落点超出画面范围");
      return;
    }

    sendInputCommand({
      action: "touch",
      phase: "up",
      pointerId: event.pointerId,
      x: endPoint.x,
      y: endPoint.y,
      screenWidth: selectedDevice.width,
      screenHeight: selectedDevice.height
    });
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>): void {
    const gesture = gestureRef.current;
    gestureRef.current = null;

    if (gesture && gesture.pointerId === event.pointerId && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (!gesture || !selectedDevice) {
      return;
    }

    const shellRect = videoShellRef.current?.getBoundingClientRect();
    if (!shellRect) {
      return;
    }

    const point = mapClientPointToDevice(
      gesture.lastClientX,
      gesture.lastClientY,
      shellRect,
      selectedDevice.width,
      selectedDevice.height
    );

    if (!point) {
      return;
    }

    sendInputCommand({
      action: "touch",
      phase: "up",
      pointerId: event.pointerId,
      x: point.x,
      y: point.y,
      screenWidth: selectedDevice.width,
      screenHeight: selectedDevice.height
    });
  }

  async function handleSystemKey(key: DeviceSystemKey): Promise<void> {
    sendInputCommand({
      action: "keyevent",
      key
    });
  }

  const onlineCount = devices.filter((device) => device.status === "online").length;
  const tcpCount = devices.filter((device) => device.transport === "tcp").length;

  return (
    <main className="app-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">Remote Phone Control</div>
          <h1>单设备实时控制</h1>
          <p>
            现在这块主设备区域已经是一个真正的本地控制台。
            你可以直接点击、拖动滑动，并使用系统按键操作 Android。
          </p>
        </div>

        <div className="stats-grid">
          <MetricCard label="已发现设备" value={String(devices.length).padStart(2, "0")} hint="来自本地 Agent" />
          <MetricCard label="在线设备" value={String(onlineCount).padStart(2, "0")} hint="当前可控制" />
          <MetricCard label="TCP 设备" value={String(tcpCount).padStart(2, "0")} hint="ADB over TCP" />
          <MetricCard
            label="视频状态"
            value={streamState === "live" ? "LIVE" : streamState === "connecting" ? "SYNC" : streamState === "error" ? "ERR" : "IDLE"}
            hint={streamMessage}
            accent={streamState !== "error"}
          />
        </div>
      </section>

      <section className="dashboard-grid">
        <article className="focus-panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">当前主选设备</div>
              <h2>{selectedDevice?.model ?? "暂无设备"}</h2>
            </div>
            <StatusPill status={selectedDevice?.status ?? "unknown"} />
          </div>

          <div className="screen-frame">
            <div className="screen-glow" />
            <div className="screen-content video-stage">
              {selectedDevice ? (
                <>
                  {/* 手机视频外层壳，实际尺寸由 styles.css 里的 .device-video-shell 控制 */}
                  <div
                    ref={videoShellRef}
                    className={`device-video-shell ${streamState === "live" ? "interactive" : ""}`}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerCancel}
                    onContextMenu={(event) => event.preventDefault()}
                  >
                    {/* 真正的视频元素，显示方式由 .device-video 控制 */}
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
                      {streamState === "live" ? "点击轻触，拖动滑动" : "等待视频流"}
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

          <div className="control-toolbar">
            <div className={`control-status ${controlPending ? "busy" : ""}`}>{controlMessage}</div>
            <div className="control-button-row">
              <button type="button" className="control-button" onClick={() => void handleSystemKey("HOME")}>
                Home
              </button>
              <button type="button" className="control-button" onClick={() => void handleSystemKey("BACK")}>
                Back
              </button>
              <button type="button" className="control-button" onClick={() => void handleSystemKey("APP_SWITCH")}>
                Recent
              </button>
            </div>
          </div>

          <div className="device-meta-grid">
            <MetaItem label="Serial" value={selectedDevice?.serial ?? "-"} />
            <MetaItem label="Agent" value={selectedDevice?.agentId ?? "local"} />
            <MetaItem label="Android" value={selectedDevice?.androidVersion ?? "-"} />
            <MetaItem label="Transport" value={selectedDevice?.transport ?? "-"} />
            <MetaItem label="Control" value={selectedDevice?.controlStatus ?? "-"} />
            <MetaItem label="Device Sync" value={connectionState} />
            <MetaItem label="Updated" value={updatedAt ? formatTime(updatedAt) : "-"} />
          </div>
        </article>

        <section className="device-wall">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">设备卡片墙</div>
              <h2>全部设备</h2>
            </div>
            <div className="panel-note">{errorMessage || "点击任一设备切换实时主画面"}</div>
          </div>

          <div className="device-grid">
            {devices.map((device, index) => (
              <button
                key={getDeviceKey(device)}
                className={`device-card ${getDeviceKey(device) === getDeviceKey(selectedDevice) ? "selected" : ""}`}
                onClick={() => setSelectedDeviceKey(getDeviceKey(device))}
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
                  <span>{device.width} x {device.height}</span>
                  <span>Android {device.androidVersion}</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      </section>
    </main>
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

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="meta-item">
      <div className="meta-label">{label}</div>
      <div className="meta-value">{value}</div>
    </div>
  );
}

function StatusPill({
  status,
  compact = false
}: {
  status: DeviceStatus;
  compact?: boolean;
}) {
  return <span className={`status-pill ${status} ${compact ? "compact" : ""}`}>{status}</span>;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function describeCommand(command: DeviceInputCommand): string {
  switch (command.action) {
    case "touch":
      return `触控 ${command.phase} ${Math.round(command.x)}, ${Math.round(command.y)}`;
    case "tap":
      return `轻触 ${Math.round(command.x)}, ${Math.round(command.y)}`;
    case "swipe":
      return `滑动 ${Math.round(command.startX)}, ${Math.round(command.startY)} -> ${Math.round(command.endX)}, ${Math.round(command.endY)}`;
    case "keyevent":
      return `执行系统键 ${command.key}`;
  }
}

function getDeviceKey(device?: Pick<DeviceInfo, "agentId" | "serial">): string {
  if (!device) {
    return "";
  }

  return `${device.agentId ?? "local"}::${device.serial}`;
}

function buildStreamUrl(device: DeviceInfo): string {
  if (!USE_RELAY) {
    return `${LOCAL_STREAM_WS_BASE_URL}?serial=${encodeURIComponent(device.serial)}`;
  }

  return `${RELAY_WS_BASE_URL}/ws/viewer/stream?agentId=${encodeURIComponent(device.agentId ?? "")}&serial=${encodeURIComponent(device.serial)}`;
}

function buildInputPayload(device: DeviceInfo, command: DeviceInputCommand): Record<string, unknown> {
  if (!USE_RELAY) {
    return {
      type: "input",
      serial: device.serial,
      command
    };
  }

  return {
    type: "input",
    agentId: device.agentId,
    serial: device.serial,
    command
  };
}

function readEnvString(name: string): string {
  const env = import.meta.env as Record<string, string | undefined>;
  return env[name]?.trim() ?? "";
}

function mapClientPointToDevice(
  clientX: number,
  clientY: number,
  shellRect: DOMRect,
  deviceWidth: number,
  deviceHeight: number
): { x: number; y: number } | null {
  if (!deviceWidth || !deviceHeight) {
    return null;
  }

  const shellAspect = shellRect.width / shellRect.height;
  const deviceAspect = deviceWidth / deviceHeight;

  let renderedWidth = shellRect.width;
  let renderedHeight = shellRect.height;
  let offsetLeft = 0;
  let offsetTop = 0;

  if (deviceAspect > shellAspect) {
    renderedHeight = shellRect.width / deviceAspect;
    offsetTop = (shellRect.height - renderedHeight) / 2;
  } else {
    renderedWidth = shellRect.height * deviceAspect;
    offsetLeft = (shellRect.width - renderedWidth) / 2;
  }

  const localX = clientX - shellRect.left - offsetLeft;
  const localY = clientY - shellRect.top - offsetTop;

  if (localX < 0 || localY < 0 || localX > renderedWidth || localY > renderedHeight) {
    return null;
  }

  return {
    x: (localX / renderedWidth) * deviceWidth,
    y: (localY / renderedHeight) * deviceHeight
  };
}
