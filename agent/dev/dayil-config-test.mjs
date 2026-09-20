/**
 * 养号配置回归测试。
 *
 * ── 这个测试是为了一个具体事故写的 ────────────────────────────
 *
 * 现象：从本平台下发养号后，手机上的脚本 0.003 秒就退出，报
 *
 *   invalid property id
 *   (/sdcard/AutoJS/DayilWork_run_dayil_work_....js#8)
 *
 * 原因：`scripts_renderer/buildDayilWork.js` 只替换**配置里出现过的键**：
 *
 *   for (const [key, val] of Object.entries(config)) {
 *     code = code.replace(new RegExp(`{{${key}}}`, 'g'), valueStr);
 *   }
 *
 * 模板里有 17 个 `{{占位符}}`（15 个由调用方提供，2 个由渲染器写入）。
 * 我们的界面只暴露 5 个参数，于是第 8 行留下
 * `var SWIPE_COUNT_MIN = {{SWIPE_COUNT_MIN}};` —— `{{` 是非法 token，
 * Rhino 在**解析阶段**就失败，脚本根本没开始跑。
 *
 * 修法在 `validateDayilWorkConfig`：从默认值出发，调用方给了什么就覆盖什么。
 * 本测试的三层断言：
 *
 *   1. 键覆盖 —— 15 个占位符一个都不能少（不依赖 autojs 仓库，任何机器都能跑）
 *   2. 真实渲染 —— 如果本机有 autojs 仓库，就按渲染器的逻辑生成一遍，
 *      断言**没有残留 `{{`** 且结果**能被 JS 引擎解析**
 *   3. 反向证据 —— 只用界面的 5 个键渲染，必须留下 `{{`（证明这个测试
 *      真的能抓住那个 bug，而不是永远通过）
 *
 * 运行：
 *   cd agent
 *   node dev/dayil-config-test.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { validateDayilWorkConfig } from "../src/autojs/autojs-validation.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 模板里由**调用方**提供的 15 个占位符（另 2 个 SCRIPT_RUN_ID / SCRIPT_TYPE 由渲染器写入） */
const CALLER_PLACEHOLDERS = [
  "SWIPE_COUNT",
  "SWIPE_COUNT_MIN",
  "SWIPE_COUNT_MAX",
  "PLAY_DURATION",
  "LIKE_PROBABILITY",
  "FOLLOW_PROBABILITY",
  "COMMENT_PROBABILITY",
  "FAVORITE_PROBABILITY",
  "SEARCH_PROBABILITY",
  "WAIT_AFTER_SEARCH",
  "LIVE_WATCH_DURATION",
  "SEARCH_KEYWORDS",
  "TALK_CONTENT",
  "TARGET_ACCOUNTS",
  "LIVE_CHAT_CONTENT"
];

/** 界面「养号参数」实际会发的 5 个键（事故现场） */
const UI_KEYS = {
  SWIPE_COUNT: 30,
  PLAY_DURATION: 5000,
  LIKE_PROBABILITY: 20,
  FOLLOW_PROBABILITY: 5,
  COMMENT_PROBABILITY: 0
};

/** autojs 仓库里的模板；不在本机时跳过「真实渲染」那层 */
// 本文件在 <projects>/remote-phone-control/agent/dev/，模板在 <projects>/autojs-controller/
const TEMPLATE_PATH =
  process.env.TEST_DAYIL_TEMPLATE ??
  join(__dirname, "..", "..", "..", "autojs-controller", "scripts", "DayilWork_template.js");

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

/** 复刻 buildDayilWork 的替换逻辑（含它自己写入的两个 meta 键） */
function render(template, config) {
  let code = template;
  const full = { ...config, SCRIPT_RUN_ID: "test_run", SCRIPT_TYPE: "dayil_work" };

  for (const [key, val] of Object.entries(full)) {
    const valueStr = typeof val === "object" ? JSON.stringify(val, null, 2) : val;
    code = code.replace(new RegExp(`{{${key}}}`, "g"), valueStr);
  }

  return code;
}

function leftovers(code) {
  return [...new Set(code.match(/\{\{[A-Z_]+\}\}/g) ?? [])].sort();
}

