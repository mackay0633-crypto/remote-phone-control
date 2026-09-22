import { useState } from "react";
import { THEMES, isPreviewMode, resolveTheme, setTheme, type ThemeId } from "./theme";

/**
 * 风格切换器。
 *
 * **只在预览模式下出现**（URL 带 `?theme=` 或 `?preview=1`）—— 正常用户不该
 * 看到"给界面换皮"这种开关，最终只会定一套风格发布。
 *
 * 要对比五套：打开 `preview.html`（五宫格，一格一套）。
 */
export function ThemePicker() {
  const [theme, setThemeState] = useState<ThemeId>(resolveTheme);
  const [open, setOpen] = useState(false);

  if (!isPreviewMode()) {
    return null;
  }

  const current = THEMES.find((item) => item.id === theme) ?? THEMES[0];

  return (
    <div className="theme-picker">
      <button type="button" className="theme-picker-toggle" onClick={() => setOpen((value) => !value)}>
        🎨 风格：{current.label}
      </button>

      {open ? (
        <div className="theme-picker-menu">
          {THEMES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`theme-picker-item ${item.id === theme ? "active" : ""}`}
              onClick={() => {
                setTheme(item.id);
                setThemeState(item.id);
                setOpen(false);
              }}
            >
              <span className="theme-picker-item-label">{item.label}</span>
              <span className="theme-picker-item-hint">{item.hint}</span>
            </button>
          ))}
          <div className="theme-picker-note">
            也可直接用地址栏：<code>?theme=light</code>
          </div>
        </div>
      ) : null}
    </div>
  );
}
