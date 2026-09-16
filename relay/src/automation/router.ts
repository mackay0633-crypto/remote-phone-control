import type { WebSocket } from "ws";
import type { Database } from "../db/database.js";
import { hasCapability, type UserRecord } from "../auth/users.js";
import type { Capability } from "../auth/capabilities.js";
import { writeAudit } from "../db/audit.js";
import { getVideo } from "../videos/store.js";

/**
 * 前端可发起的自动化动作。
 *
 * 这份清单是**白名单**：relay 只转发列在这里的动作，
 * 不会把 agent 的任意接口暴露给浏览器。
 */
export const AUTOMATION_ACTIONS = [
  "health",
  "run-status",
  "accounts",
  "dayil-work.start",
  "send-video.start"
] as const;

export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];

/** 每个动作要求的能力 */
const ACTION_CAPABILITY: Record<AutomationAction, Capability> = {
  health: "can_view_devices",
  "run-status": "can_view_devices",
  accounts: "can_view_devices",
  "dayil-work.start": "can_run_dayil",
  "send-video.start": "can_send_video"
};

/** 需要显式指定目标设备的动作 */
const DEVICE_SCOPED_ACTIONS = new Set<AutomationAction>(["dayil-work.start", "send-video.start"]);

/** 结果需要按设备集过滤的动作 —— autojs 返回的是全局视图 */
const FILTERED_ACTIONS = new Set<AutomationAction>(["run-status", "accounts"]);

const MAX_REQUEST_ID_LENGTH = 64;
/** 兜底超时：发视频含 adb push，可能跑好几分钟 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface AutomationViewer {
  socket: WebSocket;
  user: UserRecord;
  /** 该账号可操作的设备 serial 集合 */
  serials: Set<string>;
}

export interface AutomationContext {
  db: Database;
  /** 把消息发给指定 agent；返回 false 表示 agent 未连接 */
  sendToAgent: (agentId: string, message: unknown) => boolean;
  /** 按 serial 反查它属于哪个在线 agent */
  resolveAgentId: (serial: string) => string | undefined;
  /** 当前任选一个在线的 agent（供没有设备的只读查询兜底） */
  anyOnlineAgentId: () => string | undefined;
  timeoutMs?: number;
}

interface PendingRequest {
  requestId: string;
  action: AutomationAction;
  viewer: AutomationViewer;
  timer: NodeJS.Timeout;
}

export type RequestOutcome = { ok: true } | { ok: false; error: string };

/**
 * 自动化请求的路由器。
 *
 * 负责三件事，每一件都是安全边界：
 *
 *   1. **鉴权** —— 动作必须在白名单里，且账号具备对应能力
 *   2. **归属校验** —— 目标设备必须属于该账号（否则客户能操作别人的手机）
 *   3. **结果过滤** —— autojs 返回的是**全局视图**（含他人的账号与任务），
 *      直接转发等于泄露。这里按账号的设备集裁掉不属于他的部分
 *
 * 请求与响应用 requestId 关联，且响应**只回给发起的那条连接**，
 * 不做广播（广播会让多用户互相看到对方的结果）。
 */
export class AutomationRouter {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly timeoutMs: number;
  private readonly ctx: AutomationContext;

