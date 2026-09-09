import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createConnection, createServer, type Socket } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SCRCPY_SERVER_DEVICE_PATH = "/data/local/tmp/scrcpy-server.jar";
const SCRCPY_SERVER_VERSION = "3.3.4";
const CONTROL_MSG_TYPE_INJECT_KEYCODE = 0;
const CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT = 2;
const AKEY_EVENT_ACTION_DOWN = 0;
const AKEY_EVENT_ACTION_UP = 1;
const AMOTION_EVENT_ACTION_DOWN = 0;
const AMOTION_EVENT_ACTION_UP = 1;
const AMOTION_EVENT_ACTION_MOVE = 2;
const POINTER_ID_GENERIC_FINGER = BigInt(-2);

export type ScrcpyKeyName = "HOME" | "BACK" | "APP_SWITCH";
export type ScrcpyTouchPhase = "down" | "move" | "up";

interface ScrcpyControlManagerOptions {
  adbPath: string;
  scrcpyServerPath: string;
}

interface ScrcpyControlSessionOptions extends ScrcpyControlManagerOptions {
  serial: string;
}

interface TouchEventPayload {
  phase: ScrcpyTouchPhase;
  pointerId: number;
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
}

export class ScrcpyControlManager {
  private readonly sessions = new Map<string, Promise<ScrcpyControlSession>>();

  constructor(private readonly options: ScrcpyControlManagerOptions) {}

  async sendTouch(serial: string, payload: TouchEventPayload): Promise<void> {
    const session = await this.getSession(serial);

    try {
      await session.sendTouch(payload);
    } catch (error) {
      this.sessions.delete(serial);
      await session.dispose();
      throw error;
    }
  }

  async sendKeyevent(serial: string, key: ScrcpyKeyName): Promise<void> {
    const session = await this.getSession(serial);

    try {
      await session.sendKeyevent(key);
    } catch (error) {
      this.sessions.delete(serial);
      await session.dispose();
      throw error;
    }
  }

  private async getSession(serial: string): Promise<ScrcpyControlSession> {
    let pending = this.sessions.get(serial);
    if (!pending) {
      pending = this.createSession(serial);
      this.sessions.set(serial, pending);
    }

    try {
      const session = await pending;
      if (session.isConnected()) {
        return session;
      }

      this.sessions.delete(serial);

      const recreated = this.createSession(serial);
      this.sessions.set(serial, recreated);
      return await recreated;
    } catch (error) {
      this.sessions.delete(serial);
      throw error;
    }
  }

  private async createSession(serial: string): Promise<ScrcpyControlSession> {
    const session = new ScrcpyControlSession({
      adbPath: this.options.adbPath,
      scrcpyServerPath: this.options.scrcpyServerPath,
      serial
    });

    await session.start();
    return session;
  }
}

class ScrcpyControlSession {
  private socket?: Socket;
  private adbShellProcess?: ChildProcessByStdio<null, Readable, Readable>;
  private readonly socketName;
  private readonly scidHex;
  private localPort = 0;
  private disposed = false;
  private sendChain = Promise.resolve();

  constructor(private readonly options: ScrcpyControlSessionOptions) {
    this.scidHex = Math.floor(Math.random() * 0x7fffffff)
      .toString(16)
      .padStart(8, "0");
    this.socketName = `scrcpy_${this.scidHex}`;
  }

  async start(): Promise<void> {
    this.localPort = await getFreeTcpPort();
    await this.pushServer();
    await this.forwardPort();
    await this.launchServer();
    this.socket = await this.connectSocketWithRetry();
    this.socket.on("close", () => {
      this.socket = undefined;
    });
    this.socket.on("error", (error) => {
      console.error(`[agent] scrcpy control socket error for ${this.options.serial}: ${error.message}`);
    });
    console.log(
      `[agent] scrcpy control ready for ${this.options.serial} on tcp:${this.localPort} (${this.socketName})`
    );
  }

  async sendTouch(payload: TouchEventPayload): Promise<void> {
    const phaseCode = mapTouchPhase(payload.phase);
    const pressure = payload.phase === "up" ? 0 : 0xffff;
    const buffer = Buffer.alloc(32);

    buffer.writeUInt8(CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT, 0);
    buffer.writeUInt8(phaseCode, 1);
    buffer.writeBigInt64BE(normalizePointerId(payload.pointerId), 2);
    buffer.writeInt32BE(Math.round(payload.x), 10);
    buffer.writeInt32BE(Math.round(payload.y), 14);
    buffer.writeUInt16BE(clampUInt16(payload.screenWidth), 18);
    buffer.writeUInt16BE(clampUInt16(payload.screenHeight), 20);
    buffer.writeUInt16BE(pressure, 22);
    buffer.writeUInt32BE(0, 24);
    buffer.writeUInt32BE(0, 28);

    await this.enqueueWrite(buffer);
  }

