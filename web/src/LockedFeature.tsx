import { useCallback, useEffect, useState, type ReactNode } from "react";

/**
 * 试用版功能门（gray-out / 升级提示）。
 *
 * 把 autojs 桌面端界面里的**全部可调项**都搬到网页上，但其中一部分在试用版
 * 是关闭的：控件照常展示（让客户看得见完整能力），只是置灰不可用，点一下
 * 弹出统一的升级提示。
 *
 * 三个实现细节，都是踩过的坑：
 *
 * 1. **不能靠 `disabled` 控件自己的 onClick** —— 浏览器对 disabled 表单元素
 *    不派发鼠标事件（连冒泡都没有），点了毫无反应。这里把点击挂在**外层容器**
 *    上，并用 `pointer-events: none` 让控件不吞事件（见 styles.css 的
 *    `.locked-field`）。
 * 2. **提示要浮在最上层**，不能放在面板内 —— 锁着的项可能已经滚出视口，
 *    内联提示用户根本看不到。所以做成固定在底部的 toast。
 * 3. 文案**固定一句**：`试用版不支持此功能，请使用正式版`，
 *    另外把点到的功能名一起显示，免得客户不知道点到了哪一项。
 */
export const LOCKED_MESSAGE = "试用版不支持此功能，请使用正式版";

export interface LockedNoticeState {
  /** 用户刚点到的功能名，空串表示没有提示 */
  target: string;
  notify: (name: string) => void;
  dismiss: () => void;
}

export function useLockedNotice(): LockedNoticeState {
  const [target, setTarget] = useState("");

  const notify = useCallback((name: string) => {
    setTarget(name);
  }, []);

  const dismiss = useCallback(() => {
    setTarget("");
  }, []);

  return { target, notify, dismiss };
}

/** 固定在底部的升级提示；`milliseconds` 后自动消失 */
export function LockedToast({ state, milliseconds = 2600 }: { state: LockedNoticeState; milliseconds?: number }) {
  const { target, dismiss } = state;

  useEffect(() => {
    if (!target) {
      return;
    }

    const timer = setTimeout(dismiss, milliseconds);
    return () => clearTimeout(timer);
    // target 变化要重新计时：连点两个不同的项时，提示不会提前消失
  }, [target, dismiss, milliseconds]);

  if (!target) {
    return null;
  }

  return (
    <div className="locked-toast" role="status" aria-live="polite" onClick={dismiss}>
      <span className="locked-toast-icon" aria-hidden="true">
        🔒
      </span>
      <span>
        <span className="locked-toast-target">{target}</span>
        <span className="locked-toast-message">{LOCKED_MESSAGE}</span>
      </span>
    </div>
  );
}

interface LockedFieldProps {
  label: string;
  /** 点进提示里显示的功能名 */
  name: string;
  hint?: string;
  onLocked: (name: string) => void;
  children: ReactNode;
}

/**
 * 一个置灰的表单项。
 *
 * children 是真正被禁用的控件（`disabled` 由调用方设置）——这样键盘用户也
 * 能看出它不可用，而不是只有视觉上的灰。
 */
export function LockedField({ label, name, hint, onLocked, children }: LockedFieldProps) {
  return (
    <div
      className="admin-quota-field locked-field"
      onClick={() => onLocked(name)}
      title={LOCKED_MESSAGE}
      role="presentation"
    >
      <span className="admin-quota-label">
        {label}
        <span className="locked-badge">正式版</span>
      </span>
      {children}
      {hint ? <span className="admin-quota-hint">{hint}</span> : null}
    </div>
  );
}

/** 置灰的按钮/整块功能 */
export function LockedBlock({
  title,
  description,
  name,
  onLocked,
  children
}: {
  title: string;
  description?: string;
  name: string;
  onLocked: (name: string) => void;
  children?: ReactNode;
}) {
  return (
    <div className="locked-block" onClick={() => onLocked(name)} title={LOCKED_MESSAGE} role="presentation">
      <div className="locked-block-head">
        <span className="locked-block-title">{title}</span>
        <span className="locked-badge">正式版</span>
      </div>
      {children}
      {description ? <span className="admin-quota-hint">{description}</span> : null}
    </div>
  );
}
