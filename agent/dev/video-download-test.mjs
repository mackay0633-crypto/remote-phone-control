/**
 * agent 侧视频下载测试。
 *
 * 这一段代码是全链路里**最不容易手工验证**的一环：它只有两个真实前置条件
 * ——「relay 在跑」和「有真实设备」——而它本身既不碰 adb 也不碰 autojs。
 * 所以这里用一个本地 HTTP 服务冒充 relay，把下载逻辑单独拉出来测。
 *
 * 重点覆盖三件会静默出错的事：
 *
 *   1. **sha256 校验** —— 校验失败必须删掉半截文件。
 *      不删的话下次下发会直接复用这个坏文件，而报错会指向 autojs。
 *   2. **落盘文件名保持 relay 给的名字** —— autojs 从 basename 推导视频名，
 *      改名会让多个视频退化成同一个。
 *   3. **拒绝不安全的文件名** —— 即使名字来自服务端也不赌它。
 *
 * 运行：
 *   cd agent
 *   node dev/video-download-test.mjs
 *
 * 不需要任何环境变量，也不需要 relay / 手机 / autojs。
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { downloadVideo, removeDownloadedVideo } from "../src/autojs/video-download.ts";

const SECRET = "unit-test-secret";
const VIDEO_ID = "a".repeat(32);
/** 文件名带中文与空格，用来验证 percent-encoding 往返 */
const SAFE_NAME = "我的_视频_1.mp4";

let pass = 0;
let fail = 0;

function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`);
  }
}

async function chkRejects(name, promise, messagePattern) {
  try {
    await promise;
    fail += 1;
    console.log(`  FAIL  ${name}\n        期望抛错，但成功返回了`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (messagePattern.test(message)) {
      pass += 1;
      console.log(`  PASS  ${name}`);
    } else {
      fail += 1;
      console.log(`  FAIL  ${name}\n        期望错误信息匹配 ${messagePattern}\n        实际 ${message}`);
    }
  }
}

const BODY = Buffer.from("单元测试视频内容-".repeat(200), "utf8");
const GOOD_SHA = createHash("sha256").update(BODY).digest("hex");

/** 冒充 relay 的下载接口；`mode` 控制返回什么，用来构造各种失败路径 */
function startFakeRelay(modeRef, seen) {
  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      // 明确关连接：undici 默认 keep-alive，套接字会一直挂着，
      // server.close() 就永远等不到事件循环清空（Windows 上还会在退出时
      // 触发 libuv 断言）。测试里省掉复用连接的开销没有意义。
      res.setHeader("Connection", "close");

      seen.push({
        url: req.url,
        authorization: req.headers.authorization ?? null
      });

      const mode = modeRef.value;

      if (mode === "unauthorized") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "agent 凭证无效" }));
        return;
      }

      if (mode === "missing") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "视频不存在" }));
        return;
      }

      const headers = {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(BODY.length),
        "X-Video-Name": encodeURIComponent(mode === "badname" ? "../../evil.mp4" : SAFE_NAME),
        "X-Video-Sha256": mode === "badsha" ? "0".repeat(64) : GOOD_SHA
      };

      if (mode === "noname") {
        delete headers["X-Video-Name"];
      }

      res.writeHead(200, headers);
      res.end(BODY);
    });

    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

async function main() {
  const mediaRoot = await mkdtemp(join(tmpdir(), "agent-video-test-"));
  const modeRef = { value: "ok" };
  const seen = [];
  const server = await startFakeRelay(modeRef, seen);
  const port = server.address().port;

  const config = {
    relayHttpBaseUrl: `http://127.0.0.1:${port}`,
    agentSecret: SECRET,
    mediaDir: mediaRoot
  };

  console.log("--- 1. 参数守卫 ---");

  await chkRejects(
    "缺少 AGENT_SECRET 时拒绝",
    downloadVideo({ ...config, agentSecret: "" }, VIDEO_ID),
    /AGENT_SECRET/
  );
  await chkRejects(
    "videoId 格式不合法时拒绝（不发请求）",
    downloadVideo(config, "../../etc/passwd"),
    /videoId/
  );
  chk("非法 id 没有发出任何请求", seen.length, 0);

  console.log("--- 2. 正常下载 ---");

  const downloaded = await downloadVideo(config, VIDEO_ID);

  chk("落盘路径为 <mediaDir>/<videoId>/<safeName>", downloaded.localPath, resolve(mediaRoot, VIDEO_ID, SAFE_NAME));
  chk("返回的文件名", downloaded.safeName, SAFE_NAME);
  chk("返回的字节数", downloaded.sizeBytes, BODY.length);

  chk("请求路径正确", seen[0].url, `/api/agent/videos/${VIDEO_ID}`);
  chk("带上了 Bearer 密钥", seen[0].authorization, `Bearer ${SECRET}`);

  const written = await readFile(downloaded.localPath);
  chk("内容与服务器一致", createHash("sha256").update(written).digest("hex"), GOOD_SHA);

  console.log("--- 3. 校验失败必须清理 ---");

  modeRef.value = "badsha";
  await chkRejects("sha256 不一致时抛错", downloadVideo(config, VIDEO_ID), /校验失败/);

  let leftover = [];
  try {
    leftover = await readdir(resolve(mediaRoot, VIDEO_ID));
  } catch {
    leftover = ["<目录不存在>"];
  }
  chk("校验失败后半截文件被删除", leftover, ["<目录不存在>"]);

  console.log("--- 4. 响应头缺失或不可信 ---");

  modeRef.value = "noname";
  await chkRejects("缺少 X-Video-Name 时抛错", downloadVideo(config, VIDEO_ID), /X-Video-Name/);

  modeRef.value = "badname";
  await chkRejects("文件名含路径穿越时抛错", downloadVideo(config, VIDEO_ID), /不安全/);

  leftover = [];
  try {
    leftover = await readdir(resolve(mediaRoot, VIDEO_ID));
  } catch {
    leftover = ["<目录不存在>"];
  }
  chk("不安全文件名未落盘", leftover, ["<目录不存在>"]);

  console.log("--- 5. 服务端错误 ---");

  modeRef.value = "unauthorized";
  await chkRejects("401 时抛出服务端给的原因", downloadVideo(config, VIDEO_ID), /凭证无效/);

  modeRef.value = "missing";
  await chkRejects("404 时抛出服务端给的原因", downloadVideo(config, VIDEO_ID), /视频不存在/);

  modeRef.value = "ok";

  console.log("--- 6. 清理本地暂存 ---");

  const again = await downloadVideo(config, VIDEO_ID);
  chk("重新下载成功（可复用同一 id）", (await stat(again.localPath)).isFile(), true);

  await removeDownloadedVideo(config, VIDEO_ID);
  await chkRejects("清理后文件不存在", readFile(again.localPath), /ENOENT|no such file/i);

  await removeDownloadedVideo(config, VIDEO_ID);
  chk("重复清理不报错", true, true);

  server.closeAllConnections?.();
  await new Promise((done) => server.close(done));
  await rm(mediaRoot, { recursive: true, force: true });

  console.log(`\n=========== pass=${pass}  fail=${fail} ===========`);

  // 刻意不用 process.exit()：它会在 undici/uv 资源仍在收尾时强杀进程，
  // Windows 上会打出 libuv 断言并把退出码变成 1，让「全绿」看起来像失败。
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
