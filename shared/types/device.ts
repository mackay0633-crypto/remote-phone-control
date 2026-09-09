export type DeviceStatus = "online" | "offline" | "unauthorized" | "unknown";

export type StreamStatus = "idle" | "starting" | "streaming" | "error";

export type ControlStatus = "idle" | "ready" | "error";

export interface DeviceInfo {
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
