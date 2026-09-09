import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import WebSocket, { WebSocketServer } from "ws";

type DeviceStatus = "online" | "offline" | "unauthorized" | "unknown";
type StreamStatus = "idle" | "starting" | "streaming" | "error";
type ControlStatus = "idle" | "ready" | "error";

interface DeviceInfo {
  serial: string;
  status: DeviceStatus;
  model: string;
  androidVersion: string;
  width: number;
  height: number;
  streamStatus: StreamStatus;
  controlStatus: ControlStatus;
  transport: "usb" | "tcp";
}

interface RelayDeviceInfo extends DeviceInfo {
  agentId: string;
}

type DeviceInputCommand =
  | {
      action: "touch";
      phase: "down" | "move" | "up";
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
      durationMs: number;
    }
  | {
      action: "keyevent";
      key: "HOME" | "BACK" | "APP_SWITCH";
    };

interface RegisterAgentMessage {
  type: "register-agent";
  agentId: string;
}

interface DevicesMessage {
  type: "devices";
  devices: DeviceInfo[];
}

interface StartStreamMessage {
  type: "start-stream";
  serial: string;
}

interface StopStreamMessage {
  type: "stop-stream";
  serial: string;
}

interface InputMessage {
  type: "input";
  agentId?: string;
  serial: string;
  command: DeviceInputCommand;
}

interface InputErrorMessage {
  type: "input-error";
  serial?: string;
  message: string;
}

interface StreamEventMessage {
  type: "stream-ready" | "stream-log" | "stream-error";
  serial: string;
  width?: number;
  height?: number;
  message?: string;
}

type AgentMessage =
  | RegisterAgentMessage
  | DevicesMessage
  | InputErrorMessage
  | StreamEventMessage;

interface AgentConnection {
  agentId: string;
  socket: WebSocket;
  devices: DeviceInfo[];
}

interface StreamState {
  viewers: Set<WebSocket>;
  bootstrapChunks: Buffer[];
  bootstrapBytes: number;
  readyEvent?: StreamEventMessage;
}

const host = process.env.RELAY_HOST?.trim() || "0.0.0.0";
const port = Number(process.env.RELAY_PORT ?? "5081");
const STREAM_BOOTSTRAP_CACHE_LIMIT_BYTES = 512 * 1024;

const agents = new Map<string, AgentConnection>();
const viewerControlSockets = new Set<WebSocket>();
const streamStates = new Map<string, StreamState>();

const server = createServer((req, res) => {
  handleRequest(req, res);
});

const agentWsServer = new WebSocketServer({ noServer: true });
const viewerWsServer = new WebSocketServer({ noServer: true });
const viewerStreamWsServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`).pathname;

  if (pathname === "/ws/agent") {
    agentWsServer.handleUpgrade(req, socket, head, (ws) => {
      agentWsServer.emit("connection", ws, req);
    });
    return;
  }

  if (pathname === "/ws/viewer/stream") {
    viewerStreamWsServer.handleUpgrade(req, socket, head, (ws) => {
      viewerStreamWsServer.emit("connection", ws, req);
    });
    return;
  }

  if (pathname === "/ws/viewer") {
    viewerWsServer.handleUpgrade(req, socket, head, (ws) => {
      viewerWsServer.emit("connection", ws, req);
    });
    return;
  }

  socket.destroy();
});

agentWsServer.on("connection", (socket, req) => {
  let registeredAgentId = "";

  socket.on("message", (rawMessage, isBinary) => {
    if (isBinary) {
      if (!registeredAgentId) {
        return;
      }

      handleAgentBinary(registeredAgentId, rawMessage);
      return;
    }

    try {
      const payload = JSON.parse(rawMessage.toString()) as AgentMessage;

      switch (payload.type) {
        case "register-agent": {
          registeredAgentId = payload.agentId;
          const previous = agents.get(payload.agentId);
          if (previous && previous.socket !== socket) {
            previous.socket.close();
          }

          agents.set(payload.agentId, {
            agentId: payload.agentId,
            socket,
            devices: agents.get(payload.agentId)?.devices ?? []
          });
          broadcastDevices();
          console.log(`[relay] agent connected: ${payload.agentId}`);
          return;
        }
        case "devices": {
          if (!registeredAgentId) {
            return;
          }

          const agent = agents.get(registeredAgentId);
          if (!agent) {
            return;
          }

          agent.devices = payload.devices;
          broadcastDevices();
          return;
        }
        case "stream-ready":
        case "stream-log":
        case "stream-error": {
          if (!registeredAgentId) {
            return;
          }

          broadcastStreamEvent(registeredAgentId, payload);
          return;
        }
        case "input-error": {
          broadcastViewerMessage({
            type: "input-error",
            agentId: registeredAgentId,
            serial: payload.serial,
            message: payload.message
          });
          return;
        }
      }
    } catch (error) {
      console.error(`[relay] invalid agent message: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  socket.on("close", () => {
    if (!registeredAgentId) {
      return;
    }

    const current = agents.get(registeredAgentId);
    if (current?.socket === socket) {
      agents.delete(registeredAgentId);
      closeStreamsForAgent(registeredAgentId, "Agent disconnected");
      broadcastDevices();
      console.log(`[relay] agent disconnected: ${registeredAgentId}`);
    }
  });
});