  async sendKeyevent(key: ScrcpyKeyName): Promise<void> {
    const keycode = mapAndroidKeyCode(key);
    await this.enqueueWrite(buildKeyEventBuffer(AKEY_EVENT_ACTION_DOWN, keycode));
    await this.enqueueWrite(buildKeyEventBuffer(AKEY_EVENT_ACTION_UP, keycode));
  }

  isConnected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed && this.socket.writable);
  }

  async dispose(): Promise<void> {
    this.disposed = true;

    this.socket?.destroy();
    this.socket = undefined;

    if (this.adbShellProcess && !this.adbShellProcess.killed) {
      this.adbShellProcess.kill();
    }
    this.adbShellProcess = undefined;

    if (this.localPort) {
      try {
        await execFileAsync(this.options.adbPath, [
          "-s",
          this.options.serial,
          "forward",
          "--remove",
          `tcp:${this.localPort}`
        ]);
      } catch {
        // Best-effort cleanup for a development session.
      }
    }
  }

  private async pushServer(): Promise<void> {
    await execFileAsync(this.options.adbPath, [
      "-s",
      this.options.serial,
      "push",
      this.options.scrcpyServerPath,
      SCRCPY_SERVER_DEVICE_PATH
    ]);
  }

  private async forwardPort(): Promise<void> {
    await execFileAsync(this.options.adbPath, [
      "-s",
      this.options.serial,
      "forward",
      `tcp:${this.localPort}`,
      `localabstract:${this.socketName}`
    ]);
  }

  private async launchServer(): Promise<void> {
    const args = [
      "-s",
      this.options.serial,
      "shell",
      `CLASSPATH=${SCRCPY_SERVER_DEVICE_PATH}`,
      "app_process",
      "/",
      "com.genymobile.scrcpy.Server",
      SCRCPY_SERVER_VERSION,
      `scid=${this.scidHex}`,
      "log_level=info",
      "video=false",
      "audio=false",
      "tunnel_forward=true",
      "cleanup=false",
      "power_on=false",
      "clipboard_autosync=false",
      "send_device_meta=false",
      "send_dummy_byte=false",
      "raw_stream=true"
    ];

    this.adbShellProcess = spawn(this.options.adbPath, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const process = this.adbShellProcess;

    process.stdout.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        console.log(`[agent] scrcpy ctl stdout ${this.options.serial}: ${message}`);
      }
    });

    process.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        console.log(`[agent] scrcpy ctl stderr ${this.options.serial}: ${message}`);
      }
    });

    process.on("exit", (code, signal) => {
      if (!this.disposed) {
        console.log(`[agent] scrcpy ctl exited for ${this.options.serial}: code=${code} signal=${signal}`);
      }
    });
  }

  private async connectSocketWithRetry(): Promise<Socket> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      try {
        return await connectSocket(this.localPort);
      } catch (error) {
        lastError = error;
        await wait(120);
      }
    }

    throw new Error(
      `Failed to connect scrcpy control socket for ${this.options.serial}: ${String(lastError)}`
    );
  }

  private async write(buffer: Buffer): Promise<void> {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) {
      throw new Error(`scrcpy control socket is not connected for ${this.options.serial}`);
    }

    await new Promise<void>((resolve, reject) => {
      this.socket!.write(buffer, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async enqueueWrite(buffer: Buffer): Promise<void> {
    const pending = this.sendChain.then(() => this.write(buffer));
    this.sendChain = pending.catch(() => undefined);
    await pending;
  }
}

function buildKeyEventBuffer(action: number, keycode: number): Buffer {
  const buffer = Buffer.alloc(14);
  buffer.writeUInt8(CONTROL_MSG_TYPE_INJECT_KEYCODE, 0);
  buffer.writeUInt8(action, 1);
  buffer.writeInt32BE(keycode, 2);
  buffer.writeInt32BE(0, 6);
  buffer.writeInt32BE(0, 10);
  return buffer;
}

function mapTouchPhase(phase: ScrcpyTouchPhase): number {
  switch (phase) {
    case "down":
      return AMOTION_EVENT_ACTION_DOWN;
    case "move":
      return AMOTION_EVENT_ACTION_MOVE;
    case "up":
      return AMOTION_EVENT_ACTION_UP;
  }
}

function mapAndroidKeyCode(key: ScrcpyKeyName): number {
  switch (key) {
    case "HOME":
      return 3;
    case "BACK":
      return 4;
    case "APP_SWITCH":
      return 187;
  }
}

function clampUInt16(value: number): number {
  return Math.max(0, Math.min(0xffff, Math.round(value)));
}

function normalizePointerId(pointerId: number): bigint {
  if (Number.isFinite(pointerId) && pointerId >= 0) {
    return BigInt(Math.round(pointerId));
  }

  return POINTER_ID_GENERIC_FINGER;
}

async function connectSocket(port: number): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({
      host: "127.0.0.1",
      port
    });

    socket.once("connect", () => resolve(socket));
    socket.once("error", (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

async function getFreeTcpPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a TCP port")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function wait(durationMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}
