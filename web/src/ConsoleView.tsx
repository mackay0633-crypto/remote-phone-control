import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import JMuxer from "jmuxer";
import { API_BASE_URL, RELAY_WS_BASE_URL, USE_RELAY } from "./api/client";
import type { SessionUser } from "./api/session";
import { ConsoleLayout, type ConsoleLayoutId } from "./layouts/shells";
import {
  deviceKey as getDeviceKey,
  type ConnectionState,
  type ConsoleLayoutProps,
  type DeviceInfo,
  type DeviceStatus,
  type DeviceSystemKey,
  type StreamConnectionState as StreamStatus
} from "./layouts/types";

/**
 * 设备/流的类型都来自 `layouts/types`，不在这里重复定义 ——
 * 这套类型是**布局外壳与逻辑之间**的契约，两处各写一份迟早会漂移
 * （比如一边加了 `agentId` 另一边没有，编译过不了或者行为不一致）。
 */
type ControlStatus = "idle" | "ready" | "error";
type TouchPhase = "down" | "move" | "up";

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

const LOCAL_WS_URL = "ws://127.0.0.1:5071/ws";
const LOCAL_STREAM_WS_BASE_URL = "ws://127.0.0.1:5071/ws/stream";
const VIEWER_WS_URL = USE_RELAY ? `${RELAY_WS_BASE_URL}/ws/viewer` : LOCAL_WS_URL;

interface ConsoleViewProps {
  /** 中继模式下的会话令牌；本地模式为空字符串 */
  token: string;
  user: SessionUser;
  /**
   * 服务端推送的权限变更。
   *
   * 管理员在后台改了能力开关后，relay 会主动推一份最新权限过来——
   * 否则页面上的按钮会按登录时的旧权限显示，点了才被服务端拒绝。
   */
  onCapabilitiesChanged?: (capabilities: SessionUser["capabilities"], role: SessionUser["role"]) => void;
  /** 当前布局结构；由 App 持有（风格切换器会改它），这里只负责渲染 */
  layout: ConsoleLayoutId;
}

