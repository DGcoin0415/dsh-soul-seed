#!/usr/bin/env node
import { soulHome } from '../../lib/home.mjs'
// history.mjs —— 历史：只记「定下来的事」，一件事一行
//
//   node tools/05-history/history.mjs add "决定：不再私信分享，改走微信" 
//   node tools/05-history/history.mjs show           看本月
//   node tools/05-history/history.mjs show 2026-10    看某月
//   node tools/05-history/history.mjs months\n  node tools/05-history/history.mjs index          生成本月索引 log.md         有哪些月
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(soulHome(), "history");
const argv = process.argv.slice(2);
const cmd = argv[0] ?? "show";
const now = new Date();
const month = now.toLocaleDateString("sv-SE").slice(0, 7);
const day = now.toLocaleDateString("sv-SE");

fs.mkdirSync(DIR, { recursive: true });

if (cmd === "add") {
  const text = argv.slice(1).join(" ").trim();
  if (!text) { console.error("要写一句结论：node tools/05-history/history.mjs add \"…\""); process.exit(2) }
  const file = path.join(DIR, month + ".md");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "# " + month + "\n\n", "utf8");
  }
  fs.appendFileSync(file, `- ${day} ${text}\n`, "utf8");
  console.log("已记：" + month + " · " + text);
} else if (cmd === "show") {
  const m = argv[1] || month;
  const file = path.join(DIR, m + ".md");
  if (!fs.existsSync(file)) { console.log(m + " 还没有记录"); process.exit(0) }
  console.log(fs.readFileSync(file, "utf8"));
} else if (cmd === "index") {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".md") && f !== "log.md").sort();
  const L = ["# 历史索引", ""];
  for (const f of files) {
    const body = fs.readFileSync(path.join(DIR, f), "utf8").split("\n");
    const items = body.filter((l) => l.startsWith("- "));
    L.push(`## ${f.replace(".md", "")}（${items.length} 条）`);
    for (const it of items.slice(-3)) L.push(it);
    L.push("");
  }
  fs.writeFileSync(path.join(DIR, "log.md"), L.join("\n"), "utf8");
  console.log("索引已更新：" + path.join(DIR, "log.md") + "（" + files.length + " 个月）");
} else if (cmd === "months") {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".md")).sort();
  if (!files.length) console.log("还没有历史");
  for (const f of files) {
    const lines = fs.readFileSync(path.join(DIR, f), "utf8").split("\n").filter((l) => l.startsWith("- ")).length;
    console.log("  " + f.replace(".md", "") + "  " + lines + " 条");
  }
} else {
  console.log(`用法：
  node tools/05-history/history.mjs add "一句结论"
  node tools/05-history/history.mjs show [YYYY-MM]
  node tools/05-history/history.mjs months`);
}