  /**
   * 刻意**不用参数属性**（`constructor(private readonly ctx: ...)`）。
   *
   * Node 的类型擦除模式（`--experimental-strip-types`）只能删除类型，
   * 不能生成代码，而参数属性需要额外生成 `this.ctx = ctx` 赋值，
   * 因此在那种模式下会直接报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
   * 写成显式赋值后，tsx 和 Node 原生两种跑法都支持。
   */
  constructor(ctx: AutomationContext) {
    this.ctx = ctx;
    this.timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 处理浏览器发来的自动化请求。 */
  handleRequest(viewer: AutomationViewer, raw: Record<string, unknown>): RequestOutcome {
    const requestId = typeof raw.requestId === "string" ? raw.requestId.trim() : "";
    if (!requestId || requestId.length > MAX_REQUEST_ID_LENGTH) {
      return { ok: false, error: "requestId 无效" };
    }

    const action = raw.action;
    if (typeof action !== "string" || !isKnownAction(action)) {
      return { ok: false, error: `不支持的动作: ${String(action)}` };
    }

    const requiredCapability = ACTION_CAPABILITY[action];
    if (!hasCapability(viewer.user, requiredCapability)) {
      writeAudit(this.ctx.db, viewer.user.id, "automation.denied", action, {
        reason: "missing_capability",
        requiredCapability
      });
      return { ok: false, error: "当前账号没有该操作权限" };
    }

    const payload = isPlainObject(raw.payload) ? raw.payload : {};

    // 发视频要先确认视频确实属于这个账号，并把「本地路径」这个字段摘掉
    if (action === "send-video.start") {
      const ownership = this.checkVideoOwnership(viewer, payload);
      if (!ownership.ok) {
        return ownership;
      }
      payload.video_ids = ownership.videoIds;
      // 关键：video_paths 是**设备主机上的绝对路径**。
      // 若允许调用方自带，任何租户都能把主机上的任意文件推到手机里。
      // 路径只能由 agent 自己下载后生成。
      delete payload.video_paths;
    }

    // ── 归属校验 + 决定发给哪个 agent ────────────────────────
    let agentId: string | undefined;
    let allowedDeviceIds: string[] | undefined;

    if (DEVICE_SCOPED_ACTIONS.has(action)) {
      const requested = Array.isArray(payload.device_ids) ? payload.device_ids : [];
      if (requested.length === 0) {
        return { ok: false, error: "device_ids 不能为空" };
      }

      const forbidden = requested.filter(
        (serial) => typeof serial !== "string" || !viewer.serials.has(serial)
      );
      if (forbidden.length > 0) {
        writeAudit(this.ctx.db, viewer.user.id, "automation.denied", action, {
          reason: "not_owned",
          forbidden
        });
        return { ok: false, error: `无权操作以下设备：${forbidden.join(", ")}` };
      }

      allowedDeviceIds = requested as string[];
      agentId = this.ctx.resolveAgentId(allowedDeviceIds[0]);
      if (!agentId) {
        return { ok: false, error: "目标设备当前不在线" };
      }
    } else {
      // 只读查询：优先用账号自己设备所属的 agent，管理员则任选一个在线的
      for (const serial of viewer.serials) {
        const resolved = this.ctx.resolveAgentId(serial);
        if (resolved) {
          agentId = resolved;
          break;
        }
      }
      agentId = agentId ?? this.ctx.anyOnlineAgentId();
      if (!agentId) {
        return { ok: false, error: "没有在线的设备主机" };
      }
    }

    // ── 转发给 agent ────────────────────────────────────────
    const forwarded = this.ctx.sendToAgent(agentId, {
      type: "automation",
      requestId,
      action,
      payload: allowedDeviceIds ? { ...payload, device_ids: allowedDeviceIds } : payload,
      // 纵深防御：agent 会再校验一次请求的设备是否在这个集合内
      allowedDeviceIds: allowedDeviceIds ?? [...viewer.serials]
    });

    if (!forwarded) {
      return { ok: false, error: "设备主机未连接" };
    }

    this.track({ requestId, action, viewer });
    return { ok: true };
  }

  /** 处理 agent 回来的结果。 */
  handleResult(
    requestId: string,
    ok: boolean,
    data: unknown,
    error?: string,
    code?: string
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }

    this.pending.delete(requestId);
    clearTimeout(pending.timer);

    const { socket } = pending.viewer;
    if (socket.readyState !== 1) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: "automation-result",
        requestId,
        action: pending.action,
        ok,
        // 关键：按发起者的设备集裁剪，autojs 返回的是全局视图
        data: ok ? this.filterForViewer(pending.action, data, pending.viewer) : undefined,
        error: ok ? undefined : error ?? "执行失败",
        code: ok ? undefined : code
      })
    );
  }

  /** agent 断开时，把它名下所有在途请求失败掉，避免前端一直转圈。 */
  failAllForViewer(viewer: AutomationViewer, reason: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.viewer !== viewer) {
        continue;
      }

      this.pending.delete(requestId);
      clearTimeout(pending.timer);

      if (viewer.socket.readyState === 1) {
        viewer.socket.send(
          JSON.stringify({
            type: "automation-result",
            requestId,
            action: pending.action,
            ok: false,
            error: reason
          })
        );
      }
    }
  }

  stop(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
    }
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * 校验发视频请求里的 video_ids。
   *
   * 视频与账号一样是「谁的资源」：不查归属的话，客户 A 只要猜到
   * 客户 B 的 videoId（或遍历 id）就能把别人的素材发到自己手机上。
   * 管理员不受限，便于排障。
   */
  private checkVideoOwnership(
    viewer: AutomationViewer,
    payload: Record<string, unknown>
  ): { ok: true; videoIds: string[] } | { ok: false; error: string } {
    const requested = Array.isArray(payload.video_ids) ? payload.video_ids : [];
    if (requested.length === 0) {
      return { ok: false, error: "video_ids 不能为空" };
    }

    const isAdmin = viewer.user.role === "admin";
    const videoIds: string[] = [];
    const names = new Set<string>();
    const seen = new Set<string>();

    for (const item of requested) {
      const id = typeof item === "string" ? item.trim().toLowerCase() : "";
      if (!/^[a-f0-9]{32}$/.test(id)) {
        return { ok: false, error: `video_ids 中存在非法 id：${String(item)}` };
      }

      if (seen.has(id)) {
        continue;
      }
      seen.add(id);

      const video = getVideo(this.ctx.db, id);
      if (!video || (!isAdmin && video.userId !== viewer.user.id)) {
        writeAudit(this.ctx.db, viewer.user.id, "automation.denied", "send-video.start", {
          reason: "video_not_owned",
          videoId: id
        });
        return { ok: false, error: "所选视频不存在或不属于当前账号" };
      }

      // 同名视频必须挡掉：autojs 用 basename 当视频标识，
      // 两个同名文件在手机上会退化成同一个，结果与预期不符且极难排查。
      if (names.has(video.safeName)) {
        return { ok: false, error: `所选视频存在同名文件（${video.safeName}），请重命名后再上传` };
      }
      names.add(video.safeName);

      videoIds.push(id);
    }

    return { ok: true, videoIds };
  }

  private track(params: { requestId: string; action: AutomationAction; viewer: AutomationViewer }): void {
    // 同 id 重复提交：把旧的清掉，避免泄漏
    const existing = this.pending.get(params.requestId);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      const pending = this.pending.get(params.requestId);
      if (!pending) {
        return;
      }
      this.pending.delete(params.requestId);
      this.handleResult(params.requestId, false, undefined, "设备主机响应超时");
    }, this.timeoutMs);

    this.pending.set(params.requestId, { ...params, timer });
  }

  /**
   * 按账号的设备集裁剪结果。
   *
   * `run-status` 的 entries 带 `deviceId`，`accounts` 带 `device_id`，
   * 两者都能和设备集对上；管理员不过滤。
   */
  private filterForViewer(action: AutomationAction, data: unknown, viewer: AutomationViewer): unknown {
    if (!FILTERED_ACTIONS.has(action) || viewer.user.role === "admin") {
      return data;
    }

    const serials = viewer.serials;

    if (action === "run-status" && isPlainObject(data)) {
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const visible = entries.filter(
        (entry) => isPlainObject(entry) && typeof entry.deviceId === "string" && serials.has(entry.deviceId)
      );

      return {
        ...data,
        entries: visible,
        // 顶层计数字段也一并收窄，否则客户会看到「有 5 个任务」却只列出 2 个
        taskCount: visible.length,
        deviceCount: new Set(visible.map((entry) => (entry as { deviceId: string }).deviceId)).size
      };
    }

    if (action === "accounts" && Array.isArray(data)) {
      return data.filter(
        (account) =>
          isPlainObject(account) &&
          typeof account.device_id === "string" &&
          serials.has(account.device_id)
      );
    }

    return data;
  }
}

function isKnownAction(value: string): value is AutomationAction {
  return (AUTOMATION_ACTIONS as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
