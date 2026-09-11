import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { openDatabase } from "./db/database.js";
import { ensureInitialAdmin, formatBootstrapBanner } from "./auth/bootstrap.js";
import { handleApiRequest, requireAdmin } from "./api/http.js";
import { listSerialsForUser, syncAgentDevices } from "./devices/store.js";
import { resolveSession } from "./auth/sessions.js";
import { findUserById, hasCapability, type UserRecord } from "./auth/users.js";
import { writeAudit } from "./db/audit.js";
import { getAccessEpoch } from "./access/epoch.js";

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

/**
 * 已通过鉴权的控制通道连接。
 *
 * `serials` / `user` 是一份**缓存**，由 `epoch` 决定是否仍然可信：
 * 管理员一改权限，纪元就 +1，下一条消息会重新查库。
 * 这样既满足「变更即刻生效」，又不必为每条输入消息查三次库
 * （拖动时输入可达每秒数十条）。
 */
interface ViewerSession {
  socket: WebSocket;
  token: string;
  user: UserRecord;
  /** 该账号允许操作的 serial 集合；管理员为全部在线设备 */
  serials: Set<string>;
  epoch: number;
  /** 上次校验会话本身是否仍有效的时刻 */
  sessionCheckedAt: number;
}

/** 已通过鉴权的视频流连接 */
interface StreamViewerSession extends ViewerSession {
  agentId: string;
  serial: string;
  key: string;
}

const host = process.env.RELAY_HOST?.trim() || "0.0.0.0";
const port = Number(process.env.RELAY_PORT ?? "5081");
const STREAM_BOOTSTRAP_CACHE_LIMIT_BYTES = 512 * 1024;

// ── 持久化与账号系统 ────────────────────────────────────────────────
const dbFile = process.env.RELAY_DB_FILE?.trim() || "data/relay.db";
const db = openDatabase(dbFile);

/**
 * API 上下文。
 *
 * `getOnlineSerials` 惰性求值：设备在线状态随时在变，
 * 不能在启动时快照一次。
 *
 * `onAccessChanged` 让管理页面的改动**立刻**作用于已建立的连接。
 */
const apiContext = {
  db,
  getOnlineSerials: (): Set<string> => new Set(listDevices().map((device) => device.serial)),
  onAccessChanged: (): void => revalidateViewers()
};

const agents = new Map<string, AgentConnection>();
const viewerSessions = new Map<WebSocket, ViewerSession>();
const streamViewerSessions = new Map<WebSocket, StreamViewerSession>();
const streamStates = new Map<string, StreamState>();

