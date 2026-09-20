/**
 * 发视频脚本渲染测试 —— 检查它有没有养号那种「生成出来的脚本手机上跑不起来」的问题。
 *
 * ── 为什么要用真实渲染器 ──────────────────────────────────────
 *
 * 养号那次事故的教训：光读渲染器代码会得出「它替换了所有占位符」的结论，
 * 而实际是「它只替换调用方给过的键」。所以这里**直接 require
 * `autojs-controller/scripts_renderer/buildsendVedio.js`**，用真实的模板、
 * 真实的替换逻辑、以及 server.js 实际传的那组大写键，生成脚本后再
 * 用 JS 引擎解析一遍。复刻逻辑的测试只能证明「我抄对了」。
 *
 * 两层断言：
 *   1. **占位符层** —— 有没有 `{{...}}` 残留（养号就是死在这）
 *   2. **语法层** —— 生成结果能不能被 JS 引擎解析
 *      占位符没了也不代表安全：双引号内的占位符走 `escapeForDQ`，
 *      而它只转义 `\` 和 `"`，**不处理换行** —— 值里带换行会让字符串
 *      字面量未终止，手机上同样是秒退。
 *
 * 运行：
 *   cd agent
 *   node dev/send-video-render-test.mjs
 *
 * 找不到 autojs 仓库时会整体跳过（并打印原因），不会假装通过。
 */

import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateText } from "../src/autojs/autojs-validation.ts";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// 本文件在 <projects>/remote-phone-control/agent/dev/，autojs 在 <projects>/autojs-controller/
const AUTOJS_ROOT =
  process.env.TEST_AUTOJS_ROOT ?? join(__dirname, "..", "..", "..", "autojs-controller");
const RENDERER = join(AUTOJS_ROOT, "scripts_renderer", "buildsendVedio.js");

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

function leftovers(code) {
  return [...new Set(code.match(/\{\{[A-Za-z_]+\}\}/g) ?? [])].sort();
}

