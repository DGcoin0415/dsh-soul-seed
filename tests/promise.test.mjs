// tests/promise.test.mjs —— 约定单独记：写入 / 列表 / 标完成
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let bad = 0;
function ok(cond, msg) {
  console.log("  " + (cond ? "✓ " : "✗ ") + msg);
  if (!cond) bad++;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "promise-"));
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const tool = path.join(here, "..", "tools", "01-memory", "memory.mjs");
const env = { ...process.env, DSH_SOUL_DIR: home };

function run(args) {
  try {
    return execFileSync(process.execPath, [tool, ...args], { encoding: "utf8", env, timeout: 20000 });
  } catch (e) {
    return String(e.stdout || "") + String(e.stderr || "");
  }
}

run(["promise", "晚上八点交表", "--at", "2026-11-09"]);
const list1 = run(["promise", "--list"]);
ok(list1.includes("晚上八点交表"), "记下的约定能列出来");
ok(list1.includes("2026-11-09"), "期限跟着一起存");
ok(list1.includes("待办"), "默认状态是待办");

run(["promise", "晚上八点交表", "--done"]);
const list2 = run(["promise", "--list"]);
ok(!list2.includes("晚上八点交表"), "标完成后不在「未完成」里");

const all = run(["promise", "--list", "--all"]);
ok(all.includes("晚上八点交表") && all.includes("完成"), "--all 能看到已完成的");

const empty = run(["promise", "再记一件"]) ;
run(["promise", "再记一件", "--done"]);
ok(run(["promise", "--list"]).includes("没有未完成") || !run(["promise", "--list"]).includes("再记一件"), "全完成时列表干净");

fs.rmSync(home, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
