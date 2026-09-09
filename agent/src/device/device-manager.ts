import { AdbClient } from "../adb/adb-client.js";
import type { DeviceInfo, DeviceStatus } from "./device-types.js";

export class DeviceManager {
  constructor(private readonly adbClient: AdbClient) {}

  async listDevices(): Promise<DeviceInfo[]> {
    const rawDevices = await this.adbClient.listDevices();

    const devices = await Promise.all(
      rawDevices.map(async (rawDevice) => {
        const status = mapStatus(rawDevice.state);

        if (status !== "online") {
          return {
            serial: rawDevice.serial,
            status,
            model: "Unknown",
            androidVersion: "Unknown",
            width: 0,
            height: 0,
            streamStatus: "idle" as const,
            controlStatus: "idle" as const,
            transport: detectTransport(rawDevice.serial)
          };
        }

        const meta = await this.adbClient.getDeviceMeta(rawDevice.serial);

        return {
          serial: rawDevice.serial,
          status,
          model: meta.model,
          androidVersion: meta.androidVersion,
          width: meta.width,
          height: meta.height,
          streamStatus: "idle" as const,
          controlStatus: "ready" as const,
          transport: detectTransport(rawDevice.serial)
        };
      })
    );

    return devices.sort((left, right) => left.serial.localeCompare(right.serial));
  }
}

function mapStatus(state: string): DeviceStatus {
  switch (state) {
    case "device":
      return "online";
    case "offline":
      return "offline";
    case "unauthorized":
      return "unauthorized";
    default:
      return "unknown";
  }
}

function detectTransport(serial: string): "usb" | "tcp" {
  return serial.includes(":") ? "tcp" : "usb";
}
