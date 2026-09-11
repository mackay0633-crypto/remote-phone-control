import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { AdbClient } from "../adb/adb-client.js";
import type { DeviceInfo } from "../device/device-types.js";
import { DeviceTracker } from "../device/device-tracker.js";
import { InputManager, type DeviceInputCommand } from "../input/input-manager.js";
import { ScrcpyControlManager } from "../scrcpy/scrcpy-control-manager.js";
import { H264StreamSession } from "../stream/h264-stream-session.js";
import type { DeviceKeepalive } from "../device/device-keepalive.js";
import { AutojsClient, AutojsError } from "../autojs/autojs-client.js";
import type { StartSendVideoInput } from "../autojs/autojs-types.js";

interface AgentServerOptions {
  host: string;
  port: number;
  deviceTracker: DeviceTracker;
  adbPath: string;
  scrcpyServerPath: string;
  streamMaxSize: number;
  streamBitRate: number;
  deviceKeepalive?: DeviceKeepalive;
  /** 未提供时 /api/autojs/* 返回 503 */
  autojsClient?: AutojsClient;
  /**
   * 解析本次请求允许操作的设备集合。
   *
   * 默认实现返回本 agent 已知的全部设备。接入多租户账号系统后，
   * 这里应改为「该用户被分配的设备」——它是配额能否真正生效的关键。
   */
  resolveAllowedDeviceIds?: () => Promise<string[]> | string[];
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
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        this.server.off("listening", onListening);

        if (error.code === "EADDRINUSE") {
          reject(
            new Error(
              `端口 ${this.options.port} 已被占用。可能还有另一个 agent 实例在运行，` +
                `请先停止它（查找占用进程：netstat -ano | findstr :${this.options.port}）`
            )
          );
          return;
        }

        if (error.code === "EACCES") {
          reject(new Error(`没有权限监听 ${this.options.host}:${this.options.port}`));
          return;
        }

        reject(error);
      };

      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };

      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.port, this.options.host);
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

    if (req.method === "GET" && url.pathname === "/api/devices/keepalive") {
      this.sendJson(
        res,
        200,
        this.options.deviceKeepalive?.getStatus() ?? {
          enabled: false,
          targetCount: 0,
          onlineCount: 0,
          missing: [],
          lastRunAt: null,
          lastAttempted: 0,
          lastRestored: 0,
          lastFailures: []
        }
      );
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/devices/")) {
      const handled = await this.handleInputRequest(url, req, res);
      if (handled) {
        return;
      }
    }

    if (url.pathname.startsWith("/api/autojs/")) {
      const handled = await this.handleAutojsRequest(url, req, res);
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

  /**
   * /api/autojs/* 路由。
   *
   * 写操作一律经由 AutojsClient，而客户端内部会先过校验层，
   * 因此结构上不存在「绕过校验」的路径。
   *
   * 注意：这里的读取接口返回的是 autojs 的**全局视图**。
   * 接入账号系统后，转发给最终用户之前必须按设备集过滤，
   * 否则用户会看到他人的账号与任务。
   */
  private async handleAutojsRequest(
    url: URL,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> {
    const client = this.options.autojsClient;
    if (!client) {
      this.sendJson(res, 503, {
        error: "autojs 客户端未启用",
        code: "autojs_disabled"
      });
      return true;
    }

    const isGet = req.method === "GET";
    const isPost = req.method === "POST";

    try {
      if (isGet && url.pathname === "/api/autojs/health") {
        this.sendJson(res, 200, await client.getHealth());
        return true;
      }

      if (isGet && url.pathname === "/api/autojs/run-status") {
        this.sendJson(res, 200, await client.getRunStatus());
        return true;
      }

      if (isGet && url.pathname === "/api/autojs/accounts") {
        this.sendJson(res, 200, await client.getAccounts());
        return true;
      }

      if (isGet && url.pathname === "/api/autojs/devices") {
        this.sendJson(res, 200, await client.getDevices());
        return true;
      }

      if (isPost && url.pathname === "/api/autojs/dayil-work/start") {
        // 故意声明为必填：缺失时交给 validateDeviceIds 报 400，而不是在这里放行
        const body = (await readJsonBody(req)) as { device_ids: unknown; config?: unknown };
        const allowed = await this.getAllowedDeviceIds();
        this.sendJson(res, 200, await client.startDayilWork(body, allowed));
        return true;
      }

      if (isPost && url.pathname === "/api/autojs/send-video/start") {
        const body = (await readJsonBody(req)) as StartSendVideoInput;
        const allowed = await this.getAllowedDeviceIds();
        this.sendJson(res, 200, await client.startSendVideo(body, allowed));
        return true;
      }

      return false;
    } catch (error) {
      this.sendJson(res, mapAutojsErrorStatus(error), {
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof AutojsError ? error.code : "unknown"
      });
      return true;
    }
  }

  /**
   * 本次调用允许操作的设备集合。
   *
   * 默认是本 agent 已知的全部设备。多租户账号系统接入后，
   * 必须通过 resolveAllowedDeviceIds 替换为「该用户被分配的设备」——
   * 这是配额与隔离能否真正生效的关键点。
   */
  private async getAllowedDeviceIds(): Promise<string[]> {
    if (this.options.resolveAllowedDeviceIds) {
      return this.options.resolveAllowedDeviceIds();
    }

    return this.options.deviceTracker.getDevices().map((device) => device.serial);
  }
}

function mapAutojsErrorStatus(error: unknown): number {
  if (error instanceof AutojsError) {
    switch (error.code) {
      case "validation_failed":
        return 400;
      case "not_activated":
        return 403;
      case "timeout":
        return 504;
      case "unreachable":
        return 502;
      case "task_failed":
      case "http_error":
      case "invalid_response":
        return 502;
    }
  }

  if (error instanceof SyntaxError) {
    return 400;
  }

  if (error instanceof Error && error.message === "Request body is required") {
    return 400;
  }

  return 500;
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
