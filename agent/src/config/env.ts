import { parseDeviceTargets } from "../device/device-targets.js";

export interface AgentEnv {
  adbPath: string;
  scrcpyPath: string;
  scrcpyServerPath: string;
  pollIntervalMs: number;
  host: string;
  port: number;
  streamMaxSize: number;
  streamBitRate: number;
  relayServerWsUrl: string;
  agentId: string;
  /** ADB over TCP 保活目标，形如 `10.0.0.5:5555`。为空表示关闭保活。 */
  deviceTcpTargets: string[];
  deviceKeepaliveIntervalMs: number;
  deviceKeepaliveConcurrency: number;
  /** autojs-controller 服务地址 */
  autojsBaseUrl: string;
  /** autojs 请求超时；发视频含 adb push，默认给足时间 */
  autojsTimeoutMs: number;
}

/**
 * adb / scrcpy 的位置**不写死在源码里**。
 *
 * 原因：把本机绝对路径提交进仓库，别人 clone 后会得到一份指向你机器的配置，
 * 既误导他人，也让换机部署时容易踩坑。
 *
 * 请用环境变量指定（推荐）：
 *
 *   $env:ADB_PATH           = "C:\path\to\platform-tools\adb.exe"
 *   $env:SCRCPY_PATH        = "C:\path\to\scrcpy.exe"
 *   $env:SCRCPY_SERVER_PATH = "C:\path\to\scrcpy-server"
 *
 * 未设置时回退到 PATH 里的 `adb` / `scrcpy`。
 */
function resolveToolPath(envValue: string | undefined, fallback: string): string {
  const explicit = envValue?.trim();
  return explicit && explicit.length > 0 ? explicit : fallback;
}

export function loadEnv(): AgentEnv {
  const adbPath = resolveToolPath(process.env.ADB_PATH, "adb");
  const scrcpyPath = resolveToolPath(process.env.SCRCPY_PATH, "scrcpy");
  const scrcpyServerPath = resolveToolPath(process.env.SCRCPY_SERVER_PATH, "scrcpy-server");

  const pollIntervalMs = Number(process.env.DEVICE_POLL_INTERVAL_MS ?? "5000");
  const port = Number(process.env.AGENT_PORT ?? "5071");
  const host = process.env.AGENT_HOST?.trim() || "127.0.0.1";
  const streamMaxSize = Number(process.env.STREAM_MAX_SIZE ?? "720");
  const streamBitRate = Number(process.env.STREAM_BIT_RATE ?? "2000000");
  const relayServerWsUrl = normalizeRelayServerWsUrl(process.env.RELAY_SERVER_WS_URL?.trim() || "");
  const agentId = process.env.AGENT_ID?.trim() || "agent-local";

  const deviceTcpPort = Number(process.env.DEVICE_TCP_PORT ?? "5555");
  const deviceTcpTargets = parseDeviceTargets(
    process.env.DEVICE_TCP_RANGE?.trim() || "",
    Number.isFinite(deviceTcpPort) && deviceTcpPort > 0 ? deviceTcpPort : 5555
  );

  const keepaliveIntervalMs = Number(process.env.DEVICE_KEEPALIVE_INTERVAL_MS ?? "60000");
  const keepaliveConcurrency = Number(process.env.DEVICE_KEEPALIVE_CONCURRENCY ?? "4");

  const autojsBaseUrl = normalizeHttpBaseUrl(process.env.AUTOJS_BASE_URL?.trim() || "http://127.0.0.1:5000");
  const autojsTimeoutMs = Number(process.env.AUTOJS_TIMEOUT_MS ?? "300000");

  return {
    adbPath,
    scrcpyPath,
    scrcpyServerPath,
    pollIntervalMs: Number.isFinite(pollIntervalMs) ? pollIntervalMs : 5000,
    host,
    port: Number.isFinite(port) ? port : 5071,
    streamMaxSize: Number.isFinite(streamMaxSize) ? streamMaxSize : 720,
    streamBitRate: Number.isFinite(streamBitRate) ? streamBitRate : 2_000_000,
    relayServerWsUrl,
    agentId,
    deviceTcpTargets,
    deviceKeepaliveIntervalMs: Number.isFinite(keepaliveIntervalMs) && keepaliveIntervalMs >= 5000
      ? keepaliveIntervalMs
      : 60_000,
    deviceKeepaliveConcurrency: Number.isFinite(keepaliveConcurrency) && keepaliveConcurrency >= 1
      ? Math.min(keepaliveConcurrency, 16)
      : 4,
    autojsBaseUrl,
    autojsTimeoutMs: Number.isFinite(autojsTimeoutMs) && autojsTimeoutMs >= 1000 ? autojsTimeoutMs : 300_000
  };
}

function normalizeHttpBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      console.warn(`[agent] ignore invalid AUTOJS_BASE_URL protocol: ${value}`);
      return "http://127.0.0.1:5000";
    }

    return url.toString().replace(/\/+$/, "");
  } catch {
    console.warn(`[agent] ignore invalid AUTOJS_BASE_URL: ${value}`);
    return "http://127.0.0.1:5000";
  }
}

function normalizeRelayServerWsUrl(value: string): string {
  if (!value) {
    return "";
  }

  if (value.includes("<") || value.includes(">")) {
    console.warn(`[agent] ignore invalid relay ws url placeholder: ${value}`);
    return "";
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      console.warn(`[agent] ignore invalid relay ws url protocol: ${value}`);
      return "";
    }

    return url.toString();
  } catch {
    console.warn(`[agent] ignore invalid relay ws url: ${value}`);
    return "";
  }
}
