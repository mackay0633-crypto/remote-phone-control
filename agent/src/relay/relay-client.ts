import WebSocket from "ws";
import type { DeviceInfo } from "../device/device-types.js";
import { DeviceTracker } from "../device/device-tracker.js";
import { InputManager, type DeviceInputCommand } from "../input/input-manager.js";
import { H264StreamSession } from "../stream/h264-stream-session.js";

interface RelayClientOptions {
  relayServerWsUrl: string;
  agentId: string;
  deviceTracker: DeviceTracker;
  inputManager: InputManager;
  adbPath: string;
  streamMaxSize: number;
  streamBitRate: number;
}

interface ActiveRelayStream {
  session: H264StreamSession;
  serial: string;
}

type RelayMessage =
  | {
      type: "start-stream";
      serial: string;
    }
  | {
      type: "stop-stream";
      serial: string;
    }
  | {
      type: "input";
      serial: string;
      command: DeviceInputCommand;
    };

export class RelayClient {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private streams = new Map<string, ActiveRelayStream>();
  private readonly unsubscribeTracker: () => void;

  constructor(private readonly options: RelayClientOptions) {
    this.unsubscribeTracker = this.options.deviceTracker.subscribe((devices) => {
      this.sendJson({
        type: "devices",
        devices
      });
    });
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.unsubscribeTracker();
    this.stopAllStreams();
    this.socket?.close();
    this.socket = undefined;
  }

  private connect(): void {
    const socket = new WebSocket(this.options.relayServerWsUrl);
    this.socket = socket;

    socket.on("open", () => {
      console.log(`[agent] relay connected: ${this.options.relayServerWsUrl}`);
      this.sendJson({
        type: "register-agent",
        agentId: this.options.agentId
      });
      this.sendDevices(this.options.deviceTracker.getDevices());
    });

    socket.on("message", (rawMessage, isBinary) => {
      if (isBinary) {
        return;
      }

      try {
        const payload = JSON.parse(rawMessage.toString()) as RelayMessage;
        void this.handleRelayMessage(payload);
      } catch (error) {
        console.error(`[agent] relay message parse failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
      console.log("[agent] relay disconnected");
      this.stopAllStreams();
      this.scheduleReconnect();
    });

    socket.on("error", (error) => {
      console.error(`[agent] relay socket error: ${error.message}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 1500);
  }

  private async handleRelayMessage(payload: RelayMessage): Promise<void> {
    switch (payload.type) {
      case "start-stream":
        this.startStream(payload.serial);
        return;
      case "stop-stream":
        this.stopStream(payload.serial);
        return;
      case "input":
        try {
          await this.options.inputManager.execute(payload.serial, payload.command);
        } catch (error) {
          this.sendJson({
            type: "input-error",
            serial: payload.serial,
            message: error instanceof Error ? error.message : String(error)
          });
        }
        return;
    }
  }

  private startStream(serial: string): void {
    if (this.streams.has(serial)) {
      return;
    }

    const device = this.options.deviceTracker.getDevice(serial);
    if (!device) {
      this.sendJson({
        type: "stream-error",
        serial,
        message: `Device not found: ${serial}`
      });
      return;
    }

    const session = new H264StreamSession({
      adbPath: this.options.adbPath,
      serial,
      maxSize: this.options.streamMaxSize,
      bitRate: this.options.streamBitRate,
      width: device.width,
      height: device.height
    });

    session.onData((chunk) => {
      this.sendStreamChunk(serial, chunk);
    });

    session.onError((payload) => {
      this.sendJson({
        type: "stream-log",
        serial,
        message: String(payload)
      });
    });

    session.onClose(() => {
      this.sendJson({
        type: "stream-log",
        serial,
        message: "stream restarted"
      });
    });

    session.start();
    this.streams.set(serial, { serial, session });

    this.sendJson({
      type: "stream-ready",
      serial,
      width: device.width,
      height: device.height
    });

    console.log(`[agent] relay stream started for ${serial}`);
  }

  private stopStream(serial: string): void {
    const active = this.streams.get(serial);
    if (!active) {
      return;
    }

    active.session.stop();
    this.streams.delete(serial);
    console.log(`[agent] relay stream stopped for ${serial}`);
  }

  private stopAllStreams(): void {
    this.streams.forEach((active) => {
      active.session.stop();
    });
    this.streams.clear();
  }

  private sendDevices(devices: DeviceInfo[]): void {
    this.sendJson({
      type: "devices",
      devices
    });
  }

  private sendJson(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(payload));
  }

  private sendStreamChunk(serial: string, chunk: Buffer): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const serialBuffer = Buffer.from(serial, "utf8");
    const header = Buffer.alloc(2);
    header.writeUInt16BE(serialBuffer.length, 0);
    this.socket.send(Buffer.concat([header, serialBuffer, chunk]));
  }
}
