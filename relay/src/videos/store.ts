import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nowIso, type Database } from "../db/database.js";

/**
 * 视频文件名规范化。
 *
 * ⚠️ **必须与 `agent/src/autojs/autojs-validation.ts` 的 `sanitizeVideoFilename`
 * 保持完全一致。**
 *
 * 两处都要有这份逻辑的原因：
 *   - relay 用它决定磁盘上的文件名，并把 safe_name 告诉 agent
 *   - agent 用它做纵深防御：`validateVideoPaths` 会断言
 *     `sanitizeVideoFilename(basename) === basename`，不一致就拒绝下发
 *
 * 规则一旦分叉，agent 会以「文件名未经规范化」为由拒掉所有下发，
 * 所以改这里必须同步改那边。
 */
export const ALLOWED_VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v"] as const;
export const MAX_FILENAME_LENGTH = 80;

export function sanitizeVideoFilename(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }

  // 只取 basename，切断 ../../ 之类的路径穿越（兼容 / 与 \）
  const base = raw.split(/[\\/]/).pop() ?? "";

  const dotIndex = base.lastIndexOf(".");
  const extension = dotIndex > 0 ? base.slice(dotIndex).toLowerCase() : "";
  const stem = dotIndex > 0 ? base.slice(0, dotIndex) : base;

  if (!(ALLOWED_VIDEO_EXTENSIONS as readonly string[]).includes(extension)) {
    return null;
  }

  // 保留 Unicode 字母数字：否则「我的视频.mp4」会退化成「video.mp4」，
  // 多个中文名在同一账号下会得到相同远程路径而互相覆盖
  const normalized = stem
    .replace(/[^\p{L}\p{N}._-]/gu, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "");

  if (!normalized) {
    return null;
  }

  const maxStemLength = MAX_FILENAME_LENGTH - extension.length;
  const codePoints = [...normalized];
  const truncated = codePoints.length > maxStemLength
    ? codePoints.slice(0, maxStemLength).join("").replace(/[._-]+$/, "") || "video"
    : normalized;

  return `${truncated}${extension}`;
}

// ────────────────────────── 磁盘布局 ──────────────────────────

/**
 * 每个视频**一个独立目录**，目录内保留原始文件名。
 *
 * 不直接把文件平铺成 `<videoId>.mp4` 的原因：autojs 从 `video_paths`
 * 的 basename 推导视频名并写进脚本，名字必须保持可读且唯一。
 */
export function mediaRoot(): string {
  return resolve(process.env.RELAY_MEDIA_DIR?.trim() || "data/videos");
}

export function videoDir(videoId: string): string {
  return join(mediaRoot(), videoId);
}

export function videoFilePath(videoId: string, safeName: string): string {
  // safeName 已过白名单，这里再挡一次目录穿越
  const safe = safeName.replace(/[\\/]/g, "_");
  return join(videoDir(videoId), safe);
}

/** 单文件上限，默认 512 MB（与 nginx 的 client_max_body_size 对齐） */
export function maxVideoBytes(): number {
  const value = Number(process.env.VIDEO_MAX_BYTES ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 512 * 1024 * 1024;
}

export interface StoredFileInfo {
  sizeBytes: number;
  sha256: string;
}

/**
 * 把上传流写到磁盘，同时算大小与 sha256。
 *
 * 边写边校验大小：超过上限立即中断并清掉半截文件，
 * 避免客户用一个超大文件把磁盘写满。
 */
export async function writeVideoFile(
  videoId: string,
  safeName: string,
  source: Readable,
  maxBytes: number
): Promise<StoredFileInfo> {
  const dir = videoDir(videoId);
  await mkdir(dir, { recursive: true });

  const target = videoFilePath(videoId, safeName);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let tooLarge = false;

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;

      if (sizeBytes > maxBytes) {
        tooLarge = true;
        callback(new Error(`视频超过上限 ${Math.round(maxBytes / 1024 / 1024)} MB`));
        return;
      }

      hash.update(chunk);
      callback(null, chunk);
    }
  });

  try {
    await pipeline(source, meter, createWriteStream(target));
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  if (tooLarge) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`视频超过上限 ${Math.round(maxBytes / 1024 / 1024)} MB`);
  }

  if (sizeBytes === 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error("上传内容为空");
  }

  return { sizeBytes, sha256: hash.digest("hex") };
}

export async function removeVideoFile(videoId: string): Promise<void> {
  await rm(videoDir(videoId), { recursive: true, force: true });
}

export async function videoFileExists(videoId: string, safeName: string): Promise<boolean> {
  try {
    const info = await stat(videoFilePath(videoId, safeName));
    return info.isFile();
  } catch {
    return false;
  }
}

// ────────────────────────── 数据库 ──────────────────────────

export interface VideoRecord {
  id: string;
  userId: number;
  originalName: string;
  safeName: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

interface VideoRow {
  id: string;
  user_id: number | bigint;
  original_name: string;
  safe_name: string;
  size_bytes: number | bigint;
  sha256: string;
  created_at: string;
}

const SELECT_COLUMNS = "id, user_id, original_name, safe_name, size_bytes, sha256, created_at";

function rowToVideo(row: VideoRow): VideoRecord {
  return {
    id: row.id,
    userId: Number(row.user_id),
    originalName: row.original_name,
    safeName: row.safe_name,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    createdAt: row.created_at
  };
}

export function newVideoId(): string {
  return randomBytes(16).toString("hex");
}

export function createVideo(
  db: Database,
  input: { id: string; userId: number; originalName: string; safeName: string; sizeBytes: number; sha256: string }
): VideoRecord {
  db.prepare(
    `INSERT INTO videos(id, user_id, original_name, safe_name, size_bytes, sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.userId,
    input.originalName,
    input.safeName,
    input.sizeBytes,
    input.sha256,
    nowIso()
  );

  const created = getVideo(db, input.id);
  if (!created) {
    throw new Error("创建视频记录后无法读回");
  }

  return created;
}

export function getVideo(db: Database, id: string): VideoRecord | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM videos WHERE id = ?`).get(id) as
    | VideoRow
    | undefined;

  return row ? rowToVideo(row) : null;
}

export function listVideosForUser(db: Database, userId: number): VideoRecord[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM videos WHERE user_id = ? ORDER BY created_at DESC`)
    .all(userId) as unknown as VideoRow[];

  return rows.map(rowToVideo);
}

export function deleteVideo(db: Database, id: string): boolean {
  const result = db.prepare("DELETE FROM videos WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

/** 某账号已占用的存储字节数——`max_storage_bytes` 配额靠它执行 */
export function totalBytesForUser(db: Database, userId: number): number {
  const row = db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS n FROM videos WHERE user_id = ?").get(userId) as {
    n: number | bigint;
  };

  return Number(row.n);
}
