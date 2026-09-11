/**
 * autojs 输入校验层（S0）。
 *
 * ── 为什么必须有这一层 ────────────────────────────────────────
 *
 * autojs-controller 会把调用方传入的字符串做两件危险的事：
 *
 * 1. **拼进生成的 AutoJS 脚本**（scripts_renderer/buildsendVedio.js）
 *    模板里是 `let SCHEDULED_TIME = "{{SCHEDULED_TIME}}";`，
 *    而 builder 对 send_time 没有做任何转义。
 *    传入 `"; <任意 JS>; //` 就能闭合字符串，在手机上执行任意代码。
 *
 * 2. **拼进 adb 命令行**（server.js 的 pushFileAsync / ensureRemoteDirectoryAsync）
 *    `exec(\`... push "${localPath}" "${remotePath}"\`)`，
 *    其中 remotePath 含视频文件名。Windows 上经由 cmd.exe，
 *    文件名里出现 `"` 即可跳出引号并注入 `&`、`|` 等命令分隔符。
 *
 * 这两条与租户数量无关，只与「输入来自不可信的人」有关。
 * 校验放在这一层（信任边界）实现，autojs-controller 无需任何改动。
 *
 * ── 设计原则 ─────────────────────────────────────────────────
 *
 * - **自动规范化而非拒绝**：文件名做字符白名单替换，用户无感；
 *   只有语义上无法挽救的输入（如非法时间格式）才报错。
 * - **保留 Unicode 字母数字**：中文文件名得以保留，避免所有中文名
 *   都被压成同一个名字而在手机端互相覆盖。
 * - 纯函数、无副作用，便于单测。
 */

export interface ValidationOk<T> {
  ok: true;
  value: T;
}

export interface ValidationErr {
  ok: false;
  error: string;
}

export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

function ok<T>(value: T): ValidationOk<T> {
  return { ok: true, value };
}

function err(error: string): ValidationErr {
  return { ok: false, error };
}

/** 视频文件名长度上限（按码点计）。 */
export const MAX_FILENAME_LENGTH = 80;
/** 标题单条长度上限。 */
export const MAX_TITLE_LENGTH = 200;
/** 标题条数上限。 */
export const MAX_TITLE_COUNT = 20;
/** 文本字段（商品名 / 定位）长度上限。 */
export const MAX_TEXT_LENGTH = 200;
/** 单次任务可操作的账号数上限。 */
export const MAX_ACCOUNT_COUNT = 50;

export const ALLOWED_VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v"] as const;

/**
 * 校验计划发布时间。
 *
 * 接受的格式（与 API_AUTOMATION.md 的示例一致）：
 *   YYYY-MM-DD HH:MM
 *   YYYY-MM-DD HH:MM:SS
 *   YYYY-MM-DDTHH:MM
 *   YYYY-MM-DDTHH:MM:SS
 *
 * 注意：**只校验，不做格式转换**。autojs 的脚本按 `YYYY-MM-DD HH:MM:SS`
 * 解析，擅自把 T 换成空格有可能改变其行为，因此原样透传。
 *
 * 空值合法（表示不指定时间）。
 */
export function validateSendTime(raw: unknown): ValidationResult<string> {
  if (raw === undefined || raw === null || raw === "") {
    return ok("");
  }

  if (typeof raw !== "string") {
    return err("send_time 必须是字符串");
  }

  const value = raw.trim();
  if (value === "") {
    return ok("");
  }

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return err("send_time 格式不合法，应为 YYYY-MM-DD HH:MM 或 YYYY-MM-DD HH:MM:SS");
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);

  // 逐项范围检查，避免 2026-13-45 这类「格式对但不存在」的值进入脚本
  if (month < 1 || month > 12) return err("send_time 的月份不合法");
  if (day < 1 || day > 31) return err("send_time 的日期不合法");
  if (hour > 23) return err("send_time 的小时不合法");
  if (minute > 59) return err("send_time 的分钟不合法");
  if (second > 59) return err("send_time 的秒不合法");

  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return err("send_time 不是一个真实存在的日期");
  }

  return ok(value);
}

