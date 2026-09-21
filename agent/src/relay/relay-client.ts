import WebSocket from "ws";
import { AutojsClient, AutojsError } from "../autojs/autojs-client.js";
import { downloadVideo, removeDownloadedVideo, type VideoDownloadConfig } from "../autojs/video-download.js";
import type { DeviceInfo } from "../device/device-types.js";
import { DeviceTracker } from "../device/device-tracker.js";
import { InputManager, type DeviceInputCommand } from "../input/input-manager.js";
import { H264StreamSession } from "../stream/h264-stream-session.js";

interface RelayClientOptions {
  relayServerWsUrl: string;
  agentId: string;
  deviceTracker: DeviceTracker;
  inputManager: InputManager;
  adbPath: string;
  streamMaxSize: number;
  streamBitRate: number;
  /** 未提供时 automation 请求会返回明确错误，而不是静默失败 */
  autojsClient?: AutojsClient;
  /** 未提供时 send-video.start 会返回明确错误 */
  videoDownload?: VideoDownloadConfig;
}

interface ActiveRelayStream {
  session: H264StreamSession;
  serial: string;
}

/** relay 允许转发的自动化动作白名单 —— 与 relay 侧保持一致 */
type AutomationAction = "health" | "run-status" | "accounts" | "dayil-work.start" | "send-video.start";

interface AutomationRequestMessage {
  type: "automation";
  requestId: string;
  action: AutomationAction;
  payload: Record<string, unknown>;
  /** relay 算好的「该账号可操作的设备」；agent 再校验一次作为纵深防御 */
  allowedDeviceIds?: string[];
}

type RelayMessage =
  | {
      type: "start-stream";
      serial: string;
    }
  | {
      type: "stop-stream";
      serial: string;
    }
  | {
      type: "input";
      serial: string;
      command: DeviceInputCommand;
    }
  | AutomationRequestMessage;

export class RelayClient {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private streams = new Map<string, ActiveRelayStream>();
  private readonly unsubscribeTracker: () => void;
  /**
   * `stop()` 之后必须**永久**停止重连。
   *
   * 只 clearTimeout 是不够的：`stop()` 会 close 掉当前 socket，
   * 而 close 处理函数本身会调 scheduleReconnect —— 于是「停止」
   * 反而触发一次重连，连不上又重连，进程永远退不出去
   * （实测表现为 Ctrl+C 后日志疯狂刷 ECONNREFUSED）。
   */
  private stopped = false;

  constructor(private readonly options: RelayClientOptions) {
    this.unsubscribeTracker = this.options.deviceTracker.subscribe((devices) => {
      this.sendJson({
        type: "devices",
        devices
      });
    });
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.unsubscribeTracker();
    this.stopAllStreams();
    this.socket?.close();
    this.socket = undefined;
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }

    const socket = new WebSocket(this.options.relayServerWsUrl);
    this.socket = socket;

    socket.on("open", () => {
      console.log(`[agent] relay connected: ${this.options.relayServerWsUrl}`);
      this.sendJson({
        type: "register-agent",
        agentId: this.options.agentId
      });
      this.sendDevices(this.options.deviceTracker.getDevices());
    });

