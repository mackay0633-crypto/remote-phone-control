import { existsSync } from "node:fs";

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
}

function pickFirstExisting(paths: string[], fallback: string): string {
  const matched = paths.find((candidate) => existsSync(candidate));
  return matched ?? fallback;
}

export function loadEnv(): AgentEnv {
  const adbPath = process.env.ADB_PATH?.trim() || pickFirstExisting(
    [
      "C:\\Program Files\\Laixi\\tools\\platform-tools\\adb.exe",
      "C:\\Users\\admin\\Desktop\\scrcpy-win64-v3.3.4\\adb.exe"
    ],
    "adb"
  );

  const scrcpyPath = process.env.SCRCPY_PATH?.trim() || pickFirstExisting(
    [
      "C:\\Users\\admin\\Desktop\\scrcpy-win64-v3.3.4\\scrcpy.exe"
    ],
    "scrcpy"
  );

  const scrcpyServerPath = process.env.SCRCPY_SERVER_PATH?.trim() || pickFirstExisting(
    [
      "C:\\Users\\admin\\Desktop\\scrcpy-win64-v3.3.4\\scrcpy-server"
    ],
    "scrcpy-server"
  );

  const pollIntervalMs = Number(process.env.DEVICE_POLL_INTERVAL_MS ?? "5000");
  const port = Number(process.env.AGENT_PORT ?? "5071");
  const host = process.env.AGENT_HOST?.trim() || "127.0.0.1";
  const streamMaxSize = Number(process.env.STREAM_MAX_SIZE ?? "720");
  const streamBitRate = Number(process.env.STREAM_BIT_RATE ?? "2000000");
  const relayServerWsUrl = normalizeRelayServerWsUrl(process.env.RELAY_SERVER_WS_URL?.trim() || "");
  const agentId = process.env.AGENT_ID?.trim() || "agent-local";

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
    agentId
  };
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