/**
 * 规范化视频文件名。
 *
 * 处理步骤：
 *   1. 只取 basename —— 彻底切断 `..\..\` 之类的路径穿越
 *   2. 校验扩展名白名单
 *   3. 字符白名单：保留 Unicode 字母/数字与 `.` `_` `-`，其余替换为 `_`
 *      （这一步同时消除 `"` `&` `|` `$` 反引号等 cmd.exe 与 JS 的危险字符）
 *   4. 压缩连续下划线、去掉首尾的 `.` `_` `-`
 *   5. 按码点截断到 80 字符（为扩展名留位）
 *
 * 保留中文等 Unicode 字母是有意为之：若把所有非 ASCII 压成下划线，
 * 「我的视频.mp4」会退化成「video.mp4」，多个中文视频在同一账号下
 * 会得到相同的远程路径而互相覆盖。
 */
export function sanitizeVideoFilename(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string" || raw.trim() === "") {
    return err("文件名不能为空");
  }

  // 1. 只保留最后一段，兼容 / 与 \
  const base = raw.split(/[\\/]/).pop() ?? "";

  // 2. 拆扩展名（下标 0 视为无扩展名的隐藏文件，交后续处理）
  const dotIndex = base.lastIndexOf(".");
  const rawExtension = dotIndex > 0 ? base.slice(dotIndex).toLowerCase() : "";
  const rawStem = dotIndex > 0 ? base.slice(0, dotIndex) : base;

  if (!(ALLOWED_VIDEO_EXTENSIONS as readonly string[]).includes(rawExtension)) {
    return err(`仅支持 ${ALLOWED_VIDEO_EXTENSIONS.join(" / ")} 格式的视频`);
  }

  // 3. 字符白名单。\p{L} 字母、\p{N} 数字，均含 Unicode
  const stem = normalizeStem(rawStem);
  if (!stem) {
    return err("文件名在去除非法字符后为空，请使用包含字母或数字的文件名");
  }

  // 5. 截断（按码点，避免切断代理对）
  const maxStemLength = MAX_FILENAME_LENGTH - rawExtension.length;
  const codePoints = [...stem];
  const truncated = codePoints.length > maxStemLength
    ? trimEdges(codePoints.slice(0, maxStemLength).join("")) || "video"
    : stem;

  return ok(`${truncated}${rawExtension}`);
}

function normalizeStem(raw: string): string {
  const replaced = raw.replace(/[^\p{L}\p{N}._-]/gu, "_");
  const collapsed = replaced.replace(/_{2,}/g, "_");
  return trimEdges(collapsed);
}

function trimEdges(value: string): string {
  return value.replace(/^[._-]+/, "").replace(/[._-]+$/, "");
}

/**
 * 校验设备 ID 集合。
 *
 * 除了格式检查，**必须传 allowed 做子集校验**：
 * 否则用户可以把他人的 serial 填进 device_ids，配额形同虚设。
 */
export function validateDeviceIds(requested: unknown, allowed: Iterable<string>): ValidationResult<string[]> {
  if (!Array.isArray(requested)) {
    return err("device_ids 必须是数组");
  }

  const result: string[] = [];
  const seen = new Set<string>();

  for (const item of requested) {
    if (typeof item !== "string" || item.trim() === "") {
      return err("device_ids 中存在空值或非字符串项");
    }

    const serial = item.trim();
    if (!/^[A-Za-z0-9._:-]+$/.test(serial)) {
      return err(`设备 ID 含非法字符：${serial}`);
    }

    if (!seen.has(serial)) {
      seen.add(serial);
      result.push(serial);
    }
  }

  if (result.length === 0) {
    return err("device_ids 不能为空");
  }

  const allowedSet = new Set(allowed);
  const forbidden = result.filter((serial) => !allowedSet.has(serial));
  if (forbidden.length > 0) {
    return err(`无权操作以下设备：${forbidden.join(", ")}`);
  }

  return ok(result);
}

/**
 * 校验账号列表。
 *
 * allowed 为可选：账号系统就绪后传入该租户可用账号即可获得子集保护；
 * 未传时只做格式校验。
 */
export function validateAccounts(requested: unknown, allowed?: Iterable<string>): ValidationResult<string[]> {
  if (!Array.isArray(requested)) {
    return err("accounts 必须是数组");
  }

  const result: string[] = [];
  const seen = new Set<string>();

  for (const item of requested) {
    if (typeof item !== "string" || item.trim() === "") {
      return err("accounts 中存在空值或非字符串项");
    }

    const account = item.trim();
    // 账号名会成为远程路径 /sdcard/SaveVideo/<account>/ 的一段，必须同样收紧
    if (account.length > 64 || /[^\p{L}\p{N}._-]/u.test(account)) {
      return err(`账号名含非法字符或过长：${account}`);
    }

    if (!seen.has(account)) {
      seen.add(account);
      result.push(account);
    }
  }

  if (result.length === 0) {
    return err("accounts 不能为空");
  }

  if (result.length > MAX_ACCOUNT_COUNT) {
    return err(`单次最多操作 ${MAX_ACCOUNT_COUNT} 个账号`);
  }

  if (allowed) {
    const allowedSet = new Set(allowed);
    const forbidden = result.filter((account) => !allowedSet.has(account));
    if (forbidden.length > 0) {
      return err(`无权操作以下账号：${forbidden.join(", ")}`);
    }
  }

  return ok(result);
}