    socket.on("message", (rawMessage, isBinary) => {
      if (isBinary) {
        return;
      }

      try {
        const payload = JSON.parse(rawMessage.toString()) as RelayMessage;
        void this.handleRelayMessage(payload);
      } catch (error) {
        console.error(`[agent] relay message parse failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
      console.log("[agent] relay disconnected");
      this.stopAllStreams();
      this.scheduleReconnect();
    });

    socket.on("error", (error) => {
      console.error(`[agent] relay socket error: ${error.message}`);
    });
  }

  private scheduleReconnect(): void {
    // 已经 stop() 过就不要再排重连，否则进程永远退不出去
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 1500);
  }

  private async handleRelayMessage(payload: RelayMessage): Promise<void> {
    switch (payload.type) {
      case "start-stream":
        this.startStream(payload.serial);
        return;
      case "stop-stream":
        this.stopStream(payload.serial);
        return;
      case "input":
        try {
          await this.options.inputManager.execute(payload.serial, payload.command);
        } catch (error) {
          this.sendJson({
            type: "input-error",
            serial: payload.serial,
            message: error instanceof Error ? error.message : String(error)
          });
        }
        return;
      case "automation":
        await this.handleAutomation(payload);
        return;
    }
  }

  /**
   * 执行 relay 转来的自动化请求。
   *
   * 这里**不重复做业务校验**——把输入交给 AutojsClient，
   * 它内部会先过 S0 校验层再发请求。本方法只负责：
   *   1. 把 allowedDeviceIds 传给客户端（子集校验的依据）
   *   2. 把结果或错误打包成回执
   *
   * 任何异常都必须变成回执，否则 relay 侧会一直等到超时。
   */
  private async handleAutomation(request: AutomationRequestMessage): Promise<void> {
    const client = this.options.autojsClient;

    if (!client) {
      this.sendAutomationResult(
        request.requestId,
        false,
        undefined,
        "本机未启用 autojs 客户端",
        "autojs_disabled"
      );
      return;
    }

    const allowedDeviceIds = request.allowedDeviceIds ?? [];

    try {
      let data: unknown;

      switch (request.action) {
        case "health":
          data = await client.getHealth();
          break;
        case "run-status":
          data = await client.getRunStatus();
          break;
        case "accounts":
          data = await client.getAccounts();
          break;
        case "dayil-work.start":
          data = await client.startDayilWork(
            {
              device_ids: request.payload.device_ids,
              config: request.payload.config
            },
            allowedDeviceIds
          );
          break;
        case "send-video.start":
          data = await this.runSendVideo(request, allowedDeviceIds);
          break;
        default:
          this.sendAutomationResult(
            request.requestId,
            false,
            undefined,
            `不支持的动作: ${String(request.action)}`,
            "unsupported_action"
          );
          return;
      }

      this.sendAutomationResult(request.requestId, true, data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof AutojsError ? error.code : "unknown";

      console.error(`[agent] automation ${request.action} 失败: ${message}`);
      this.sendAutomationResult(request.requestId, false, undefined, message, code);
    }
  }

  /**
   * 发视频：先把客户上传的文件拉到本机，再把**本地绝对路径**交给 autojs。
   *
   * 为什么必须由主机下载：autojs 靠 `adb push <本地路径> <手机路径>` 工作，
   * 它要的是这台 Windows 主机上的真实文件，而视频原本只存在于客户的浏览器里。
   *
   * 两个安全要点：
   *
   *   1. **只认 video_ids** —— relay 已校验这些 id 属于发起请求的账号。
   *      payload 里若带 `video_paths` 一律**丢弃**，绝不让调用方直接指定
   *      本机路径：否则任何租户都能把主机上任意文件（如配置文件）推到手机上。
   *   2. **落盘名保持 relay 给的 safeName** —— autojs 从 basename 推导视频名，
   *      改名会让多个视频互相覆盖；`validateVideoPaths` 会再断言一次规范形式。
   */
  private async runSendVideo(
    request: AutomationRequestMessage,
    allowedDeviceIds: string[]
  ): Promise<unknown> {
    const client = this.options.autojsClient;
    const download = this.options.videoDownload;

    if (!client) {
      throw new Error("本机未启用 autojs 客户端");
    }

    if (!download || !download.relayHttpBaseUrl) {
      throw new Error("本机未配置 RELAY_SERVER_WS_URL / AGENT_SECRET，无法从服务器下载视频");
    }

    const videoIds = parseVideoIds(request.payload.video_ids);
    if (videoIds.length === 0) {
      throw new Error("video_ids 不能为空：请先在「发视频」里上传并选择视频");
    }

    // 下载可能耗时数分钟（视频经公网过来），逐个来以免打满带宽
    const localPaths: string[] = [];
    const localNames = new Set<string>();
    for (const videoId of videoIds) {
      const downloaded = await downloadVideo(download, videoId);
      localPaths.push(downloaded.localPath);
      localNames.add(downloaded.safeName);
      console.log(`[agent] video ${videoId} -> ${downloaded.localPath} (${downloaded.sizeBytes} bytes)`);
    }

    // 用下载得到的路径**覆盖**调用方可能传来的 video_paths
    const payload: Record<string, unknown> = { ...request.payload, video_paths: localPaths };
    delete payload.video_ids;

    // 批量模式的 assignments 用文件名指向视频。指向一个没下载的文件
    // 说明请求是拼出来的（界面上选不出这种组合），这里先挡掉，
    // 否则错误会以 autojs 内部「找不到视频」的形式出现，很难定位。
    const assignments = Array.isArray(payload.assignments) ? payload.assignments : [];
    for (const item of assignments) {
      const name = isPlainRecord(item) && typeof item.video === "string" ? item.video : "";
      if (name && !localNames.has(name)) {
        throw new Error(`assignments 引用了本次未下发的视频：${name}`);
      }
    }

    const allowedAccounts = await this.resolveAllowedAccounts(client, allowedDeviceIds);

    const result = await client.startSendVideo(
      payload as unknown as Parameters<AutojsClient["startSendVideo"]>[0],
      allowedDeviceIds,
      allowedAccounts
    );

    // 派发成功后删掉本机副本。
    //
    // 为什么不留着当缓存：`downloadVideo` 每次都会重新下载并覆盖，**没有**
    // 「文件已存在就跳过」的判断，所以本地这份没有任何复用价值 —— 留着只会让
    // MEDIA_DIR 按 videoId 无限增长（一台主机上会堆着所有客户发过的素材）。
    //
    // 失败时**保留**：那种情况需要对着文件排查，而且反正下次也会重新下载。
    // 历史遗留的副本用 scripts\clean-agent-media.ps1 按时间/容量清。
    await this.removeLocalCopies(download, videoIds);

    return result;
  }

  /** 清理本机视频副本；失败只记日志，不影响「任务已经下发成功」这个事实 */
  private async removeLocalCopies(config: VideoDownloadConfig, videoIds: string[]): Promise<void> {
    for (const videoId of videoIds) {
      try {
        await removeDownloadedVideo(config, videoId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[agent] 清理本机视频副本失败（${videoId}）: ${detail}`);
      }
    }

    console.log(`[agent] 已清理本机视频副本 ${videoIds.length} 个`);
  }