viewerWsServer.on("connection", (socket) => {
  viewerControlSockets.add(socket);
  socket.send(serializeDevices());

  socket.on("message", (rawMessage) => {
    try {
      const payload = JSON.parse(rawMessage.toString()) as InputMessage;
      if (payload.type !== "input" || !payload.agentId) {
        return;
      }

      const agent = agents.get(payload.agentId);
      if (!agent || agent.socket.readyState !== WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "input-error",
            serial: payload.serial,
            message: `Agent not connected: ${payload.agentId}`
          })
        );
        return;
      }

      agent.socket.send(
        JSON.stringify({
          type: "input",
          serial: payload.serial,
          command: payload.command
        })
      );
    } catch (error) {
      socket.send(
        JSON.stringify({
          type: "input-error",
          message: error instanceof Error ? error.message : String(error)
        })
      );
    }
  });

  socket.on("close", () => {
    viewerControlSockets.delete(socket);
  });
});

viewerStreamWsServer.on("connection", (socket, req) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const agentId = url.searchParams.get("agentId") ?? "";
  const serial = url.searchParams.get("serial") ?? "";

  if (!agentId || !serial) {
    socket.send(JSON.stringify({ type: "stream-error", message: "Missing agentId or serial" }));
    socket.close();
    return;
  }

  const agent = agents.get(agentId);
  if (!agent || agent.socket.readyState !== WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "stream-error", message: `Agent not connected: ${agentId}` }));
    socket.close();
    return;
  }

  const key = getStreamKey(agentId, serial);
  const streamState = getOrCreateStreamState(key);
  const shouldStart = streamState.viewers.size === 0;
  streamState.viewers.add(socket);

  if (!shouldStart) {
    replayBootstrapToViewer(socket, agentId, streamState);
  }

  if (shouldStart) {
    agent.socket.send(JSON.stringify({ type: "start-stream", serial } satisfies StartStreamMessage));
  }

  socket.on("close", () => {
    const activeStreamState = streamStates.get(key);
    if (!activeStreamState) {
      return;
    }

    activeStreamState.viewers.delete(socket);
    if (activeStreamState.viewers.size > 0) {
      return;
    }

    streamStates.delete(key);
    const activeAgent = agents.get(agentId);
    if (activeAgent && activeAgent.socket.readyState === WebSocket.OPEN) {
      activeAgent.socket.send(JSON.stringify({ type: "stop-stream", serial } satisfies StopStreamMessage));
    }
  });
});

server.listen(Number.isFinite(port) ? port : 5081, host, () => {
  console.log(`[relay] server ready at http://${host}:${port}`);
});

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      agents: agents.size,
      devices: listDevices().length
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/devices") {
    sendJson(res, 200, {
      devices: listDevices(),
      updatedAt: new Date().toISOString()
    });
    return;
  }

  sendJson(res, 404, { error: "Not Found" });
}