/**
 * 校验标题列表。
 *
 * 标题会以 JSON.stringify 注入脚本，本身不易闭合字符串，
 * 但仍限制长度与条数作为纵深防御。
 */
export function validateTitles(raw: unknown): ValidationResult<string[]> {
  if (raw === undefined || raw === null) {
    return ok([]);
  }

  if (!Array.isArray(raw)) {
    return err("titles 必须是数组");
  }

  if (raw.length > MAX_TITLE_COUNT) {
    return err(`titles 最多 ${MAX_TITLE_COUNT} 条`);
  }

  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      return err("titles 中存在非字符串项");
    }

    const title = item.trim();
    if (title.length > MAX_TITLE_LENGTH) {
      return err(`单条标题最长 ${MAX_TITLE_LENGTH} 字符`);
    }

    if (title !== "") {
      result.push(title);
    }
  }

  return ok(result);
}

/** 校验商品名 / 定位等自由文本字段。 */
export function validateText(raw: unknown, field: string, maxLength = MAX_TEXT_LENGTH): ValidationResult<string> {
  if (raw === undefined || raw === null) {
    return ok("");
  }

  if (typeof raw !== "string") {
    return err(`${field} 必须是字符串`);
  }

  const value = raw.trim();
  if (value.length > maxLength) {
    return err(`${field} 最长 ${maxLength} 字符`);
  }

  return ok(value);
}

/** 校验并规范化 assignments（批量模式下账号与视频的对应关系）。 */
export function validateAssignments(raw: unknown): ValidationResult<{ account: string; video: string }[]> {
  if (raw === undefined || raw === null) {
    return ok([]);
  }

  if (!Array.isArray(raw)) {
    return err("assignments 必须是数组");
  }

  const result: { account: string; video: string }[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      return err("assignments 中存在非法项");
    }

    const { account, video } = item as { account?: unknown; video?: unknown };
    if (typeof account !== "string" || account.trim() === "") {
      return err("assignments 中的 account 不能为空");
    }

    const safeVideo = sanitizeVideoFilename(video);
    if (!safeVideo.ok) {
      return err(`assignments 中的 video 不合法：${safeVideo.error}`);
    }

    const safeAccount = account.trim();
    if (/[^\p{L}\p{N}._-]/u.test(safeAccount)) {
      return err(`assignments 中的 account 含非法字符：${safeAccount}`);
    }

    result.push({ account: safeAccount, video: safeVideo.value });
  }

  return ok(result);
}

/**
 * DayilWork 模板中「无引号数值占位符」的白名单。
 *
 * 依据 `autojs-controller/scripts/DayilWork_template.js` 实测提取。
 * 这些占位符形如 `var SWIPE_COUNT = {{SWIPE_COUNT}};`——
 * **没有引号，是直接的 JS 表达式位置**，
 * 而 `scripts_renderer/buildDayilWork.js` 用
 * `code.replace(new RegExp(\`{{${key}}}\`), valueStr)` 原样替换。
 *
 * 因此只要 config 里出现字符串值，就等于把字符串插进 JS 语句中间。
 * 这里只接受有限数值，并限制在合理区间。
 */
const DAYIL_NUMERIC_KEYS: Record<string, { min: number; max: number }> = {
  SWIPE_COUNT: { min: 0, max: 10_000 },
  SWIPE_COUNT_MIN: { min: 0, max: 10_000 },
  SWIPE_COUNT_MAX: { min: 0, max: 10_000 },
  PLAY_DURATION: { min: 0, max: 600_000 },
  LIKE_PROBABILITY: { min: 0, max: 100 },
  FOLLOW_PROBABILITY: { min: 0, max: 100 },
  COMMENT_PROBABILITY: { min: 0, max: 100 },
  FAVORITE_PROBABILITY: { min: 0, max: 100 },
  SEARCH_PROBABILITY: { min: 0, max: 100 },
  WAIT_AFTER_SEARCH: { min: 0, max: 600_000 },
  LIVE_WATCH_DURATION: { min: 0, max: 3_600_000 }
};