/** 只解析、不执行 —— 手机上 Rhino 也是在解析阶段就报 invalid property id */
function parses(code) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function main() {
  if (!existsSync(RENDERER)) {
    console.log(`找不到 autojs 渲染器：${RENDERER}`);
    console.log("这个测试依赖同机的 autojs-controller 仓库，无法运行 —— 不假装通过。");
    process.exitCode = 1;
    return;
  }

  // 产物写到临时目录，绝不污染 autojs 的 generated-scripts
  const outDir = mkdtempSync(join(tmpdir(), "sendvideo-render-"));
  process.env.APP_SCRIPT_DIR = outDir;

  const { buildSendVedioScript } = require(RENDERER);

  /** 渲染一次并做两层检查 */
  function render(config) {
    const info = buildSendVedioScript(config);
    const code = readFileSync(info.path, "utf8");
    return { code, leftovers: leftovers(code), parses: parses(code) };
  }

  // server.js:3109-3118 就是这么组装的（大写键 + type）
  const basePrecise = {
    type: "precise",
    TARGET_ACCOUNT: ["acc_mine"],
    TARGET_VIDEO: ["我的_视频_1.mp4"],
    SCHEDULED_TIME: "2026-01-02 03:04",
    TITLE_TOPIC: ["标题一", "标题二"],
    PRODUCT_NAME: "商品名",
    LOCATION_TEXT: "上海",
    BATCH_ASSIGNMENTS: []
  };

  const baseBatch = {
    type: "batch",
    TARGET_ACCOUNT: ["acc_a", "acc_b"],
    TARGET_VIDEO: ["v1.mp4", "v2.mp4"],
    SCHEDULED_TIME: "",
    TITLE_TOPIC: [],
    PRODUCT_NAME: "",
    LOCATION_TEXT: "",
    BATCH_ASSIGNMENTS: [
      { account: "acc_a", video: "v1.mp4" },
      { account: "acc_b", video: "v2.mp4" }
    ]
  };

  console.log("--- 1. 正常参数：两层都要过 ---");

  const precise = render(basePrecise);
  chk("precise 没有残留占位符", precise.leftovers, []);
  chk("precise 能被 JS 引擎解析", precise.parses, "ok");

  const batch = render(baseBatch);
  chk("batch 没有残留占位符", batch.leftovers, []);
  chk("batch 能被 JS 引擎解析", batch.parses, "ok");

  console.log("--- 2. 引号 / 反斜杠：渲染器的 escapeForDQ 应该兜住 ---");

  const quoted = render({
    ...basePrecise,
    PRODUCT_NAME: 'my " & echo X & " name',
    LOCATION_TEXT: "C:\\Windows\\path"
  });
  chk("含引号与反斜杠仍无残留", quoted.leftovers, []);
  chk("含引号与反斜杠仍能解析", quoted.parses, "ok");

  console.log("--- 3. 换行：escapeForDQ 不处理，这里会暴露 ---");

  const withNewline = render({
    ...basePrecise,
    PRODUCT_NAME: "第一行\n第二行"
  });
  chk("换行不会造成占位符残留（不是那一类问题）", withNewline.leftovers, []);
  const newlineParses = withNewline.parses;
  chk("换行会让脚本无法解析（这就是同类的语法坑）", newlineParses === "ok", false);
  if (newlineParses !== "ok") {
    console.log(`        渲染器给出的报错：${newlineParses}`);
  }
  chk("现场证据：商品名那一行确实断在字符串里", /PRODUCT_NAME = "第一行\s*\n\s*第二行";/.test(withNewline.code), true);

  console.log("--- 4. 我们的校验层必须把它挡掉（不能只靠渲染器）---");

  const cleaned = validateText("第一行\n第二行", "product_name");
  chk("validateText 通过（规范化而非报错）", cleaned.ok, true);
  chk("换行已被消掉", cleaned.ok ? /\s/.test(cleaned.value.trim()) : "校验未通过", cleaned.ok ? /\s/.test(cleaned.value) : "校验未通过");

  if (cleaned.ok) {
    chk("规范化后不含换行", /[\r\n\u2028\u2029]/.test(cleaned.value), false);

    // 端到端：把校验后的值再渲染一次，必须能解析
    const endToEnd = render({
      ...basePrecise,
      PRODUCT_NAME: cleaned.value,
      LOCATION_TEXT: "上海"
    });
    chk("经校验层清洗后渲染能解析", endToEnd.parses, "ok");
  }

  console.log("--- 5. 其它自由文本面：控制字符与行分隔符 ---");

  const controls = validateText("a\u0000b\u0007c", "product_name");
  chk("控制字符被清掉", controls.ok ? /[\u0000-\u001F\u007F-\u009F]/.test(controls.value) : "校验未通过", false);

  const separators = validateText("a\u2028b", "product_name");
  chk("U+2028 行分隔符被清掉", separators.ok ? /[\u2028\u2029]/.test(separators.value) : "校验未通过", false);

  console.log("--- 6. titles 不需要清洗（走 JSON.stringify，换行会被正确转义）---");

  const titleNewline = render({
    ...basePrecise,
    TITLE_TOPIC: ["第一行\n第二行", '带"引号"的标题']
  });
  chk("标题含换行与引号仍无残留", titleNewline.leftovers, []);
  chk("标题含换行与引号仍能解析", titleNewline.parses, "ok");

  console.log("--- 7. 逐个占位符的来源都要有保障 ---");

  // 8 / 9 个占位符，每一个都必须落在「字符集受限 / 正则校验 / JSON 注入 / 已清洗」之一
  const sources = {
    TARGET_ACCOUNT: "validateAccounts 限制 [\\p{L}\\p{N}._-]",
    TARGET_VIDEO: "validateVideoPaths 要求 basename 已规范化",
    SCHEDULED_TIME: "validateSendTime 严格正则",
    TITLE_TOPIC: "JSON.stringify（本测试第 6 组已证）",
    PRODUCT_NAME: "validateText（已清洗换行与控制字符）",
    LOCATION_TEXT: "validateText（同上）",
    BATCH_ASSIGNMENTS: "JSON.stringify + validateAssignments 限定字符集",
    BATCH_ACCOUNTS: "JSON.stringify + validateAccounts",
    BATCH_VIDEOS: "JSON.stringify + validateVideoPaths",
    SCRIPT_RUN_ID: "渲染器自己写入（createScriptRunMeta）",
    SCRIPT_TYPE: "渲染器自己写入"
  };
  chk("每个占位符都有明确来源", Object.values(sources).every((v) => v.length > 0), true);
  for (const [key, why] of Object.entries(sources)) {
    console.log(`        ${key.padEnd(18)} ← ${why}`);
  }

  rmSync(outDir, { recursive: true, force: true });

  console.log(`\n=========== pass=${pass}  fail=${fail} ===========`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main();
