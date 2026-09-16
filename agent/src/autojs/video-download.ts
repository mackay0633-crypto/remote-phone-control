import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface VideoDownloadConfig {
  /** relay 的 HTTP 基址，例如 http://1.2.3.4:5081 */
  relayHttpBaseUrl: string;
  /** 与 relay 侧 AGENT_SECRET 一致 */
  agentSecret: string;
  /** 本地暂存根目录 */
  mediaDir: string;
}

export interface DownloadedVideo {
  videoId: string;
  /** 交给 autojs 的本地绝对路径 */
  localPath: string;
  safeName: string;
  sizeBytes: number;
}

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 把客户上传的视频从 relay 拉到本机。
 *
 * 为什么要中转：autojs 需要的是**设备主机上的本地绝对路径**
 * （它要 `adb push` 到手机），而视频在客户的浏览器里。
 * 服务器存一份，主机主动拉下来，再把本地路径交给 autojs。
 *
 * 落盘路径刻意做成 `<mediaDir>/<videoId>/<safeName>`：
 *   - 目录用 videoId 保证唯一
 *   - 文件名保持 relay 给的 safeName，**因为 autojs 从 basename
 *     推导视频名并写进脚本**，改名会让多个视频退化成同一个名字
 *
 * 下载后校验 sha256，不一致就丢弃——避免把半截文件推上手机。
 */
export async function downloadVideo(
  config: VideoDownloadConfig,
  videoId: string
): Promise<DownloadedVideo> {
  if (!config.agentSecret) {
    throw new Error("agent 未配置 AGENT_SECRET，无法下载视频");
  }

  if (!/^[a-f0-9]{32}$/.test(videoId)) {
    throw new Error(`videoId 格式不合法: ${videoId}`);
  }

  const url = `${config.relayHttpBaseUrl}/api/agent/videos/${videoId}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.agentSecret}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(
      `无法连接服务器下载视频：${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!response.ok) {
    throw new Error(`下载视频失败：${await describeFailure(response)}`);
  }

  if (!response.body) {
    throw new Error("下载视频失败：响应没有内容");
  }

  const encodedName = response.headers.get("x-video-name") ?? "";
  let safeName = "";
  try {
    safeName = decodeURIComponent(encodedName);
  } catch {
    safeName = "";
  }

  if (!safeName) {
    throw new Error("响应缺少 X-Video-Name，无法确定本地文件名");
  }

  // 再挡一次路径穿越：safeName 来自服务端，但本地落盘不该赌它
  if (safeName.includes("/") || safeName.includes("\\") || safeName.startsWith(".")) {
    throw new Error(`服务端返回的文件名不安全: ${safeName}`);
  }

  const expectedSha = response.headers.get("x-video-sha256") ?? "";
  const targetDir = resolve(config.mediaDir, videoId);
  const targetPath = join(targetDir, safeName);

  await mkdir(targetDir, { recursive: true });

  const hash = createHash("sha256");
  let sizeBytes = 0;

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    }
  });

  try {
    await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(targetPath));
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true });
    throw new Error(`写入视频文件失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const actualSha = hash.digest("hex");

  if (expectedSha && actualSha !== expectedSha) {
    await rm(targetDir, { recursive: true, force: true });
    throw new Error("视频校验失败（sha256 不一致），已丢弃");
  }

  return { videoId, localPath: targetPath, safeName, sizeBytes };
}

/** 删除某个视频的本地暂存目录 */
export async function removeDownloadedVideo(config: VideoDownloadConfig, videoId: string): Promise<void> {
  await rm(resolve(config.mediaDir, videoId), { recursive: true, force: true });
}

async function describeFailure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) {
      return body.error;
    }
  } catch {
    // 非 JSON 响应，退回状态码
  }

  return `HTTP ${response.status}`;
}
