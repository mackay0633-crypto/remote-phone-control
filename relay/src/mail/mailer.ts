/**
 * 邮件发送。
 *
 * 目前只有验证码一种用途（注册 / 找回密码 / 换绑邮箱），所以接口刻意做得很窄：
 * 一个 `send()` 加两个自描述属性，够用且不容易用错。
 *
 * ── 两种通道 ────────────────────────────────────────────────────
 *
 * `console`（默认）：把邮件内容打到 relay 日志里，不真正发信。
 * 开发/内网环境通常没有可用的发信通道，而「验证码发不出去」会让
 * 整个注册流程无法调试，所以默认走它，流程能完整跑通。
 *
 * `smtp`：生产用，经 `nodemailer` 真实发信。
 *
 * console 模式在非生产环境下会额外把验证码回显在 API 响应里
 * （`exposesCodes`），否则自动化测试得去翻 relay 的 stdout 才能拿到码。
 * **生产环境（NODE_ENV=production）即便误用 console 也不会回显**，
 * 这是防止把「日志级别的东西」变成「线上取码接口」。
 */

import nodemailer from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  readonly transport: "console" | "smtp";
  /**
   * 是否允许把验证码回显在 API 响应里。
   *
   * **只有本地/测试的 console 模式为 true**，任何生产配置都必须是 false。
   */
  readonly exposesCodes: boolean;
  send(message: MailMessage): Promise<void>;
}

/** 供启动日志使用的一行描述。 */
export function describeMailer(mailer: Mailer): string {
  if (mailer.transport === "smtp") {
    const host = process.env.SMTP_HOST?.trim() ?? "?";
    const port = process.env.SMTP_PORT?.trim() ?? "465";
    return `smtp（${host}:${port}）`;
  }

  return "console（验证码只打印在日志里，不会真正发出）";
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`MAIL_TRANSPORT=smtp 时必须设置环境变量 ${name}`);
  }
  return value;
}

function createConsoleMailer(): Mailer {
  const exposesCodes = process.env.NODE_ENV !== "production";

  return {
    transport: "console",
    exposesCodes,
    async send(message: MailMessage): Promise<void> {
      const line = "─".repeat(60);
      console.log(
        [
          `┌${line}`,
          "│ [mail:console] 未发送真实邮件（MAIL_TRANSPORT=console）",
          `│ 收件人: ${message.to}`,
          `│ 主题:   ${message.subject}`,
          "│ 正文:",
          ...message.text
            .split("\n")
            .filter((row) => row.trim().length > 0)
            .map((row) => `│   ${row}`),
          `└${line}`
        ].join("\n")
      );
    }
  };
}

/**
 * 真实 SMTP 发送。
 *
 * 支持的常见配置：QQ 邮箱 / 163 / 腾讯企业邮 / 阿里云邮件推送 的 SMTP 服务。
 * 注意多数服务商要求用**授权码**而不是登录密码，且 `SMTP_FROM` 必须与
 * 认证账号一致（否则会被直接拒收），发信域名还要配好 SPF / DKIM，
 * 否则验证码大概率进垃圾箱。
 */
async function createSmtpMailer(): Promise<Mailer> {
  const host = requireEnv("SMTP_HOST");
  const port = Number(process.env.SMTP_PORT?.trim() || "465");
  const user = requireEnv("SMTP_USER");
  const pass = requireEnv("SMTP_PASS");
  const from = process.env.SMTP_FROM?.trim() || user;

  // 465 是隐式 TLS，587 是 STARTTLS；默认按端口猜，可用 SMTP_SECURE 覆盖
  const secure = (process.env.SMTP_SECURE?.trim() || String(port === 465)) === "true";

  const transporter = nodemailer.createTransport({
    host,
    port: Number.isFinite(port) ? port : 465,
    secure,
    auth: { user, pass },
    // SMTP 不通时必须尽快失败：注册接口在等这封邮件，不能让请求挂死
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000
  });

  return {
    transport: "smtp",
    exposesCodes: false,
    async send(message: MailMessage): Promise<void> {
      await transporter.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text
      });
    }
  };
}

/**
 * 按环境变量创建 mailer。
 *
 * 配置写错时**直接抛错拒绝启动**，而不是悄悄退回 console——
 * 静默降级意味着生产环境以为在发信，实际只有日志里有验证码，
 * 用户一个都注册不进来，且要过很久才会被发现。
 */
export async function createMailerFromEnv(): Promise<Mailer> {
  const transport = (process.env.MAIL_TRANSPORT?.trim().toLowerCase() || "console") as
    | "console"
    | "smtp";

  if (transport === "console") {
    return createConsoleMailer();
  }

  if (transport === "smtp") {
    return createSmtpMailer();
  }

  throw new Error(`未知的 MAIL_TRANSPORT=${transport}（可选值：console / smtp）`);
}
