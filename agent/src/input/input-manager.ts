import { AdbClient } from "../adb/adb-client.js";
import {
  ScrcpyControlManager,
  type ScrcpyKeyName,
  type ScrcpyTouchPhase
} from "../scrcpy/scrcpy-control-manager.js";

export type DeviceInputCommand =
  | {
      action: "touch";
      phase: ScrcpyTouchPhase;
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
      durationMs?: number;
    }
  | {
      action: "keyevent";
      key: ScrcpyKeyName;
    };

interface ActiveTouchGesture {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startedAt: number;
}

export class InputManager {
  private readonly activeTouches = new Map<string, ActiveTouchGesture>();

  constructor(
    private readonly adbClient: AdbClient,
    private readonly scrcpyControlManager: ScrcpyControlManager
  ) {}

  async execute(serial: string, command: DeviceInputCommand): Promise<void> {
    console.log(`[agent] input ${serial}: ${describeCommand(command)}`);

    switch (command.action) {
      case "touch":
        await this.executeTouchGesture(serial, command);
        return;
      case "tap":
        await this.adbClient.tap(serial, command.x, command.y);
        return;
      case "swipe":
        await this.adbClient.swipe(
          serial,
          command.startX,
          command.startY,
          command.endX,
          command.endY,
          command.durationMs ?? 240
        );
        return;
      case "keyevent":
        await this.adbClient.keyevent(serial, command.key);
        return;
      default: {
        const neverCommand: never = command;
        throw new Error(`Unsupported input action: ${JSON.stringify(neverCommand)}`);
      }
    }
  }

  private async executeTouchGesture(
    serial: string,
    command: Extract<DeviceInputCommand, { action: "touch" }>
  ): Promise<void> {
    const gestureKey = `${serial}:${command.pointerId}`;
    const existing = this.activeTouches.get(gestureKey);

    switch (command.phase) {
      case "down":
        this.activeTouches.set(gestureKey, {
          startX: command.x,
          startY: command.y,
          lastX: command.x,
          lastY: command.y,
          startedAt: Date.now()
        });
        return;
      case "move":
        if (!existing) {
          this.activeTouches.set(gestureKey, {
            startX: command.x,
            startY: command.y,
            lastX: command.x,
            lastY: command.y,
            startedAt: Date.now()
          });
          return;
        }

        existing.lastX = command.x;
        existing.lastY = command.y;
        return;
      case "up": {
        const gesture = existing ?? {
          startX: command.x,
          startY: command.y,
          lastX: command.x,
          lastY: command.y,
          startedAt: Date.now()
        };

        this.activeTouches.delete(gestureKey);

        const endX = command.x;
        const endY = command.y;
        const distance = Math.hypot(endX - gesture.startX, endY - gesture.startY);
        const durationMs = Math.max(80, Math.min(900, Date.now() - gesture.startedAt));

        if (distance < 18) {
          await this.adbClient.tap(serial, endX, endY);
          return;
        }

        await this.adbClient.swipe(serial, gesture.startX, gesture.startY, endX, endY, durationMs);
        return;
      }
    }
  }
}

function describeCommand(command: DeviceInputCommand): string {
  switch (command.action) {
    case "tap":
      return `tap ${Math.round(command.x)},${Math.round(command.y)}`;
    case "touch":
      return `touch ${command.phase} ${Math.round(command.x)},${Math.round(command.y)} @ ${command.screenWidth}x${command.screenHeight}`;
    case "swipe":
      return `swipe ${Math.round(command.startX)},${Math.round(command.startY)} -> ${Math.round(command.endX)},${Math.round(command.endY)} (${command.durationMs ?? 240}ms)`;
    case "keyevent":
      return `keyevent ${command.key}`;
  }
}