/**
 * DayilWork 模板中会被 JSON.stringify 注入的数组型占位符。
 * JSON 是合法的 JS 字面量，风险低于上面那批，但仍限长限量。
 */
const DAYIL_LIST_KEYS = new Set(["SEARCH_KEYWORDS", "TALK_CONTENT", "TARGET_ACCOUNTS", "LIVE_CHAT_CONTENT"]);

const MAX_LIST_ITEM_LENGTH = 100;
const MAX_LIST_LENGTH = 50;

/**
 * 校验养号配置。
 *
 * 三条控制：
 *   1. **键名白名单** —— buildDayilWork 用调用方给的键去构造正则匹配模板占位符，
 *      允许任意键等于允许调用方挑选要替换的占位符
 *   2. **数值键只接受有限数字** —— 这些占位符无引号，字符串会被当作代码
 *   3. **列表键只接受短字符串数组**
 *
 * 注：SCRIPT_RUN_ID / SCRIPT_TYPE 虽在模板中，但 buildDayilWork 会用自身 meta
 * 覆盖它们，调用方无法控制，因此不在白名单内（传了也会被拒绝）。
 */
export function validateDayilWorkConfig(raw: unknown): ValidationResult<Record<string, unknown>> {
  if (raw === undefined || raw === null) {
    return ok({});
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    return err("config 必须是一个对象");
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const numericRule = DAYIL_NUMERIC_KEYS[key];

    if (numericRule) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return err(`config.${key} 必须是数字（该配置项会被直接写入脚本，不接受字符串）`);
      }

      if (!Number.isInteger(value)) {
        return err(`config.${key} 必须是整数`);
      }

      if (value < numericRule.min || value > numericRule.max) {
        return err(`config.${key} 超出允许范围 ${numericRule.min} ~ ${numericRule.max}`);
      }

      result[key] = value;
      continue;
    }

    if (DAYIL_LIST_KEYS.has(key)) {
      if (!Array.isArray(value)) {
        return err(`config.${key} 必须是数组`);
      }

      if (value.length > MAX_LIST_LENGTH) {
        return err(`config.${key} 最多 ${MAX_LIST_LENGTH} 项`);
      }

      const items: string[] = [];
      for (const item of value) {
        if (typeof item !== "string") {
          return err(`config.${key} 中存在非字符串项`);
        }

        if (item.length > MAX_LIST_ITEM_LENGTH) {
          return err(`config.${key} 中单项最长 ${MAX_LIST_ITEM_LENGTH} 字符`);
        }

        items.push(item);
      }

      result[key] = items;
      continue;
    }

    return err(`config 中存在不支持的配置项：${key}`);
  }

  return ok(result);
}

/**
 * 校验本地视频路径。
 *
 * 由于 autojs 会把 basename 拼进 `adb push` 命令行（经 cmd.exe），
 * 这里要求调用方**已经**把文件按 sanitizeVideoFilename 的结果落盘。
 *
 * 为什么是「拒绝」而不是「自动改名」：本地磁盘上的真实文件名必须与传给
 * autojs 的路径完全一致，若在这里静默改名，会与实际文件对不上，
 * 变成 adb push 找不到文件。因此这里只做一致性断言。
 */
export function validateVideoPaths(raw: unknown): ValidationResult<string[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return err("video_paths 不能为空");
  }

  const result: string[] = [];

  for (const item of raw) {
    if (typeof item !== "string" || item.trim() === "") {
      return err("video_paths 中存在空值或非字符串项");
    }

    const filePath = item.trim();

    if (!/^[A-Za-z]:[\\/]/.test(filePath)) {
      return err(`video_paths 必须是 Windows 绝对路径：${filePath}`);
    }

    const segments = filePath.split(/[\\/]/);
    const basename = segments[segments.length - 1] ?? "";

    const safe = sanitizeVideoFilename(basename);
    if (!safe.ok) {
      return err(`video_paths 的文件名不合法：${safe.error}`);
    }

    if (safe.value !== basename) {
      return err(
        `video_paths 的文件名未经规范化：期望 ${safe.value}，实际 ${basename}。` +
          "请先按规范化后的名字落盘再下发。"
      );
    }

    result.push(filePath);
  }

  return ok(result);
}
