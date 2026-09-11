import type { DeviceInfo } from "./device-types.js";
import { DeviceManager } from "./device-manager.js";

type DeviceListener = (devices: DeviceInfo[]) => void;

export class DeviceTracker {
  private devices: DeviceInfo[] = [];
  private listeners = new Set<DeviceListener>();
  private intervalId?: NodeJS.Timeout;
  private refreshing = false;

  constructor(
    private readonly deviceManager: DeviceManager,
    private readonly pollIntervalMs: number
  ) {}

  async start(): Promise<void> {
    await this.refresh();
    this.intervalId = setInterval(() => {
      void this.refresh();
    }, this.pollIntervalMs);
  }

  /** 立即刷新一次设备列表，供设备保活模块在恢复连接后调用，避免等待下一个轮询周期。 */
  async refreshNow(): Promise<void> {
    await this.refresh();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  getDevices(): DeviceInfo[] {
    return this.devices;
  }

  getDevice(serial: string): DeviceInfo | undefined {
    return this.devices.find((device) => device.serial === serial);
  }

  subscribe(listener: DeviceListener): () => void {
    this.listeners.add(listener);
    listener(this.devices);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }

    this.refreshing = true;

    try {
      const devices = await this.deviceManager.listDevices();
      this.devices = devices;
      this.listeners.forEach((listener) => listener(devices));
    } finally {
      this.refreshing = false;
    }
  }
}
