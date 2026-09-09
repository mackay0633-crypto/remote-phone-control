import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { AdbClient } from "../adb/adb-client.js";
import type { DeviceInfo } from "../device/device-types.js";
import { DeviceTracker } from "../device/device-tracker.js";
import { InputManager, type DeviceInputCommand } from "../input/input-manager.js";
import { ScrcpyControlManager } from "../scrcpy/scrcpy-control-manager.js";
import { H264StreamSession } from "../stream/h264-stream-session.js";

interface AgentServerOptions {
  host: string;
  port: number;
  deviceTracker: DeviceTracker;
  adbPath: string;
  scrcpyServerPath: string;
  streamMaxSize: number;
  streamBitRate: number;
}

export class AgentServer {
  private readonly server;
  private readonly wsServer;
  private readonly streamWsServer;
  private readonly inputManager;
  private latestDevices: DeviceInfo[] = [];

  constructor(private readonly options: AgentServerOptions) {
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.inputManager = new InputManager(
      new AdbClient(this.options.adbPath),
      new ScrcpyControlManager({
        adbPath: this.options.adbPath,
        scrcpyServerPath: this.options.scrcpyServerPath
      })
    );

    this.wsServer = new WebSocketServer({ noServer: true });
    this.streamWsServer = new WebSocketServer({ noServer: true });

    this.server.on("upgrade", (req, socket, head) => {
      if ((req.url ?? "").startsWith("/ws/stream")) {
        this.streamWsServer.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          this.streamWsServer.emit("connection", ws, req);
        });
        return;
      }

      if ((req.url ?? "").startsWith("/ws")) {
        this.wsServer.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          this.wsServer.emit("connection", ws, req);
        });
        return;
      }

      socket.destroy();
    });

    this.wsServer.on("connection", (socket: WebSocket) => {
      socket.send(this.serializeDevices());

      socket.on("message", (rawMessage) => {
        void this.handleSocketMessage(socket, rawMessage);
      });
    });

    this.streamWsServer.on("connection", (socket: WebSocket, req: IncomingMessage) => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
        const serial = url.searchParams.get("serial");
        console.log(`[agent] stream ws connected: ${req.url ?? "/"}`);

        if (!serial) {
          socket.send(JSON.stringify({ type: "stream-error", message: "Missing serial" }));
          setTimeout(() => socket.close(), 80);
          return;
        }

        const device = this.options.deviceTracker.getDevice(serial);
        if (!device) {
          socket.send(JSON.stringify({ type: "stream-error", message: `Device not found: ${serial}` }));
          setTimeout(() => socket.close(), 80);
          return;
        }

        console.log(`[agent] starting stream session for ${serial}`);

        const session = new H264StreamSession({
          adbPath: this.options.adbPath,
          serial,
          maxSize: this.options.streamMaxSize,
          bitRate: this.options.streamBitRate,
          width: device.width,
          height: device.height
        });

        socket.send(
          JSON.stringify({
            type: "stream-ready",
            serial,
            width: device.width,
            height: device.height
          })
        );

        let firstChunkLogged = false;

        const unbindData = session.onData((chunk) => {
          if (!firstChunkLogged) {
            firstChunkLogged = true;
            console.log(`[agent] first stream chunk for ${serial}: ${chunk.length} bytes`);
          }

          if (socket.readyState === 1) {
            socket.send(chunk, { binary: true });
          }
        });

        const unbindError = session.onError((payload) => {
          console.log(`[agent] stream error for ${serial}: ${String(payload)}`);

          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ type: "stream-log", level: "error", message: String(payload) }));
          }
        });

        const unbindClose = session.onClose(() => {
          console.log(`[agent] stream session closed for ${serial}`);

          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ type: "stream-log", level: "info", message: "stream restarted" }));
          }
        });

        session.start();

        socket.on("close", () => {
          console.log(`[agent] stream ws closed for ${serial}`);
          unbindData();
          unbindError();
          unbindClose();
          session.stop();
        });
      } catch (error) {
        console.error(`[agent] stream ws fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        try {
          socket.send(JSON.stringify({ type: "stream-error", message: "Agent stream setup failed" }));
        } finally {
          socket.close();
        }
      }
    });

    this.options.deviceTracker.subscribe((devices) => {
      this.latestDevices = devices;
      const payload = this.serializeDevices();

      this.wsServer.clients.forEach((client: WebSocket) => {
        if (client.readyState === 1) {
          client.send(payload);
        }
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(this.options.port, this.options.host, () => resolve());
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      this.sendJson(res, 200, {
        ok: true,
        devices: this.latestDevices.length
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/devices") {
      this.sendJson(res, 200, {
        devices: this.latestDevices,
        updatedAt: new Date().toISOString()
      });
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/devices/")) {
      const handled = await this.handleInputRequest(url, req, res);
      if (handled) {
        return;
      }
    }

    this.sendJson(res, 404, {
      error: "Not Found"
    });
  }

  private sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8"
    });
    res.end(JSON.stringify(payload));
  }

  private serializeDevices(): string {
    return JSON.stringify({
      type: "devices",
      devices: this.latestDevices,
      updatedAt: new Date().toISOString()
    });
  }

  private async handleSocketMessage(socket: WebSocket, rawMessage: WebSocket.RawData): Promise<void> {
    try {
      const payload = JSON.parse(rawMessage.toString()) as {
        type: string;
        serial?: string;
        command?: DeviceInputCommand;
      };

      if (payload.type !== "input" || !payload.serial || !payload.command) {
        return;
      }

      const device = this.options.deviceTracker.getDevice(payload.serial);
      if (!device) {
        socket.send(
          JSON.stringify({
            type: "input-error",
            serial: payload.serial,
            message: `Device not found: ${payload.serial}`
          })
        );
        return;
      }

      await this.inputManager.execute(payload.serial, payload.command);
    } catch (error) {
      if (socket.readyState === 1) {
        socket.send(
          JSON.stringify({
            type: "input-error",
            message: error instanceof Error ? error.message : String(error)
          })
        );
      }
    }
  }

  private async handleInputRequest(
    url: URL,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> {
    const match = url.pathname.match(/^\/api\/devices\/([^/]+)\/input$/);
    if (!match) {
      return false;
    }

    const serial = decodeURIComponent(match[1]);
    const device = this.options.deviceTracker.getDevice(serial);

    if (!device) {
      this.sendJson(res, 404, {
        error: `Device not found: ${serial}`
      });
      return true;
    }

    try {
      const payload = (await readJsonBody(req)) as DeviceInputCommand;
      await this.inputManager.execute(serial, payload);

      this.sendJson(res, 200, {
        ok: true,
        serial,
        action: payload.action
      });
    } catch (error) {
      this.sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return true;
  }
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) {
    throw new Error("Request body is required");
  }

  return JSON.parse(body);
}
