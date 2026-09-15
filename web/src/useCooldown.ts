import { useEffect, useState } from "react";

/**
 * 验证码重发倒计时。
 *
 * 返回「剩余秒数」与「开始倒计时」。每次 tick 用 `setTimeout` 排下一次，
 * 而不是 `setInterval`——后者在组件重渲染或卸载时容易留下野计时器，
 * 也更容易叠加出多个并行计时器。
 */
export function useCooldown(): [number, (seconds: number) => void] {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (remaining <= 0) {
      return undefined;
    }

    const timer = window.setTimeout(() => setRemaining(remaining - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  return [remaining, setRemaining];
}