function parses(code) {
  try {
    // 只解析、不执行：模板用的是 ES5 语法，Node 能解析就说明没有语法错误
    // eslint-disable-next-line no-new-func
    new Function(code);
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function main() {
  console.log("--- 1. 空配置必须补齐全部占位符 ---");

  const empty = validateDayilWorkConfig(undefined);
  chk("空配置校验通过", empty.ok, true);

  if (empty.ok) {
    const missing = CALLER_PLACEHOLDERS.filter((key) => !(key in empty.value));
    chk("15 个占位符一个不缺", missing, []);
    chk("数值键是数字", typeof empty.value.SWIPE_COUNT, "number");
    chk("列表键是数组", Array.isArray(empty.value.SEARCH_KEYWORDS), true);
  }

  console.log("--- 2. 调用方的值必须覆盖默认值 ---");

  const custom = validateDayilWorkConfig({ SWIPE_COUNT: 30, COMMENT_PROBABILITY: 0 });
  chk("定制值生效", custom.ok && custom.value.SWIPE_COUNT, 30);
  chk("0 也算有效值（不能被默认值吃掉）", custom.ok && custom.value.COMMENT_PROBABILITY, 0);
  chk("未提供的键仍是默认值", custom.ok && custom.value.SWIPE_COUNT_MAX, 6);

  console.log("--- 3. 默认值不能被调用方污染 ---");

  const first = validateDayilWorkConfig({});
  if (first.ok) {
    first.value.SEARCH_KEYWORDS.push("被污染的项");
  }
  const second = validateDayilWorkConfig({});
  chk("第二次调用拿到干净的数组", second.ok && second.value.SEARCH_KEYWORDS, ["technology", "music", "travel"]);

  console.log("--- 4. 安全性质没被削弱 ---");

  chk("未知键仍被拒绝", validateDayilWorkConfig({ EVIL: 1 }).ok, false);
  chk("数值键传字符串仍被拒绝", validateDayilWorkConfig({ SWIPE_COUNT: "30; code" }).ok, false);
  chk("超范围仍被拒绝", validateDayilWorkConfig({ SWIPE_COUNT: 999999 }).ok, false);
  chk("列表键传非数组仍被拒绝", validateDayilWorkConfig({ SEARCH_KEYWORDS: "x" }).ok, false);

  console.log("--- 5. 真实模板渲染 ---");

  if (!existsSync(TEMPLATE_PATH)) {
    console.log(`  SKIP  找不到 autojs 模板（${TEMPLATE_PATH}）`);
    console.log("        这一层只有在同机存在 autojs-controller 仓库时才跑。");
  } else {
    const template = readFileSync(TEMPLATE_PATH, "utf8");

    // 模板里到底有多少占位符，和我们的清单对一遍，防止模板以后新增
    const inTemplate = [...new Set(template.match(/\{\{[A-Z_]+\}\}/g) ?? [])]
      .map((token) => token.slice(2, -2))
      .filter((key) => !["SCRIPT_RUN_ID", "SCRIPT_TYPE"].includes(key))
      .sort();
    chk("模板占位符清单与本测试一致", inTemplate, [...CALLER_PLACEHOLDERS].sort());

    const validated = validateDayilWorkConfig(UI_KEYS);
    chk("界面那 5 个键 + 补默认值后校验通过", validated.ok, true);

    if (validated.ok) {
      const code = render(template, validated.value);
      chk("渲染后没有残留占位符", leftovers(code), []);
      chk("渲染结果能被 JS 引擎解析（无语法错误）", parses(code), "ok");
      chk("用户要的滑动次数被保留", code.includes("var SWIPE_COUNT = 30;"), true);
    }

    // 反向证据：只用界面那 5 个键渲染，必须留下占位符 —— 证明这测试抓得住 bug
    const partial = render(template, UI_KEYS);
    const leftoverTokens = leftovers(partial);
    chk("只用界面 5 个键会留下占位符（事故可复现）", leftoverTokens.length > 0, true);
    chk("事故点正是 SWIPE_COUNT_MIN", leftoverTokens.includes("{{SWIPE_COUNT_MIN}}"), true);

    const brokenLine = partial.split("\n").findIndex((line) => line.includes("{{SWIPE_COUNT_MIN}}")) + 1;
    chk("而且就在第 8 行（与手机报错一致）", brokenLine, 8);
    chk("这样渲染出的脚本无法解析（手机报 invalid property id 的原因）", parses(partial) === "ok", false);
  }

  console.log(`\n=========== pass=${pass}  fail=${fail} ===========`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main();
