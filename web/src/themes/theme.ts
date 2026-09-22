/**
 * 主题选择与切换。
 *
 * 三个来源，优先级从高到低：
 *   1. URL 的 `?theme=xxx`   —— 预览用，不改本机偏好
 *   2. localStorage          —— 上次选的，日常使用
 *   3. `DEFAULT_THEME`       —— 没得选时的兜底
 *
 * `?theme=` 高于 localStorage 是刻意的：预览页要用同一个浏览器同时打开 5 套，
 * 如果 URL 不能压过存储值，5 个 iframe 全会显示同一套。
 */

export const THEMES = [
  { id: "neon", label: "深色霓虹", hint: "默认；玻璃拟态，最像产品" },
  { id: "light", label: "极简浅色", hint: "白底细边框，看表格不累" },
  { id: "terminal", label: "终端绿", hint: "纯黑等宽直角，运维味" },
  { id: "corporate", label: "企业蓝", hint: "浅色高密度，一屏最多设备" },
  { id: "warm", label: "暖色柔和", hint: "深色暖棕大圆角，久看不累" }
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

/** 兜底风格。改这一行就能换掉默认观感（其余四套仍然可用）。 */
export const DEFAULT_THEME: ThemeId = "neon";

const STORAGE_KEY = "rpc.ui.theme";

function isThemeId(value: string): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

function fromUrl(): ThemeId | null {
  if (typeof window === "undefined") {
    return null;
  }

  const value = new URLSearchParams(window.location.search).get("theme")?.trim() ?? "";
  return isThemeId(value) ? value : null;
}

function fromStorage(): ThemeId | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)?.trim() ?? "";
    return isThemeId(value) ? value : null;
  } catch {
    return null;
  }
}

export function resolveTheme(): ThemeId {
  return fromUrl() ?? fromStorage() ?? DEFAULT_THEME;
}

/** 把主题挂到 <html data-theme> 上；palette.css 的规则都以此为前缀 */
export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
}

/**
 * 首屏前调用，避免"先按默认色渲染一帧再变色"的闪烁。
 *
 * 这段逻辑必须在 React 之前跑；放在 `main.tsx` 顶部即可。
 */
export function initTheme(): ThemeId {
  const theme = resolveTheme();
  applyTheme(theme);
  return theme;
}

/** 用户主动切换：写入偏好并立即生效（URL 参数仍在时会盖过它） */
export function setTheme(theme: ThemeId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // 隐私模式下写不进去，本次会话仍然生效
  }

  applyTheme(theme);
}

/** 是否显示风格切换器：只在预览模式下出现，不打扰正常用户 */
export function isPreviewMode(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  return params.has("preview") || params.has("theme");
}