function handleAgentBinary(agentId: string, rawMessage: WebSocket.RawData): void {
  const buffer = Buffer.isBuffer(rawMessage) ? rawMessage : Buffer.from(rawMessage as ArrayBuffer);
  if (buffer.length < 2) {
    return;
  }

  const serialLength = buffer.readUInt16BE(0);
  if (buffer.length < 2 + serialLength) {
    return;
  }

  const serial = buffer.subarray(2, 2 + serialLength).toString("utf8");
  const chunk = buffer.subarray(2 + serialLength);
  const streamState = streamStates.get(getStreamKey(agentId, serial));
  if (!streamState || streamState.viewers.size === 0) {
    return;
  }

  cacheBootstrapChunk(streamState, chunk);

  streamState.viewers.forEach((viewer) => {
    if (viewer.readyState === WebSocket.OPEN) {
      viewer.send(chunk, { binary: true });
    }
  });
}

function broadcastStreamEvent(agentId: string, payload: StreamEventMessage): void {
  const streamState = streamStates.get(getStreamKey(agentId, payload.serial));
  if (!streamState || streamState.viewers.size === 0) {
    return;
  }

  if (payload.type === "stream-ready") {
    streamState.readyEvent = payload;
    streamState.bootstrapChunks = [];
    streamState.bootstrapBytes = 0;
  }

  const message = JSON.stringify({
    ...payload,
    agentId
  });

  streamState.viewers.forEach((viewer) => {
    if (viewer.readyState === WebSocket.OPEN) {
      viewer.send(message);
    }
  });
}

function broadcastViewerMessage(payload: unknown): void {
  const serialized = JSON.stringify(payload);
  viewerControlSockets.forEach((viewer) => {
    if (viewer.readyState === WebSocket.OPEN) {
      viewer.send(serialized);
    }
  });
}

function broadcastDevices(): void {
  const serialized = serializeDevices();
  viewerControlSockets.forEach((viewer) => {
    if (viewer.readyState === WebSocket.OPEN) {
      viewer.send(serialized);
    }
  });
}

function serializeDevices(): string {
  return JSON.stringify({
    type: "devices",
    devices: listDevices(),
    updatedAt: new Date().toISOString()
  });
}

function listDevices(): RelayDeviceInfo[] {
  return Array.from(agents.values()).flatMap((agent) =>
    agent.devices.map((device) => ({
      ...device,
      agentId: agent.agentId
    }))
  );
}

function closeStreamsForAgent(agentId: string, message: string): void {
  Array.from(streamStates.entries()).forEach(([key, streamState]) => {
    if (!key.startsWith(`${agentId}::`)) {
      return;
    }

    streamState.viewers.forEach((viewer) => {
      if (viewer.readyState === WebSocket.OPEN) {
        viewer.send(JSON.stringify({ type: "stream-error", agentId, message }));
        viewer.close();
      }
    });

    streamStates.delete(key);
  });
}

function getStreamKey(agentId: string, serial: string): string {
  return `${agentId}::${serial}`;
}

function getOrCreateStreamState(key: string): StreamState {
  let streamState = streamStates.get(key);
  if (streamState) {
    return streamState;
  }

  streamState = {
    viewers: new Set<WebSocket>(),
    bootstrapChunks: [],
    bootstrapBytes: 0
  };
  streamStates.set(key, streamState);
  return streamState;
}

function replayBootstrapToViewer(viewer: WebSocket, agentId: string, streamState: StreamState): void {
  if (viewer.readyState !== WebSocket.OPEN) {
    return;
  }

  if (streamState.readyEvent) {
    viewer.send(
      JSON.stringify({
        ...streamState.readyEvent,
        agentId
      })
    );
  }

  streamState.bootstrapChunks.forEach((chunk) => {
    if (viewer.readyState === WebSocket.OPEN) {
      viewer.send(chunk, { binary: true });
    }
  });
}

function cacheBootstrapChunk(streamState: StreamState, chunk: Buffer): void {
  if (streamState.bootstrapBytes >= STREAM_BOOTSTRAP_CACHE_LIMIT_BYTES) {
    return;
  }

  const remaining = STREAM_BOOTSTRAP_CACHE_LIMIT_BYTES - streamState.bootstrapBytes;
  const cachedChunk = chunk.length <= remaining ? Buffer.from(chunk) : Buffer.from(chunk.subarray(0, remaining));
  streamState.bootstrapChunks.push(cachedChunk);
  streamState.bootstrapBytes += cachedChunk.length;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
