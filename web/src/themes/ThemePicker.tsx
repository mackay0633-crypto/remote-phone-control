import { useState } from "react";
import { PRESETS, isPreviewMode, type LayoutId, type ThemeId } from "./theme";

/**
 * 风格 / 布局切换器（仅预览模式）。
 *
 * 列的是**五套预设**（布局 × 主题），因为"哪套好看"是按整页效果判断的，
 * 单独换颜色或单独换布局都不好选。想混搭就用地址栏的
 * `?layout=table&theme=warm`（两个参数独立生效）。
 */
export function ThemePicker({
  layout,
  theme,
  onPick
}: {
  layout: LayoutId;
  theme: ThemeId;
  onPick: (layout: LayoutId, theme: ThemeId) => void;
}) {
  const [open, setOpen] = useState(false);

  if (!isPreviewMode()) {
    return null;
  }

  const current = PRESETS.find((item) => item.layout === layout && item.theme === theme);
  const label = current ? current.label : `${layout} · ${theme}`;

  return (
    <div className="theme-picker">
      <button type="button" className="theme-picker-toggle" onClick={() => setOpen((value) => !value)}>
        🎨 方案：{label}
      </button>

      {open ? (
        <div className="theme-picker-menu">
          {PRESETS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`theme-picker-item ${item.layout === layout && item.theme === theme ? "active" : ""}`}
              onClick={() => {
                onPick(item.layout, item.theme);
                setOpen(false);
              }}
            >
              <span className="theme-picker-item-label">{item.label}</span>
              <span className="theme-picker-item-hint">{item.hint}</span>
            </button>
          ))}
          <div className="theme-picker-note">
            混搭：<code>?layout=table&theme=warm</code>
          </div>
        </div>
      ) : null}
    </div>
  );
}
