import { useCallback, useEffect, useRef, useState } from "react";
import { RELAY_WS_BASE_URL, USE_RELAY } from "./client";

/** 与 relay 侧白名单保持一致 */
export type AutomationAction =
  | "health"
  | "run-status"
  | "accounts"
  | "dayil-work.start"
  | "send-video.start";

export interface AutomationDevice {
  serial: string;
  status: string;
  model: string;
  androidVersion: string;
  width: number;
  height: number;
}

export interface AutomationResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

/** 与 relay 侧 `relay/src/automation/router.ts` 的动作一一对应 */
export type AutomationState = "connecting" | "ready" | "error";

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 自动化请求走**独立的 viewer 连接**。
 *
 * 为什么不让它和 ConsoleView 共用一条：控制通道那条连接的生命周期
 * 绑在实时画面上（切设备会重建），而自动化请求可能跑好几分钟
 * （发视频含 adb push）。两者共用的结果是切个设备就把在途请求搞丢了。
 *
 * relay 允许同一账号开多条 viewer 连接，所以各开各的没有副作用。
 */
export function useAutomation(token: string) {
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<string, (result: AutomationResult) => void>());
  const [state, setState] = useState<AutomationState>("connecting");
  const [error, setError] = useState("");
  const [devices, setDevices] = useState<AutomationDevice[]>([]);

  useEffect(() => {
    if (!USE_RELAY || !token) {
      return;
    }

    let cancelled = false;
    const socket = new WebSocket(`${RELAY_WS_BASE_URL}/ws/viewer`);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "auth", token }));
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }

      if (payload.type === "auth-ok") {
        setState("ready");
        setError("");
        return;
      }

      if (payload.type === "auth-error") {
        setState("error");
        setError(typeof payload.message === "string" ? payload.message : "鉴权失败");
        return;
      }

      if (payload.type === "devices") {
        setDevices((payload.devices as AutomationDevice[]) ?? []);
        return;
      }

      if (payload.type === "automation-result") {
        const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
        const resolve = pendingRef.current.get(requestId);
        if (!resolve) {
          return;
        }

        pendingRef.current.delete(requestId);
        resolve({
          ok: payload.ok === true,
          data: payload.data,
          error: typeof payload.error === "string" ? payload.error : undefined,
          code: typeof payload.code === "string" ? payload.code : undefined
        });
      }
    });

    socket.addEventListener("close", () => {
      if (cancelled) {
        return;
      }

      setState("error");
      setError("与服务器的连接已断开");

      // 断线时把所有在途请求失败掉，避免界面一直转圈
      for (const resolve of pendingRef.current.values()) {
        resolve({ ok: false, error: "与服务器的连接已断开" });
      }
      pendingRef.current.clear();
    });

    socket.addEventListener("error", () => {
      if (!cancelled) {
        setState("error");
        setError("连接异常");
      }
    });

    return () => {
      cancelled = true;
      socketRef.current = null;
      for (const resolve of pendingRef.current.values()) {
        resolve({ ok: false, error: "页面已离开" });
      }
      pendingRef.current.clear();
      socket.close();
    };
  }, [token]);

  const request = useCallback(
    (action: AutomationAction, payload: Record<string, unknown> = {}): Promise<AutomationResult> => {
      const socket = socketRef.current;

      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return Promise.resolve({ ok: false, error: "与服务器的连接未就绪" });
      }

      const requestId = `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      return new Promise<AutomationResult>((resolve) => {
        const timer = setTimeout(() => {
          pendingRef.current.delete(requestId);
          resolve({ ok: false, error: "请求超时" });
        }, REQUEST_TIMEOUT_MS);

        pendingRef.current.set(requestId, (result) => {
          clearTimeout(timer);
          resolve(result);
        });

        socket.send(JSON.stringify({ type: "automation", requestId, action, payload }));
      });
    },
    []
  );

  return { state, error, devices, request };
}
