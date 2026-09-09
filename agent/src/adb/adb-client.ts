import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RawAdbDevice {
  serial: string;
  state: string;
}

export interface AdbDeviceMeta {
  model: string;
  androidVersion: string;
  width: number;
  height: number;
}

export class AdbClient {
  constructor(private readonly adbPath: string) {}

  async listDevices(): Promise<RawAdbDevice[]> {
    const { stdout } = await execFileAsync(this.adbPath, ["devices"]);
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith("List of devices attached"));

    return lines
      .map((line) => line.split(/\s+/))
      .filter((parts) => parts.length >= 2)
      .map(([serial, state]) => ({ serial, state }));
  }

  async getDeviceMeta(serial: string): Promise<AdbDeviceMeta> {
    const [model, androidVersion, wmSize] = await Promise.all([
      this.runShell(serial, ["getprop", "ro.product.model"]),
      this.runShell(serial, ["getprop", "ro.build.version.release"]),
      this.runShell(serial, ["wm", "size"])
    ]);

    const { width, height } = parseWmSize(wmSize);

    return {
      model: model.trim() || "Unknown",
      androidVersion: androidVersion.trim() || "Unknown",
      width,
      height
    };
  }

  async tap(serial: string, x: number, y: number): Promise<void> {
    await this.runShell(serial, ["input", "tap", String(Math.round(x)), String(Math.round(y))]);
  }

  async swipe(
    serial: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    durationMs: number
  ): Promise<void> {
    await this.runShell(serial, [
      "input",
      "swipe",
      String(Math.round(startX)),
      String(Math.round(startY)),
      String(Math.round(endX)),
      String(Math.round(endY)),
      String(Math.max(50, Math.round(durationMs)))
    ]);
  }

  async keyevent(serial: string, key: "HOME" | "BACK" | "APP_SWITCH"): Promise<void> {
    const keyCode = mapKeyCode(key);
    await this.runShell(serial, ["input", "keyevent", keyCode]);
  }

  private async runShell(serial: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(this.adbPath, ["-s", serial, "shell", ...args]);
    return stdout.trim();
  }
}

function mapKeyCode(key: "HOME" | "BACK" | "APP_SWITCH"): string {
  switch (key) {
    case "HOME":
      return "3";
    case "BACK":
      return "4";
    case "APP_SWITCH":
      return "187";
  }
}

function parseWmSize(output: string): { width: number; height: number } {
  const overrideMatch = output.match(/Override size:\s*(\d+)x(\d+)/i);
  if (overrideMatch) {
    return {
      width: Number(overrideMatch[1]),
      height: Number(overrideMatch[2])
    };
  }

  const physicalMatch = output.match(/Physical size:\s*(\d+)x(\d+)/i);
  if (physicalMatch) {
    return {
      width: Number(physicalMatch[1]),
      height: Number(physicalMatch[2])
    };
  }

  return { width: 0, height: 0 };
}
