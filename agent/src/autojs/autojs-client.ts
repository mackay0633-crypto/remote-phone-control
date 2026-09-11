import type {
  AutojsAccount,
  AutojsActionResult,
  AutojsRunStatus,
  StartSendVideoInput
} from "./autojs-types.js";
import {
  validateAccounts,
  validateAssignments,
  validateDayilWorkConfig,
  validateDeviceIds,
  validateSendTime,
  validateText,
  validateTitles,
  validateVideoPaths,
  type ValidationResult
} from "./autojs-validation.js";

export type AutojsErrorCode =
  | "validation_failed"
  | "not_activated"
  | "unreachable"
  | "timeout"
  | "invalid_response"
  | "http_error"
  | "task_failed";

export class AutojsError extends Error {
  readonly code: AutojsErrorCode;
  readonly status?: number;

  constructor(message: string, code: AutojsErrorCode, status?: number) {
    super(message);
    this.name = "AutojsError";
    this.code = code;
    this.status = status;
  }
}

export interface AutojsClientOptions {
  /** 例如 http://127.0.0.1:5000 */
  baseUrl: string;
  timeoutMs: number;
}

export interface StartDayilWorkRequest {
  device_ids: unknown;
  config?: unknown;
}

/**
 * autojs-controller 客户端。
 *
 * 设计要点：**所有写操作在发请求之前先过校验层**。
 * 校验放在这里而不是调用方，是为了让「绕过校验」在结构上不可能——
 * 只要走这个客户端，输入就一定被规范化过。
 *
 * 注意：autojs 的响应是全局视图（不含租户信息），
 * 调用方在转发给最终用户前必须自行按设备集过滤。
 */
export class AutojsClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: AutojsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async getHealth(): Promise<{ ok: boolean; port?: number }> {
    return this.request("GET", "/health");
  }

  async getRunStatus(): Promise<AutojsRunStatus> {
    return this.request("GET", "/api/automation/run-status");
  }

  async getAccounts(): Promise<AutojsAccount[]> {
    return this.request("GET", "/api/accounts");
  }

  /** autojs 的 /api/devices 返回的是 serial 字符串数组，不是对象数组。 */
  async getDevices(): Promise<string[]> {
    return this.request("GET", "/api/devices");
  }

  /**
   * 生成并立即运行养号脚本。
   *
   * @param allowedDeviceIds 本次调用允许操作的设备。**必须传入**——
   *   否则用户可以指定任意 serial，配额形同虚设。
   */
  async startDayilWork(input: StartDayilWorkRequest, allowedDeviceIds: Iterable<string>): Promise<AutojsActionResult> {
    const deviceIds = unwrap(validateDeviceIds(input.device_ids, allowedDeviceIds));
    const config = unwrap(validateDayilWorkConfig(input.config));

    return this.request("POST", "/api/automation/dayil-work/start", {
      device_ids: deviceIds,
      config
    });
  }

  /**
   * 生成、下发并立即运行发视频脚本。
   *
   * @param allowedDeviceIds 必传，作用同上
   * @param allowedAccounts  可选；账号系统就绪后传入以实现账号级隔离
   */
  async startSendVideo(
    input: StartSendVideoInput,
    allowedDeviceIds: Iterable<string>,
    allowedAccounts?: Iterable<string>
  ): Promise<AutojsActionResult> {
    const type = input.type === "batch" ? "batch" : "precise";

    const accounts = unwrap(validateAccounts(input.accounts, allowedAccounts));
    const deviceIds = unwrap(validateDeviceIds(input.device_ids, allowedDeviceIds));
    const videoPaths = unwrap(validateVideoPaths(input.video_paths));
    const sendTime = unwrap(validateSendTime(input.send_time));
    const titles = unwrap(validateTitles(input.titles));
    const productName = unwrap(validateText(input.product_name, "product_name"));
    const location = unwrap(validateText(input.location, "location"));
    const assignments = unwrap(validateAssignments(input.assignments));

    if (type === "precise" && accounts.length !== 1) {
      throw new AutojsError("精准模式需且仅需一个账号", "validation_failed");
    }

    // videos 不显式下发：让 autojs 从 video_paths 的 basename 推导，
    // 避免两边名字不一致。basename 已由 validateVideoPaths 保证是规范化结果。
    return this.request("POST", "/api/automation/send-video/start", {
      type,
      accounts,
      device_ids: deviceIds,
      video_paths: videoPaths,
      send_time: sendTime,
      titles,
      product_name: productName,
      location,
      assignments
    });
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;

    try {
      response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new AutojsError(`autojs 请求超时（${this.timeoutMs}ms）：${path}`, "timeout");
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new AutojsError(`无法连接 autojs（${this.baseUrl}）：${message}`, "unreachable");
    }

    const text = await response.text();
    let payload: unknown;

    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new AutojsError(
        `autojs 返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 120)}`,
        "invalid_response",
        response.status
      );
    }

    // autojs 的激活中间件返回 403，且响应体是 {error} 而非 {success:false,error}
    if (response.status === 403) {
      throw new AutojsError("autojs 未激活，请先在这台主机上完成激活", "not_activated", 403);
    }

    if (!response.ok) {
      throw new AutojsError(
        extractError(payload) ?? `autojs 返回 HTTP ${response.status}`,
        "http_error",
        response.status
      );
    }

    const success = (payload as { success?: unknown }).success;
    if (success === false) {
      throw new AutojsError(extractError(payload) ?? "autojs 任务执行失败", "task_failed", response.status);
    }

    return payload as T;
  }
}

function unwrap<T>(result: ValidationResult<T>): T {
  if (!result.ok) {
    throw new AutojsError(result.error, "validation_failed");
  }

  return result.value;
}

function extractError(payload: unknown): string | null {
  if (typeof payload === "object" && payload !== null) {
    const value = (payload as { error?: unknown }).error;
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }

  return null;
}
