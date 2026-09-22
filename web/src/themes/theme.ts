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
  return params.has("preview") || params.has("theme") || params.has("layout") || params.has("preset");
}

/* ────────────────────────── 布局结构 ──────────────────────────
 *
 * 与主题是**两个正交的轴**：
 *   theme   什么颜色、什么圆角、多密
 *   layout  东西摆在哪、设备怎么表现、画面占多大
 *
 * 分开的好处是能自由组合（"表格布局 + 暖色"），也便于以后只调其中一个。
 */

export const LAYOUTS = [
  { id: "classic", label: "经典", hint: "顶部标题 + 左画面右卡片墙" },
  { id: "master-detail", label: "主从三栏", hint: "左导航 + 设备行列表 + 信息栏" },
  { id: "table", label: "表格密集", hint: "一台一行的设备表 + 右侧画面" },
  { id: "studio", label: "工作台", hint: "大画面优先 + 右侧窄工具条" },
  { id: "wall", label: "设备墙", hint: "顶部预览横幅 + 密集砖块墙" }
] as const;

export type LayoutId = (typeof LAYOUTS)[number]["id"];

/**
 * 需要把导航放到左侧竖栏的布局。
 *
 * 「主从三栏」是唯一改变**导航位置**的一套 —— 顶部横幅会横向吃掉一整条，
 * 而它的价值就在于中栏能多列几台设备。这也是它跟经典布局最本质的区别，
 * 不只是把卡片换成了列表。
 */
export const SIDEBAR_LAYOUTS: readonly LayoutId[] = ["master-detail"];

export function usesSidebar(layout: LayoutId): boolean {
  return SIDEBAR_LAYOUTS.includes(layout);
}

export const DEFAULT_LAYOUT: LayoutId = "classic";

const LAYOUT_KEY = "rpc.ui.layout";

function isLayoutId(value: string): value is LayoutId {
  return LAYOUTS.some((item) => item.id === value);
}

export function resolveLayout(): LayoutId {
  if (typeof window !== "undefined") {
    const fromQuery = new URLSearchParams(window.location.search).get("layout")?.trim() ?? "";
    if (isLayoutId(fromQuery)) {
      return fromQuery;
    }

    try {
      const stored = window.localStorage.getItem(LAYOUT_KEY)?.trim() ?? "";
      if (isLayoutId(stored)) {
        return stored;
      }
    } catch {
      // 隐私模式读不到，用默认值
    }
  }

  return DEFAULT_LAYOUT;
}

export function setLayout(layout: LayoutId): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    // 本次会话仍然生效
  }

  applyLayout(layout);
}

/**
 * 把布局挂到 `<html data-layout>` 上。
 *
 * 为什么需要这个属性：基础样式里画面外框是 **硬编码 `min-height: 600px`**、
 * 手机框是死写的 300×600 —— 那是给经典布局量的尺寸。而在 CSS 里
 * **`min-height` 永远赢过 `max-height`**，所以只写 `max-height` 根本压不下去
 * （第一次就是这么改的，截图一看纹丝不动）。
 *
 * 有了 data-layout，就能按布局整体覆盖这些固定尺寸，而不是去和每条
 * 硬编码规则逐个打架。
 */
export function applyLayout(layout: LayoutId): void {
  document.documentElement.dataset.layout = layout;
}

/* ────────────────────────── 预设组合 ──────────────────────────
 *
 * 五套"整页效果" = 布局 × 主题。切换器用这个列表；
 * 想混搭就直接用地址栏的 ?layout= 与 ?theme=（两者独立生效）。
 */

export interface UiPreset {
  id: string;
  label: string;
  layout: LayoutId;
  theme: ThemeId;
  hint: string;
}

export const PRESETS: readonly UiPreset[] = [
  {
    id: "classic",
    label: "1 · 经典",
    layout: "classic",
    theme: "neon",
    hint: "与现在线上一致：顶部标题 + 左画面右卡片墙"
  },
  {
    id: "sidebar",
    label: "2 · 主从三栏",
    layout: "master-detail",
    theme: "light",
    hint: "导航移到左侧，设备变行列表，画面居中独立成栏"
  },
  {
    id: "dense",
    label: "3 · 表格密集",
    layout: "table",
    theme: "corporate",
    hint: "整个页面是一张设备表，一屏能管几十台"
  },
  {
    id: "studio",
    label: "4 · 工作台",
    layout: "studio",
    theme: "terminal",
    hint: "画面占 2/3 视口，设备变芯片，右侧窄工具条"
  },
  {
    id: "wall",
    label: "5 · 设备墙",
    layout: "wall",
    theme: "warm",
    hint: "墙为主体，顶部一条预览横幅 —— 与经典的主次正好相反"
  }
];
