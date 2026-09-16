import { API_BASE_URL, ApiError } from "./client";
import { getToken } from "./session";

/**
 * 视频素材的 HTTP 通道。
 *
 * 上传刻意**不用 multipart**：请求体就是文件的原始字节，文件名放在查询参数里。
 * 见 relay 的 `handleVideoUpload`——这样服务端可以直接把请求流边写盘边算 sha256，
 * 不必先把整个视频读进内存（几百 MB 的视频在服务器上会直接打爆内存）。
 */
export interface RemoteVideo {
  id: string;
  /** 规范化后的文件名。**下发时用的是它**：autojs 从 basename 推导视频名 */
  name: string;
  originalName: string;
  sizeBytes: number;
  createdAt: string;
}

export interface VideoLibrary {
  videos: RemoteVideo[];
  usedBytes: number;
  quotaBytes: number;
}

interface UploadResponse {
  video: RemoteVideo;
  usedBytes: number;
  quotaBytes: number;
}

/** 单次上传超时给到 30 分钟：视频动辄几百 MB，公网慢的时候很常见。 */
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

export async function fetchVideos(): Promise<VideoLibrary> {
  return http<VideoLibrary>("GET", "/api/videos");
}

export function deleteVideo(videoId: string): Promise<{ ok: boolean; usedBytes: number }> {
  return http<{ ok: boolean; usedBytes: number }>("DELETE", `/api/videos/${videoId}`);
}

/**
 * 上传视频。
 *
 * 用 XMLHttpRequest 而不是 fetch，唯一原因是**上传进度**：
 * fetch 至今没有请求体进度事件，而客户传 300 MB 的视频时没有进度条
 * 会被当成卡死。
 */
export function uploadVideo(
  file: File,
  onProgress?: (sent: number, total: number) => void
): Promise<UploadResponse> {
  return new Promise<UploadResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // encodeURIComponent 兜住中文名与空格；服务端会再规范化一次
    xhr.open("POST", `${API_BASE_URL}/api/videos?name=${encodeURIComponent(file.name)}`, true);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Accept", "application/json");

    const token = getToken();
    if (token) {
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    }

    xhr.timeout = UPLOAD_TIMEOUT_MS;

    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress(event.loaded, event.total);
        }
      };
    }

    xhr.onload = () => {
      const payload = parseJson(xhr.responseText);

      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new ApiError(errorMessage(payload, xhr.status), xhr.status));
        return;
      }

      if (!payload) {
        reject(new ApiError("服务器返回了无法解析的响应", xhr.status));
        return;
      }

      resolve(payload as unknown as UploadResponse);
    };

    xhr.onerror = () => reject(new ApiError("上传失败：网络错误", 0));
    xhr.ontimeout = () => reject(new ApiError("上传超时，请检查网络后重试", 0));
    xhr.onabort = () => reject(new ApiError("上传已取消", 0));

    xhr.send(file);
  });
}

async function http<T>(method: string, path: string): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(API_BASE_URL + path, { method, headers });
  } catch (error) {
    throw new ApiError(`无法连接服务器：${error instanceof Error ? error.message : String(error)}`, 0);
  }

  const text = await response.text();
  const payload = parseJson(text);

  if (!response.ok) {
    throw new ApiError(errorMessage(payload, response.status), response.status);
  }

  return payload as T;
}

function parseJson(text: string): Record<string, unknown> | null {
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function errorMessage(payload: Record<string, unknown> | null, status: number): string {
  const message = payload?.error;
  return typeof message === "string" && message ? message : `请求失败（HTTP ${status}）`;
}

export function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}