/** 鉴权超时：连上后必须在此时限内发送 auth 消息 */
const AUTH_TIMEOUT_MS = 5000;
/** 会话有效性的重校验间隔（权限变更由 epoch 立即触发，不依赖这个间隔） */
const SESSION_RECHECK_MS = 60_000;

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

          // 同步进库，让管理员能在后台看到并分配这些设备。
          // syncAgentDevices 只更新在线时间，不会覆盖 assigned_user_id。
          syncAgentDevices(
            db,
            registeredAgentId,
            payload.devices.map((device) => device.serial)
          );

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
          // 定向发送给拥有这台设备的人（管理员也收）。
          // 改造前是广播给所有 viewer，会把别人的设备号泄进错误提示里。
          sendToViewersOwning(payload.serial ?? "", {
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

/**
 * 控制通道。
 *
 * 与改造前最大的区别：**连上后不发送任何数据**，
 * 必须先发 `{ type: "auth", token }` 通过鉴权，才会收到设备列表。
 * 令牌不放在 URL 里——URL 会进服务器日志与浏览器历史。
 */
viewerWsServer.on("connection", (socket) => {
  const authTimer = setTimeout(() => {
    if (!viewerSessions.has(socket)) {
      rejectViewer(socket, "鉴权超时");
    }
  }, AUTH_TIMEOUT_MS);

  socket.on("message", (rawMessage) => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawMessage.toString()) as Record<string, unknown>;
    } catch {
      socket.send(JSON.stringify({ type: "input-error", message: "消息不是合法 JSON" }));
      return;
    }

    // ── 第一步：鉴权 ─────────────────────────────────────────
    const existing = viewerSessions.get(socket);

    if (!existing) {
      if (payload.type !== "auth" || typeof payload.token !== "string") {
        rejectViewer(socket, "首条消息必须是 { type: 'auth', token }");
        return;
      }

      const access = authenticateViewer(payload.token);
      if (!access) {
        rejectViewer(socket, "令牌无效、已过期，或账号已被禁用");
        return;
      }

      clearTimeout(authTimer);

      const viewer: ViewerSession = {
        socket,
        token: payload.token,
        user: access.user,
        serials: access.serials,
        epoch: getAccessEpoch(),
        sessionCheckedAt: Date.now()
      };

      viewerSessions.set(socket, viewer);

      socket.send(
        JSON.stringify({
          type: "auth-ok",
          user: {
            id: access.user.id,
            username: access.user.username,
            role: access.user.role,
            capabilities: access.user.capabilities
          }
        })
      );
      socket.send(serializeDevicesFor(viewer));

      console.log(
        `[relay] viewer authed: ${access.user.username} (${access.user.role}), ${access.serials.size} device(s)`
      );
      return;
    }

    // ── 第二步：已鉴权，处理业务消息 ──────────────────────────
    if (!refreshAccess(existing)) {
      rejectViewer(socket, "账号已被禁用或会话已失效");
      return;
    }

    if (payload.type !== "input") {
      return;
    }

    const serial = typeof payload.serial === "string" ? payload.serial : "";

    // 归属校验：只认库里的分配关系，不信任客户端传来的任何标识
    if (!serial || !existing.serials.has(serial)) {
      writeAudit(db, existing.user.id, "viewer.input_denied", serial || null, { reason: "not_owned" });
      socket.send(JSON.stringify({ type: "input-error", serial, message: "无权操作该设备" }));
      return;
    }

    if (!hasCapability(existing.user, "can_control_input")) {
      socket.send(JSON.stringify({ type: "input-error", serial, message: "当前账号没有手动操控权限" }));
      return;
    }

    // agentId 由服务端从在线设备表反查，客户端无法伪造
    const device = listDevices().find((item) => item.serial === serial);
    if (!device) {
      socket.send(JSON.stringify({ type: "input-error", serial, message: "设备当前不在线" }));
      return;
    }

    const agent = agents.get(device.agentId);
    if (!agent || agent.socket.readyState !== WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input-error", serial, message: `Agent 未连接: ${device.agentId}` }));
      return;
    }

    agent.socket.send(
      JSON.stringify({
        type: "input",
        serial,
        command: payload.command
      })
    );
  });

  socket.on("close", () => {
    clearTimeout(authTimer);
    viewerSessions.delete(socket);
  });
});

/**
 * 视频流通道。
 *
 * 同样要求先鉴权，然后才订阅。serial 放在查询串里（它不是秘密，
 * 只是个引用），但**没有通过鉴权之前不会推送任何字节**。
 * agentId 不再从查询串取——由服务端按 serial 反查，客户端无法伪造。
 */
viewerStreamWsServer.on("connection", (socket, req) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const requestedSerial = url.searchParams.get("serial") ?? "";

  const authTimer = setTimeout(() => {
    if (!streamViewerSessions.has(socket)) {
      rejectStream(socket, requestedSerial, "鉴权超时");
    }
  }, AUTH_TIMEOUT_MS);

  socket.on("message", (rawMessage, isBinary) => {
    if (isBinary) {
      return;
    }

    // 已鉴权的连接不再接受后续文本消息
    if (streamViewerSessions.has(socket)) {
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawMessage.toString()) as Record<string, unknown>;
    } catch {
      rejectStream(socket, requestedSerial, "消息不是合法 JSON");
      return;
    }

    if (payload.type !== "auth" || typeof payload.token !== "string") {
      rejectStream(socket, requestedSerial, "首条消息必须是 { type: 'auth', token }");
      return;
    }

    const access = authenticateViewer(payload.token);
    if (!access) {
      rejectStream(socket, requestedSerial, "令牌无效、已过期，或账号已被禁用");
      return;
    }

    clearTimeout(authTimer);

    const viewer: StreamViewerSession = {
      socket,
      token: payload.token,
      user: access.user,
      serials: access.serials,
      epoch: getAccessEpoch(),
      sessionCheckedAt: Date.now(),
      agentId: "",
      serial: requestedSerial,
      key: ""
    };

    streamViewerSessions.set(socket, viewer);
    subscribeStream(viewer, requestedSerial);
  });

  socket.on("close", () => {
    clearTimeout(authTimer);

    const viewer = streamViewerSessions.get(socket);
    streamViewerSessions.delete(socket);

    if (!viewer || !viewer.key) {
      return;
    }

    const activeStreamState = streamStates.get(viewer.key);
    if (!activeStreamState) {
      return;
    }

    activeStreamState.viewers.delete(socket);
    if (activeStreamState.viewers.size > 0) {
      return;
    }

    streamStates.delete(viewer.key);

    const activeAgent = agents.get(viewer.agentId);
    if (activeAgent && activeAgent.socket.readyState === WebSocket.OPEN) {
      activeAgent.socket.send(
        JSON.stringify({ type: "stop-stream", serial: viewer.serial } satisfies StopStreamMessage)
      );
    }
  });
});