export function ConsoleView({ token, user, onCapabilitiesChanged, layout }: ConsoleViewProps) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string>("");
  const [selectedDeviceKey, setSelectedDeviceKey] = useState<string>("");
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [streamState, setStreamState] = useState<StreamStatus>("idle");
  const [streamMessage, setStreamMessage] = useState<string>("等待选择设备");
  const [controlMessage, setControlMessage] = useState<string>("点击轻触，拖动滑动");
  const [controlPending] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoShellRef = useRef<HTMLDivElement | null>(null);
  const jmuxerRef = useRef<JMuxer | null>(null);
  const streamSocketRef = useRef<WebSocket | null>(null);
  const deviceSocketRef = useRef<WebSocket | null>(null);
  const gestureRef = useRef<GestureSnapshot | null>(null);

  /**
   * 用 ref 持有回调，避免把它放进 effect 依赖里——
   * 否则父组件每次重渲染都会导致 WebSocket 重连。
   */
  const onCapabilitiesRef = useRef(onCapabilitiesChanged);
  onCapabilitiesRef.current = onCapabilitiesChanged;

  /**
   * 设备列表与控制通道。
   *
   * 中继模式的关键差异：连上后**必须先发 auth**，服务端才会下发设备列表。
   * 本地模式的 Agent 没有账号体系，连上即视为已授权。
   */
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
      if (ignore) {
        return;
      }

      if (USE_RELAY) {
        // 等服务端 auth-ok 之后再认为连接可用
        socket.send(JSON.stringify({ type: "auth", token }));
        return;
      }

      setConnectionState("live");
    });

    socket.addEventListener("message", (event) => {
      if (ignore) {
        return;
      }

      const payload = JSON.parse(event.data as string) as {
        type: string;
        devices?: DeviceInfo[];
        updatedAt?: string;
        message?: string;
        role?: SessionUser["role"];
        capabilities?: SessionUser["capabilities"];
      };

      if (payload.type === "auth-ok") {
        setConnectionState("live");
        setErrorMessage("");
        return;
      }

      if (payload.type === "auth-error") {
        setConnectionState("disconnected");
        setErrorMessage(payload.message ?? "鉴权失败，请重新登录");
        return;
      }

      if (payload.type === "permissions" && payload.capabilities) {
        onCapabilitiesRef.current?.(payload.capabilities, payload.role ?? user.role);
        return;
      }

      if (payload.type === "devices") {
        setDevices(payload.devices ?? []);
        setUpdatedAt(payload.updatedAt ?? "");
        setErrorMessage("");
        setConnectionState("live");
        return;
      }

      if (payload.type === "input-error") {
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
  }, [token]);

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

    const shouldStream = !USE_RELAY || user.capabilities.can_view_stream;
    if (!shouldStream) {
      setStreamState("idle");
      setStreamMessage("当前账号没有查看实时画面的权限");
      return;
    }

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

      if (USE_RELAY) {
        // 同样先鉴权，服务端才允许订阅
        socket.send(JSON.stringify({ type: "auth", token }));
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
  }, [selectedDeviceKey, token, user.capabilities.can_view_stream]);

  function sendInputCommand(command: DeviceInputCommand, options?: { silent?: boolean }): void {
    if (!selectedDevice) {
      setControlMessage("当前没有可控制设备");
      return;
    }

    if (USE_RELAY && !user.capabilities.can_control_input) {
      setControlMessage("当前账号没有手动操控权限");
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
    if (!selectedDevice || streamState !== "live" || !canControl) {
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

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
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

  function handleSystemKey(key: DeviceSystemKey): void {
    sendInputCommand({
      action: "keyevent",
      key
    });
  }

  const canControl = !USE_RELAY || user.capabilities.can_control_input;
  /** 中继模式下没有基础能力时，服务端不会返回任何设备 */
  const awaitingAssignment = USE_RELAY && !user.capabilities.can_view_devices;
  const onlineCount = devices.filter((device) => device.status === "online").length;
  const tcpCount = devices.filter((device) => device.transport === "tcp").length;

  if (awaitingAssignment) {
    return (
      <section className="empty-panel">
        <div className="empty-icon">⌛</div>
        <h2>等待管理员分配设备</h2>
        <p>
          你的账号目前还看不到任何设备。
          请联系管理员为你分配手机，并开启「查看设备列表」权限。
        </p>
      </section>
    );
  }

  /**
   * 把逻辑一次性交给布局外壳。
   *
   * 五种布局共用这一份 props —— 视频流、触摸转发、选中态都只有一套实现，
   * 布局只决定"摆在哪"。这样加布局不会引入第二份行为。
   */
  const layoutProps: ConsoleLayoutProps = {
    devices,
    selectedDevice,
    selectedKey: selectedDeviceKey,
    onSelect: setSelectedDeviceKey,
    onlineCount,
    tcpCount,
    canControl,
    streamState,
    streamMessage,
    connectionState,
    updatedAt,
    errorMessage,
    controlMessage,
    controlPending,
    onSystemKey: handleSystemKey,
    videoRef,
    videoShellRef,
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerCancel
  };

  return <ConsoleLayout layout={layout} {...layoutProps} />;
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


function buildStreamUrl(device: DeviceInfo): string {
  if (!USE_RELAY) {
    return `${LOCAL_STREAM_WS_BASE_URL}?serial=${encodeURIComponent(device.serial)}`;
  }

  // 只需要 serial：agentId 由服务端按 serial 反查，客户端传的不可信
  return `${RELAY_WS_BASE_URL}/ws/viewer/stream?serial=${encodeURIComponent(device.serial)}`;
}

/**
 * 输入消息。
 *
 * 中继模式下不再携带 agentId —— relay 会按 serial 从在线设备表反查，
 * 客户端提供的 agentId 无法被信任。
 */
function buildInputPayload(device: DeviceInfo, command: DeviceInputCommand): Record<string, unknown> {
  return {
    type: "input",
    serial: device.serial,
    command
  };
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
