import type { Database } from "../db/database.js";
import { countAdmins, createUser, findUserByUsername } from "./users.js";
import { generatePassword } from "./password.js";

export interface BootstrapResult {
  created: boolean;
  username?: string;
  /** 仅在随机生成时返回，供启动日志打印一次 */
  generatedPassword?: string;
}

/**
 * 首次启动时创建初始管理员。
 *
 * 密码来源优先级：
 *   1. `ADMIN_PASSWORD` 环境变量
 *   2. 随机生成，并由调用方在控制台醒目打印一次（只存哈希，不再可读回）
 *
 * **刻意不提供硬编码默认密码**——那样的密码会进 git、会变成全网皆知的默认口令。
 */
export async function ensureInitialAdmin(
  db: Database,
  options: { username?: string; password?: string }
): Promise<BootstrapResult> {
  if (countAdmins(db) > 0) {
    return { created: false };
  }

  const username = (options.username?.trim() || "admin").slice(0, 32);
  const providedPassword = options.password?.trim();

  if (findUserByUsername(db, username)) {
    // 用户名被非 admin 账号占用，换一个可用的
    let suffix = 2;
    let candidate = `${username}${suffix}`;
    while (findUserByUsername(db, candidate)) {
      suffix += 1;
      candidate = `${username}${suffix}`;
    }

    const password = providedPassword || generatePassword();
    await createUser(db, { username: candidate, password, role: "admin" });

    return {
      created: true,
      username: candidate,
      generatedPassword: providedPassword ? undefined : password
    };
  }

  const password = providedPassword || generatePassword();
  await createUser(db, { username, password, role: "admin" });

  return {
    created: true,
    username,
    generatedPassword: providedPassword ? undefined : password
  };
}

/** 启动日志用的横幅。随机密码只在这里出现一次。 */
export function formatBootstrapBanner(result: BootstrapResult): string | null {
  if (!result.created) {
    return null;
  }

  const lines = [
    "=".repeat(64),
    "  已创建初始管理员账号",
    `  用户名: ${result.username}`
  ];

  if (result.generatedPassword) {
    lines.push(`  密码:   ${result.generatedPassword}`);
    lines.push("  ⚠️  此密码只显示这一次，请立即保存并登录后修改");
  } else {
    lines.push("  密码:   取自 ADMIN_PASSWORD 环境变量");
  }

  lines.push("=".repeat(64));
  return lines.join("\n");
}