  /**
   * 算出这次请求允许使用的账号名。
   *
   * 为什么需要：autojs 的账号名会成为手机上的远程目录名，而**多租户共用
   * 一台主机**。relay 只校验了设备归属，账号名是调用方给的字符串——
   * 手工构造一条 WS 消息就能指定别人设备上的账号。
   *
   * 这里从 autojs 取回账号表，只放行「属于本次允许设备」以及
   * 「没有归属设备」的账号。刻意**不**放行绑定在其它设备上的账号。
   *
   * 返回 undefined 表示不施加账号过滤，只在拿不到账号表时发生：
   * 此时宁可保留功能可用（后续 autojs 自己会因账号不存在而报错），
   * 也不因为一个探询接口抖动就让所有客户发不出视频。日志里会写清楚。
   */
  private async resolveAllowedAccounts(
    client: AutojsClient,
    allowedDeviceIds: string[]
  ): Promise<string[] | undefined> {
    let accounts: Awaited<ReturnType<AutojsClient["getAccounts"]>>;

    try {
      accounts = await client.getAccounts();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[agent] 无法获取账号表，本次不施加账号过滤: ${message}`);
      return undefined;
    }

    if (!Array.isArray(accounts) || accounts.length === 0) {
      console.warn("[agent] autojs 未返回任何账号，本次不施加账号过滤");
      return undefined;
    }

    const allowed = new Set(allowedDeviceIds);
    const names = accounts
      .filter((account) => {
        if (!account || typeof account.username !== "string" || account.username === "") {
          return false;
        }

        const deviceId = account.device_id;
        // 没有归属设备的账号无法判断归属，放行（真机上通常为空，
        // 若在这里拦掉会让「发视频」在多数部署下直接不可用）
        return typeof deviceId !== "string" || deviceId === "" || allowed.has(deviceId);
      })
      .map((account) => account.username);

    if (names.length === 0) {
      console.warn(
        `[agent] 允许设备 ${allowedDeviceIds.join(", ")} 下没有任何账号，本次不施加账号过滤`
      );
      return undefined;
    }

    return names;
  }

  private sendAutomationResult(
    requestId: string,
    ok: boolean,
    data?: unknown,
    error?: string,
    code?: string
  ): void {
    this.sendJson({ type: "automation-result", requestId, ok, data, error, code });
  }

  private startStream(serial: string): void {
    if (this.streams.has(serial)) {
      return;
    }

    const device = this.options.deviceTracker.getDevice(serial);
    if (!device) {
      this.sendJson({
        type: "stream-error",
        serial,
        message: `Device not found: ${serial}`
      });
      return;
    }

    const session = new H264StreamSession({
      adbPath: this.options.adbPath,
      serial,
      maxSize: this.options.streamMaxSize,
      bitRate: this.options.streamBitRate,
      width: device.width,
      height: device.height
    });

    session.onData((chunk) => {
      this.sendStreamChunk(serial, chunk);
    });

    session.onError((payload) => {
      this.sendJson({
        type: "stream-log",
        serial,
        message: String(payload)
      });
    });

    session.onClose(() => {
      this.sendJson({
        type: "stream-log",
        serial,
        message: "stream restarted"
      });
    });

    session.start();
    this.streams.set(serial, { serial, session });

    this.sendJson({
      type: "stream-ready",
      serial,
      width: device.width,
      height: device.height
    });

    console.log(`[agent] relay stream started for ${serial}`);
  }

  private stopStream(serial: string): void {
    const active = this.streams.get(serial);
    if (!active) {
      return;
    }

    active.session.stop();
    this.streams.delete(serial);
    console.log(`[agent] relay stream stopped for ${serial}`);
  }

  private stopAllStreams(): void {
    this.streams.forEach((active) => {
      active.session.stop();
    });
    this.streams.clear();
  }

  private sendDevices(devices: DeviceInfo[]): void {
    this.sendJson({
      type: "devices",
      devices
    });
  }

  private sendJson(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(payload));
  }

  private sendStreamChunk(serial: string, chunk: Buffer): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const serialBuffer = Buffer.from(serial, "utf8");
    const header = Buffer.alloc(2);
    header.writeUInt16BE(serialBuffer.length, 0);
    this.socket.send(Buffer.concat([header, serialBuffer, chunk]));
  }
}

/**
 * 解析并去重 video_ids。
 *
 * 只接受 relay 生成的 32 位十六进制 id —— 这个 id 会直接拼进下载 URL，
 * 宽松的格式检查等于把 URL 交给调用方拼接。
 */
function parseVideoIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const result: string[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }

    const id = item.trim().toLowerCase();
    if (/^[a-f0-9]{32}$/.test(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }

  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
