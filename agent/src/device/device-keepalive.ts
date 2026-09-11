import type { AdbClient, AdbConnectResult } from "../adb/adb-client.js";

export interface DeviceKeepaliveOptions {
  adbClient: AdbClient;
  targets: string[];
  intervalMs: number;
  concurrency: number;
  /** 成功恢复设备后回调，用于触发一次设备列表立即刷新。 */
  onDevicesChanged?: () => void | Promise<void>;
}

export interface DeviceKeepaliveFailure {
  address: string;
  message: string;
}

export interface DeviceKeepaliveStatus {
  enabled: boolean;
  targetCount: number;
  onlineCount: number;
  missing: string[];
  lastRunAt: string | null;
  lastAttempted: number;
  lastRestored: number;
  lastFailures: DeviceKeepaliveFailure[];
}

/**
 * ADB over TCP 设备保活。
 *
 * 背景：TCP 设备连接只存在于 adb server 的内存中。server 一旦重启
 * （重启主机、adb kill-server、进程崩溃），全部设备会消失，且
 * 没有任何程序会自动重连。
 *
 * 本模块周期性比对目标地址与当前设备列表，对缺失或 offline 的目标
 * 执行 adb connect（offline 的先 disconnect 再 connect），从而自愈。
 */
export class DeviceKeepalive {
  private readonly targets: string[];
  private intervalId?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private lastRunAt: Date | null = null;
  private lastAttempted = 0;
  private lastRestored = 0;
  private lastFailures: DeviceKeepaliveFailure[] = [];
  private onlineCount = 0;
  private missing: string[] = [];

  constructor(private readonly options: DeviceKeepaliveOptions) {
    this.targets = [...new Set(options.targets)];
  }

  get enabled(): boolean {
    return this.targets.length > 0;
  }

  getTargets(): string[] {
    return [...this.targets];
  }

  /**
   * 立即执行一轮补齐。用于启动阶段，保证首次设备列表就是完整的。
   * 即使未调用 start() 也可以单独使用。
   */
  async connectMissingOnce(): Promise<void> {
    await this.runOnce();
  }

  start(): void {
    if (!this.enabled || this.intervalId) {
      return;
    }

    this.stopped = false;
    this.intervalId = setInterval(() => {
      void this.runOnce();
    }, this.options.intervalMs);

    console.log(
      `[agent] keepalive started: ${this.targets.length} target(s), interval ${this.options.intervalMs}ms, concurrency ${this.options.concurrency}`
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  getStatus(): DeviceKeepaliveStatus {
    return {
      enabled: this.enabled,
      targetCount: this.targets.length,
      onlineCount: this.onlineCount,
      missing: [...this.missing],
      lastRunAt: this.lastRunAt ? this.lastRunAt.toISOString() : null,
      lastAttempted: this.lastAttempted,
      lastRestored: this.lastRestored,
      lastFailures: [...this.lastFailures]
    };
  }

  private async runOnce(): Promise<void> {
    if (this.stopped || this.running || !this.enabled) {
      return;
    }

    this.running = true;

    try {
      const devices = await this.options.adbClient.listDevices();
      const stateBySerial = new Map(devices.map((device) => [device.serial, device.state]));

      const missing = this.targets.filter((target) => stateBySerial.get(target) !== "device");

      this.lastRunAt = new Date();
      this.missing = missing;
      this.onlineCount = this.targets.length - missing.length;

      if (missing.length === 0) {
        this.lastAttempted = 0;
        this.lastRestored = 0;
        this.lastFailures = [];
        return;
      }

      console.log(
        `[agent] keepalive: ${missing.length}/${this.targets.length} target(s) not ready, reconnecting`
      );

      const results = await mapWithConcurrency(
        missing,
        this.options.concurrency,
        async (address): Promise<AdbConnectResult> => {
          const state = stateBySerial.get(address);

          // offline / unauthorized 的残留记录需要先断开，否则 connect 通常不会生效
          if (state === "offline" || state === "unauthorized") {
            await this.options.adbClient.disconnect(address);
          }

          return this.options.adbClient.connect(address);
        }
      );

      const failures = results
        .filter((result) => !result.ok)
        .map((result) => ({ address: result.address, message: result.message }));

      this.lastAttempted = results.length;
      this.lastRestored = results.length - failures.length;
      this.lastFailures = failures;

      if (this.lastRestored > 0) {
        // 以重新枚举的结果为准，而不是仅凭 connect 的输出
        const after = await this.options.adbClient.listDevices();
        const afterMap = new Map(after.map((device) => [device.serial, device.state]));
        this.missing = this.targets.filter((target) => afterMap.get(target) !== "device");
        this.onlineCount = this.targets.length - this.missing.length;

        console.log(
          `[agent] keepalive: restored ${this.lastRestored}/${results.length}, now ${this.onlineCount}/${this.targets.length} online`
        );

        await this.options.onDevicesChanged?.();
      }

      failures.slice(0, 5).forEach((failure) => {
        console.warn(`[agent] keepalive failed ${failure.address}: ${failure.message}`);
      });
    } catch (error) {
      console.error(
        `[agent] keepalive run failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.running = false;
    }
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const size = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: size }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index]);
      }
    })
  );

  return results;
}
