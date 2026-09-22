import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

/**
 * 布局外壳与 ConsoleView 之间的数据契约。
 *
 * ConsoleView 负责**全部逻辑**（设备列表、视频流、触摸转发、选中态），
 * 布局外壳只负责**怎么摆**。这样五种布局共用一套逻辑 —— 否则每加一种布局
 * 就要复制一遍视频流与触摸处理，迟早各修各的、行为不一致。
 */

export type DeviceStatus = "online" | "offline" | "unauthorized" | "unknown";
export type StreamStatus = "idle" | "starting" | "streaming" | "error";
export type ControlStatus = "idle" | "ready" | "error";
export type ConnectionState = "connecting" | "live" | "disconnected";
export type StreamConnectionState = "idle" | "connecting" | "live" | "error";
export type DeviceSystemKey = "HOME" | "BACK" | "APP_SWITCH";

export interface DeviceInfo {
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

export interface ConsoleLayoutProps {
  devices: DeviceInfo[];
  selectedDevice?: DeviceInfo;
  selectedKey: string;
  onSelect: (key: string) => void;

  onlineCount: number;
  tcpCount: number;
  canControl: boolean;

  streamState: StreamConnectionState;
  streamMessage: string;
  connectionState: ConnectionState;
  updatedAt: string;
  errorMessage: string;

  controlMessage: string;
  controlPending: boolean;
  onSystemKey: (key: DeviceSystemKey) => void;

  videoRef: RefObject<HTMLVideoElement | null>;
  videoShellRef: RefObject<HTMLDivElement | null>;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export function deviceKey(device?: Pick<DeviceInfo, "agentId" | "serial">): string {
  if (!device) {
    return "";
  }

  return `${device.agentId ?? "local"}::${device.serial}`;
}

export function formatClock(value: string): string {
  const date = new Date(value);
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

/** 状态中文名：新布局里用中文更省横向空间，卡片墙那套仍用英文 pill */
export const STATUS_TEXT: Record<DeviceStatus, string> = {
  online: "在线",
  offline: "离线",
  unauthorized: "未授权",
  unknown: "未知"
};
