/**
 * 给 Web 界面截图（无依赖，直连 Chrome DevTools Protocol）。
 *
 *   node scripts/dev-screenshot.mjs --out .tmp-test/console.png
 *   node scripts/dev-screenshot.mjs --view automation --out .tmp-test/auto.png
 *   node scripts/dev-screenshot.mjs --view admin --out .tmp-test/admin.png
 *
 * 为什么要有这个工具：改 CSS 时「看着好点了」是最不可靠的判断方式。
 * 先截一张「改之前」，改完再截一张，两张摆在一起看 —— 这是唯一能
 * 避免「越改越糟」的办法，也能避免把某个元素改出视口这种低级错误。
 *
 * 需要先起前端（会顺带起 relay + 假 agent）：
 *   node scripts/dev-web-test.mjs
 *
 * 它做的事：
 *   1. 调 /api/auth/login 拿 token（默认 admin / DevTest123456）
 *   2. 起一个 headless 浏览器（Edge 或 Chrome），用临时 profile 不碰你的
 *   3. 打开页面 → 把 token 写进 localStorage → 重新加载，这样才进得去控制台
 *   4. 需要的话点一下顶部导航切到指定视图
 *   5. 整页截图存成 PNG
 *
 * 用的是 Node 内置的全局 WebSocket（Node 22+），所以不需要 puppeteer。
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// ────────────────────────── 参数 ──────────────────────────
function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));

// --url 可以带路径（如 /preview.html）。**必须把 origin 和页面地址分开**：
// 早期版本直接往 --url 后面拼 /api/auth/login，于是带路径时请求会变成
// ".../preview.html/api/auth/login"，拿到的是 HTML 而不是 JSON。
const TARGET = new URL(String(args.url ?? "http://127.0.0.1:8090"));
const ORIGIN = TARGET.origin;
const PAGE_URL = TARGET.toString();
const OUT = resolve(String(args.out ?? ".tmp-test/screenshot.png"));
const VIEW = String(args.view ?? "console");
const WIDTH = Number(args.width ?? 1600);
const HEIGHT = Number(args.height ?? 1100);
const USERNAME = String(args.user ?? "admin");
const PASSWORD = String(args.password ?? process.env.TEST_ADMIN_PASSWORD ?? "DevTest123456");
const SETTLE_MS = Number(args.settle ?? 2500);
/** 静态页/探针页没有账号系统，跳过登录与 localStorage 注入 */
const NO_AUTH = Boolean(args["no-auth"]);

const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
];

function findBrowser() {
  for (const path of BROWSERS) {
    if (existsSync(path)) return path;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 生成"按文字点按钮"的页面内脚本。
 *
 * 不能只用精确匹配：侧栏导航的按钮文本是 `⚙自动化`（图标 + 文字），
 * 精确比对永远找不到。所以先精确匹配，找不到再退化成**包含匹配**，
 * 并在多个候选中取文本最短的那个（否则会命中包住一切的祖先容器）。
 */
function clickByText(label) {
  return `
    (() => {
      const norm = (value) => (value || "").replace(/\\s+/g, "");
      const buttons = [...document.querySelectorAll("button")];
      const wanted = norm(${JSON.stringify(label)});

      const exact = buttons.find((b) => norm(b.textContent) === wanted);
      if (exact) {
        exact.click();
        return "clicked-exact";
      }

      const loose = buttons
        .filter((b) => norm(b.textContent).includes(wanted))
        .sort((a, b) => norm(a.textContent).length - norm(b.textContent).length);

      if (loose.length === 0) return "not-found";
      loose[0].click();
      return "clicked-loose";
    })()
  `;
}

// ────────────────────────── CDP 小客户端 ──────────────────────────
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);

      if (message.id && this.pending.has(message.id)) {
        const { resolve: done, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else done(message.result);
        return;
      }

      if (message.method) this.events.push(message);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rejectPromise(new Error(`CDP 超时：${method}`));
        }
      }, 30_000);
    });
  }

  /** 等某个事件出现（比如 loadEventFired） */
  async waitForEvent(method, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.events.findIndex((e) => e.method === method);
      if (index >= 0) {
        const [found] = this.events.splice(index, 1);
        return found.params;
      }
      await sleep(50);
    }
    return null;
  }

  /** 在页面里求值 */
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });

    if (result.exceptionDetails) {
      throw new Error(`页面内求值失败：${result.exceptionDetails.text}`);
    }

    return result.result?.value;
  }
}