// ─────────────────────── 鉴权与访问控制 ───────────────────────

/** 首次鉴权：验证令牌并解析出该账号可操作的设备集合。 */
function authenticateViewer(token: string): { user: UserRecord; serials: Set<string> } | null {
  const session = resolveSession(db, token);
  if (!session) {
    return null;
  }

  const user = findUserById(db, session.userId);
  if (!user || user.status !== "active") {
    return null;
  }

  return { user, serials: allowedSerialsFor(user) };
}

/** 管理员可见全部设备；客户只可见分配给自己的。 */
function allowedSerialsFor(user: UserRecord): Set<string> {
  if (user.role === "admin") {
    return new Set(listDevices().map((device) => device.serial));
  }

  return listSerialsForUser(db, user.id);
}

/**
 * 刷新一个连接的权限缓存。
 *
 * 两条触发路径：
 *   1. **纪元变化**（管理员改了归属或能力）→ 立刻重查
 *   2. 距上次校验超过 60 秒 → 重查会话本身是否仍有效
 *
 * 返回 false 表示该连接已不再可信，调用方应断开它。
 */
function refreshAccess(viewer: ViewerSession): boolean {
  const now = Date.now();

  if (viewer.epoch === getAccessEpoch() && now - viewer.sessionCheckedAt < SESSION_RECHECK_MS) {
    return true;
  }

  const session = resolveSession(db, viewer.token);
  if (!session) {
    return false;
  }

  const user = findUserById(db, session.userId);
  if (!user || user.status !== "active") {
    return false;
  }

  viewer.user = user;
  viewer.serials = allowedSerialsFor(user);
  viewer.epoch = getAccessEpoch();
  viewer.sessionCheckedAt = now;
  return true;
}

/** 构造某个连接**专属**的设备列表——绝不能复用同一份 payload 广播。 */
function serializeDevicesFor(viewer: ViewerSession): string {
  const all = listDevices();
  const visible = hasCapability(viewer.user, "can_view_devices")
    ? all.filter((device) => viewer.serials.has(device.serial))
    : [];

  return JSON.stringify({
    type: "devices",
    devices: visible,
    updatedAt: new Date().toISOString()
  });
}

function rejectViewer(socket: WebSocket, message: string): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "auth-error", message }));
  }
  socket.close();
}

function rejectStream(socket: WebSocket, serial: string, message: string): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "stream-error", serial, message }));
  }
  socket.close();
}

/** 校验通过后把连接挂到对应的流上，必要时向 Agent 发起 start-stream。 */
function subscribeStream(viewer: StreamViewerSession, serial: string): void {
  const socket = viewer.socket;

  if (!serial) {
    rejectStream(socket, serial, "缺少 serial 参数");
    return;
  }

  if (!hasCapability(viewer.user, "can_view_stream")) {
    rejectStream(socket, serial, "当前账号没有查看实时画面的权限");
    return;
  }

  if (!viewer.serials.has(serial)) {
    writeAudit(db, viewer.user.id, "viewer.stream_denied", serial, { reason: "not_owned" });
    rejectStream(socket, serial, "无权查看该设备");
    return;
  }

  const device = listDevices().find((item) => item.serial === serial);
  if (!device) {
    rejectStream(socket, serial, "设备当前不在线");
    return;
  }

  const agent = agents.get(device.agentId);
  if (!agent || agent.socket.readyState !== WebSocket.OPEN) {
    rejectStream(socket, serial, `Agent 未连接: ${device.agentId}`);
    return;
  }

  const key = getStreamKey(device.agentId, serial);
  const streamState = getOrCreateStreamState(key);
  const shouldStart = streamState.viewers.size === 0;

  streamState.viewers.add(socket);

  viewer.agentId = device.agentId;
  viewer.serial = serial;
  viewer.key = key;

  if (shouldStart) {
    agent.socket.send(JSON.stringify({ type: "start-stream", serial } satisfies StartStreamMessage));
  } else {
    replayBootstrapToViewer(socket, device.agentId, streamState);
  }
}

