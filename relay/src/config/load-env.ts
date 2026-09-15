import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 把工作目录下的 `.env` 载入 `process.env`。
 *
 * ── 为什么写成一个「副作用模块」────────────────────────────────
 *
 * **本文件必须是 `main.ts` 的第一个 import**，因为它的全部价值就在于
 * 「在被其它模块读到之前」把变量放好。
 *
 * ESM 按 import 顺序深度优先求值，而 `api/http.ts`（限流参数）与
 * `auth/emailVerification.ts`（验证码 TTL / 冷却 / 尝试上限）都是在
 * **模块顶层**读 `process.env` 把常量算出来的。如果改成「在 main.ts 里
 * 调一行」，等那行执行时这些值早已定型——于是得到一个最难查的错误：
 * `.env` 里的 `SMTP_*` 生效（它在启动那一刻才读），
 * 而 `VERIFICATION_*` 不生效（它在模块求值那一刻就读完了）。
 *
 * 用内建的 `process.loadEnvFile`（Node 20.12+），不引入 dotenv 依赖。
 *
 * ── 优先级 ──────────────────────────────────────────────────────
 *
 * **已存在的真实环境变量优先，`.env` 只补空缺**（已实测确认）。
 * 所以 `pm2` 注入的凭据不会被开发者留在磁盘上的陈旧 `.env` 覆盖，
 * 「生产用环境变量、本地用 .env」两种方式可以共存。
 */

/** 实际的 .env 路径；供启动日志显示 */
export const DOT_ENV_PATH = resolve(process.cwd(), ".env");

function loadDotEnvFile(): boolean {
  // 没有 .env 是完全正常的，不是错误
  if (!existsSync(DOT_ENV_PATH)) {
    return false;
  }

  if (typeof process.loadEnvFile !== "function") {
    console.warn(
      `[relay] 发现 ${DOT_ENV_PATH}，但当前 Node（${process.version}）不支持 process.loadEnvFile。` +
        "请升级到 Node 20.12+，或改用 node --env-file=.env 启动。"
    );
    return false;
  }

  process.loadEnvFile(DOT_ENV_PATH);
  return true;
}

/** 是否真的载入了 .env（供启动日志使用） */
export const DOT_ENV_LOADED = loadDotEnvFile();
