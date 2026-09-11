import { AdbClient } from "./adb/adb-client.js";
import { AutojsClient } from "./autojs/autojs-client.js";
import { loadEnv, type AgentEnv } from "./config/env.js";
import { DeviceKeepalive } from "./device/device-keepalive.js";
import { DeviceManager } from "./device/device-manager.js";
import { DeviceTracker } from "./device/device-tracker.js";
import { AgentServer } from "./http/agent-server.js";
import { InputManager } from "./input/input-manager.js";
import { RelayClient } from "./relay/relay-client.js";
import { ScrcpyControlManager } from "./scrcpy/scrcpy-control-manager.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const adbClient = new AdbClient(env.adbPath);
  const deviceManager = new DeviceManager(adbClient);
  const deviceTracker = new DeviceTracker(deviceManager, env.pollIntervalMs);

  const keepalive = new DeviceKeepalive({
    adbClient,
    targets: env.deviceTcpTargets,
    intervalMs: env.deviceKeepaliveIntervalMs,
    concurrency: env.deviceKeepaliveConcurrency,
    onDevicesChanged: () => deviceTracker.refreshNow()
  });

  const autojsClient = new AutojsClient({
    baseUrl: env.autojsBaseUrl,
    timeoutMs: env.autojsTimeoutMs
  });

  logEnv(env, keepalive);

  if (process.argv.includes("--serve")) {
    // 先补齐设备再首次轮询，保证第一个设备列表就是完整的
    if (keepalive.enabled) {
      console.log("[agent] keepalive initial pass");
      await keepalive.connectMissingOnce();
    }

    await deviceTracker.start();
    keepalive.start();

    if (env.relayServerWsUrl) {
      const relayInputManager = new InputManager(
        new AdbClient(env.adbPath),
        new ScrcpyControlManager({
          adbPath: env.adbPath,
          scrcpyServerPath: env.scrcpyServerPath
        })
      );

      const relayClient = new RelayClient({
        relayServerWsUrl: env.relayServerWsUrl,
        agentId: env.agentId,
        deviceTracker,
        inputManager: relayInputManager,
        adbPath: env.adbPath,
        streamMaxSize: env.streamMaxSize,
        streamBitRate: env.streamBitRate
      });

      relayClient.start();
    }

    const server = new AgentServer({
      host: env.host,
      port: env.port,
      deviceTracker,
      adbPath: env.adbPath,
      scrcpyServerPath: env.scrcpyServerPath,
      streamMaxSize: env.streamMaxSize,
      streamBitRate: env.streamBitRate,
      deviceKeepalive: keepalive,
      autojsClient
    });

    await server.start();
    console.log(`[agent] api ready at http://${env.host}:${env.port}`);
    return;
  }

  // 单次模式（agent:devices）：先把保活目标补齐，再输出设备列表
  if (keepalive.enabled) {
    console.log("[agent] keepalive initial pass (one-shot mode)");
    await keepalive.connectMissingOnce();
  }

  await printDevices(deviceManager);
}

function logEnv(env: AgentEnv, keepalive: DeviceKeepalive): void {
  console.log("[agent] starting device discovery");
  console.log(`[agent] adb: ${env.adbPath}`);
  console.log(`[agent] scrcpy: ${env.scrcpyPath}`);
  console.log(`[agent] scrcpy-server: ${env.scrcpyServerPath}`);
  console.log(`[agent] poll interval: ${env.pollIntervalMs}ms`);
  console.log(`[agent] host: ${env.host}`);
  console.log(`[agent] port: ${env.port}`);
  console.log(`[agent] stream max size: ${env.streamMaxSize}`);
  console.log(`[agent] stream bit rate: ${env.streamBitRate}`);
  console.log(`[agent] relay ws: ${env.relayServerWsUrl || "disabled"}`);
  console.log(`[agent] agent id: ${env.agentId}`);
  console.log(`[agent] autojs: ${env.autojsBaseUrl} (timeout ${env.autojsTimeoutMs}ms)`);

  if (keepalive.enabled) {
    const targets = keepalive.getTargets();
    const preview = targets.length > 4
      ? `${targets.slice(0, 4).join(", ")} ... (${targets.length} total)`
      : targets.join(", ");
    console.log(`[agent] keepalive: enabled, ${env.deviceKeepaliveIntervalMs}ms interval -> ${preview}`);
  } else {
    console.log("[agent] keepalive: disabled (set DEVICE_TCP_RANGE to enable)");
  }
}

async function printDevices(deviceManager: DeviceManager): Promise<void> {
  try {
    const devices = await deviceManager.listDevices();

    console.log(`[agent] devices detected: ${devices.length}`);
    console.log(JSON.stringify(devices, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[agent] device discovery failed: ${message}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[agent] fatal error: ${message}`);
  process.exit(1);
});