// ────────────────────────── 主流程 ──────────────────────────
async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error("找不到 Edge / Chrome，无法截图。");
    process.exit(1);
  }

  // 1) 登录拿 token + user（session.ts 里就存在 localStorage）
  let session = null;

  if (!NO_AUTH) {
    const loginRes = await fetch(`${ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD })
    });

    if (!loginRes.ok) {
      console.error(`登录失败（HTTP ${loginRes.status}）：${await loginRes.text()}`);
      console.error("提示：dev-web-test.mjs 默认管理员密码是 DevTest123456，可用 TEST_ADMIN_PASSWORD 覆盖。");
      process.exit(1);
    }

    session = await loginRes.json();
    console.log(`已登录：${session.user.username}（${session.user.role}）`);
  } else {
    console.log("跳过登录（--no-auth）");
  }

  // 2) 起 headless 浏览器（临时 profile，绝不碰你日常用的那个）
  const debugPort = 9200 + Math.floor(Math.random() * 300);
  const profileDir = resolve(tmpdir(), `dsh-shot-${randomBytes(4).toString("hex")}`);

  const child = spawn(
    browserPath,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      "about:blank"
    ],
    { stdio: "ignore" }
  );

  let socket;
  try {
    // 等调试端口起来
    let target = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        target = list.find((t) => t.type === "page");
        if (target?.webSocketDebuggerUrl) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }

    if (!target?.webSocketDebuggerUrl) {
      throw new Error("浏览器调试端口没起来");
    }

    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolvePromise, rejectPromise) => {
      socket.addEventListener("open", resolvePromise, { once: true });
      socket.addEventListener("error", () => rejectPromise(new Error("CDP 连接失败")), { once: true });
    });

    const cdp = new Cdp(socket);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false
    });

    // 3) 先打开同源页面（localStorage 是按源隔离的，必须先到那个源）
    await cdp.send("Page.navigate", { url: PAGE_URL });
    await cdp.waitForEvent("Page.loadEventFired");

    if (session) {
      await cdp.evaluate(`
        localStorage.setItem("rpc.session.token", ${JSON.stringify(session.token)});
        localStorage.setItem("rpc.session.user", ${JSON.stringify(JSON.stringify(session.user))});
        "ok"
      `);

      // 4) 重新加载，让应用带着会话启动
      await cdp.send("Page.navigate", { url: PAGE_URL });
      await cdp.waitForEvent("Page.loadEventFired");
    }

    // 5) 切视图：顶部导航按钮的文本就是视图名
    if (VIEW !== "console") {
      const label = VIEW === "automation" ? "自动化" : VIEW === "admin" ? "管理" : VIEW;
      console.log(`切到「${label}」：${await cdp.evaluate(clickByText(label))}`);
    }

    // 5b) 再按文字点一个按钮（用来切子标签页，如「养号」/「发视频」）
    if (args.click) {
      const target = String(args.click);
      console.log(`点击「${target}」：${await cdp.evaluate(clickByText(target))}`);
    }

    // 6) 等实时画面/设备列表稳定下来。
    //    **必须在 --eval 之前等**：页面刚加载时设备列表还没到，
    //    `.device-video-shell` 这类元素还不存在，eval 会拿到 null 报 Uncaught。
    await sleep(SETTLE_MS);

    // 6b) 截图前跑一段页面内 JS（验证交互，或量取计算样式）
    if (args.eval) {
      const result = await cdp.evaluate(String(args.eval));
      console.log(`eval → ${JSON.stringify(result)}`);
    }

    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true
    });

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, Buffer.from(shot.data, "base64"));

    const size = (Buffer.from(shot.data, "base64").length / 1024).toFixed(0);
    console.log(`已保存：${OUT}（${size} KB，视口 ${WIDTH}x${HEIGHT}，整页）`);
  } finally {
    try {
      socket?.close();
    } catch {
      /* 忽略 */
    }
    child.kill();
    await sleep(300);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* 浏览器可能还没完全退出，残留临时目录无所谓 */
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
