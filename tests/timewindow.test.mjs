// tests/timewindow.test.mjs —— 时间窗口：--at / --between 真的筛掉「之后」的证据
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let bad = 0;
function ok(cond, msg) {
  console.log("  " + (cond ? "✓ " : "✗ ") + msg);
  if (!cond) bad++;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tw-"));
const shared = path.join(root, "shared");
fs.mkdirSync(path.join(shared, "索引"), { recursive: true });
fs.mkdirSync(path.join(shared, "落叶"), { recursive: true });

// 两条同主题记录：一条 4 月 1 日，一条 5 月 1 日
const idx = [
  { path: "shared/落叶/旧.md", name: "旧", summary: "地板颜色是深灰的", tags: ["地板"], line: 1, lineEnd: 3, mtime: Date.parse("2026-04-01") },
  { path: "shared/落叶/新.md", name: "新", summary: "地板颜色改成了浅色", tags: ["地板"], line: 1, lineEnd: 3, mtime: Date.parse("2026-05-01") }
].map((x) => JSON.stringify(x)).join("\n") + "\n";
fs.writeFileSync(path.join(shared, "索引", "摘要.jsonl"), idx, "utf8");

const tool = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "tools", "11-rag", "memory-find.mjs");
const env = { ...process.env, DSH_SHARED_DIR: root };

function run(args) {
  try {
    return execFileSync(process.execPath, [tool, ...args], { encoding: "utf8", env, timeout: 30000 });
  } catch (e) {
    return String(e.stdout || "") + String(e.stderr || "");
  }
}

const plain = run(["地板颜色"]);
ok(plain.includes("旧.md") && plain.includes("新.md"), "不带时间限制：两条都出来");

const before = run(["地板颜色", "--at", "2026-04-15"]);
ok(before.includes("旧.md"), "--at 2026-04-15：4 月那条还在");
ok(!before.includes("新.md"), "--at 2026-04-15：5 月那条被筛掉");

const range = run(["地板颜色", "--between", "2026-04-20..2026-06-01"]);
ok(range.includes("新.md"), "--between 区间内那条在");
ok(!range.includes("旧.md"), "--between 区间外那条被筛掉");

const shown = run(["地板颜色"]);
ok(/2026-04-01|2026-05-01/.test(shown), "证据链里带绝对日期（可核对）");

fs.rmSync(root, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