/**
 * 访问控制变更后立刻重校验所有在线连接。
 *
 * 这是「管理页面关掉权限 → 已连接的客户立即失去能力」的落地点。
 * 由 api 层的 onAccessChanged 触发。
 */
function revalidateViewers(): void {
  viewerSessions.forEach((viewer, socket) => {
    if (!refreshAccess(viewer)) {
      rejectViewer(socket, "账号已被禁用或会话已失效");
      return;
    }

    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    // 把最新的权限推给前端，否则页面上的按钮会按登录时的旧权限显示
    socket.send(
      JSON.stringify({
        type: "permissions",
        role: viewer.user.role,
        capabilities: viewer.user.capabilities
      })
    );
    socket.send(serializeDevicesFor(viewer));
  });

  streamViewerSessions.forEach((viewer, socket) => {
    if (!refreshAccess(viewer)) {
      rejectStream(socket, viewer.serial, "账号已被禁用或会话已失效");
      return;
    }

    if (!hasCapability(viewer.user, "can_view_stream") || !viewer.serials.has(viewer.serial)) {
      writeAudit(db, viewer.user.id, "viewer.stream_revoked", viewer.serial, null);
      rejectStream(socket, viewer.serial, "已失去该设备的查看权限");
    }
  });

  console.log(
    `[relay] access revalidated: ${viewerSessions.size} viewer(s), ${streamViewerSessions.size} stream(s)`
  );
}

server.listen(Number.isFinite(port) ? port : 5081, host, () => {
  console.log(`[relay] server ready at http://${host}:${port}`);
  console.log(`[relay] database: ${dbFile}`);
  console.log("[relay] api: /api/auth/*, /api/admin/*, /api/my/devices");
  void bootstrapInitialAdmin();
});

/**
 * 首次启动时创建初始管理员。
 *
 * 密码取自 ADMIN_PASSWORD；未设置则随机生成并在控制台打印一次。
 * 刻意不提供硬编码默认密码——那会进 git，并变成全网皆知的默认口令。
 */
async function bootstrapInitialAdmin(): Promise<void> {
  try {
    const result = await ensureInitialAdmin(db, {
      username: process.env.ADMIN_USERNAME,
      password: process.env.ADMIN_PASSWORD
    });

    const banner = formatBootstrapBanner(result);
    if (banner) {
      console.log(banner);
    }
  } catch (error) {
    console.error(
      `[relay] 初始化管理员失败: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  void handleRequestAsync(req, res);
}

async function handleRequestAsync(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  // 账号系统 API：注册 / 登录 / 管理端。由它先判断是否属于自己处理的路由。
  if (await handleApiRequest(apiContext, req, res)) {
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      agents: agents.size,
      devices: listDevices().length
    });
    return;
  }

  // 全量设备列表含机型、分辨率等信息，属于运维视图，仅管理员可见。
  // 客户要看自己的设备请用 /api/my/devices。
  if (req.method === "GET" && url.pathname === "/api/devices") {
    if (!requireAdmin(apiContext, req, res)) {
      return;
    }

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

/**
 * 把一条消息只发给「拥有该 serial」的连接。
 *
 * 用于 Agent 回报的 input-error：错误信息里含设备号，
 * 广播出去等于把别人的设备号告诉所有人。
 */
function sendToViewersOwning(serial: string, payload: unknown): void {
  const serialized = JSON.stringify(payload);

  viewerSessions.forEach((viewer, socket) => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (viewer.user.role === "admin" || (serial !== "" && viewer.serials.has(serial))) {
      socket.send(serialized);
    }
  });
}

/**
 * 设备列表变化时推送。
 *
 * 关键点：**每个连接各构造一份 payload**。
 * 改造前是「序列化一次、发所有人」，在多租户下等于把全部设备名单广播出去。
 */
function broadcastDevices(): void {
  const all = listDevices();
  const updatedAt = new Date().toISOString();

  viewerSessions.forEach((viewer, socket) => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const visible = hasCapability(viewer.user, "can_view_devices")
      ? all.filter((device) => viewer.serials.has(device.serial))
      : [];

    socket.send(JSON.stringify({ type: "devices", devices: visible, updatedAt }));
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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
