import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

interface H264StreamSessionOptions {
  adbPath: string;
  serial: string;
  maxSize: number;
  bitRate: number;
  width: number;
  height: number;
}

type DataListener = (chunk: Buffer) => void;
type EventListener = (payload?: unknown) => void;

export class H264StreamSession {
  private process?: ChildProcessByStdio<null, Readable, Readable>;
  private stopped = false;
  private readonly dataListeners = new Set<DataListener>();
  private readonly closeListeners = new Set<EventListener>();
  private readonly errorListeners = new Set<EventListener>();

  constructor(private readonly options: H264StreamSessionOptions) {}

  start(): void {
    this.stopped = false;
    this.spawnProcess();
  }

  stop(): void {
    this.stopped = true;
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = undefined;
  }

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onClose(listener: EventListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: EventListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private spawnProcess(): void {
    const scaledSize = computeScaledSize(this.options.width, this.options.height, this.options.maxSize);
    const args = [
      "-s",
      this.options.serial,
      "exec-out",
      "screenrecord",
      "--output-format=h264",
      "--bit-rate",
      String(this.options.bitRate),
      "--size",
      scaledSize,
      "-"
    ];

    console.log(`[agent] spawn screenrecord for ${this.options.serial}: ${scaledSize} @ ${this.options.bitRate}`);

    const child = spawn(this.options.adbPath, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.process = child;

    child.stdout.on("data", (chunk: Buffer) => {
      this.dataListeners.forEach((listener) => listener(chunk));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message) {
        this.errorListeners.forEach((listener) => listener(message));
      }
    });

    child.on("error", (error) => {
      this.errorListeners.forEach((listener) => listener(error));
    });

    child.on("close", () => {
      this.closeListeners.forEach((listener) => listener());

      if (!this.stopped) {
        setTimeout(() => {
          if (!this.stopped) {
            this.spawnProcess();
          }
        }, 300);
      }
    });
  }
}

function computeScaledSize(width: number, height: number, maxSize: number): string {
  if (!width || !height) {
    return `${maxSize}x${maxSize}`;
  }

  const scale = Math.min(maxSize / Math.max(width, height), 1);
  const scaledWidth = alignToEven(Math.round(width * scale));
  const scaledHeight = alignToEven(Math.round(height * scale));

  return `${scaledWidth}x${scaledHeight}`;
}

function alignToEven(value: number): number {
  return value % 2 === 0 ? value : value - 1;
}
