#!/usr/bin/env node
import { soulHome } from '../../lib/home.mjs'
// scene.mjs —— 现场：把「现在什么心情 / 在忙什么」落到文件里
//
//   node tools/04-scene/scene.mjs busy "在给 用户 传 GitHub 仓库"
//   node tools/04-scene/scene.mjs chat "<别人说的最后一句>"
//   node tools/04-scene/scene.mjs show
//
// 写的是给人看的一句话，不是日志。覆盖式，不追加。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(soulHome(), "scene");
const MOOD = path.join(soulHome(), "mood.json");
const argv = process.argv.slice(2);
const cmd = argv[0] ?? "show";

fs.mkdirSync(DIR, { recursive: true });
const at = new Date().toLocaleString("sv-SE");

function latestMood() {
  try {
    const h = JSON.parse(fs.readFileSync(MOOD, "utf8"));
    return h[h.length - 1]?.mood ?? null;
  } catch { return null }
}

if (cmd === "busy" || cmd === "chat") {
  const text = argv.slice(1).join(" ").trim();
  if (!text) { console.error("要写一句话"); process.exit(2) }
  fs.writeFileSync(path.join(DIR, cmd + ".md"), `# ${cmd}\n\n${text}\n\n_${at}_\n`, "utf8");
  console.log("已更新 " + cmd + ".md：" + text);
} else if (cmd === "show") {
  const m = latestMood();
  console.log("心情：" + (m ? `${m.name} ${m.composite}/100（${m.policy?.band ?? "-"}）` : "还没有记录"));
  for (const f of ["busy", "chat"]) {
    const p = path.join(DIR, f + ".md");
    if (!fs.existsSync(p)) { console.log(f + "：（空）"); continue }
    const body = fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("_"))[0] ?? "";
    console.log(f + "：" + body);
  }
} else if (cmd === "status" || cmd === "error" || cmd === "errors" || cmd === "save") {
  handleStatus(argv)
} else {
  console.log(`用法：
  node tools/04-scene/scene.mjs busy "一句话"
  node tools/04-scene/scene.mjs chat "一句话"
  node tools/04-scene/scene.mjs show
  node tools/04-scene/scene.mjs status           运行状态
  node tools/04-scene/scene.mjs error <一句话>   报错留痕`);
}

// ═══════════ 运行状态 + 报错落盘（原 tools/04-scene/scene.mjs） ═══════════
function handleStatus(rawArgv) {
  const DIR = soulHome();
  const ERR = path.join(DIR, "im-errors.ndjson");
  const STATUS_TXT = path.join(DIR, "运行状态.txt");
  const argv = rawArgv;
  const cmd = argv[0] ?? "";
  const opt = (n, d = null) => { const i = argv.indexOf("--" + n); return i > -1 ? argv[i + 1] : d };
  const now = new Date();

  const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch { return d } };
  const countLines = (p) => { try { return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).length } catch { return 0 } };

  function snapshot() {
    const moodHist = readJson(path.join(DIR, "mood.json"), []);
    const mood = Array.isArray(moodHist) && moodHist.length ? moodHist[moodHist.length - 1].mood : null;
    const people = readJson(path.join(DIR, "people.json"), { people: {} });
    const mem = readJson(path.join(DIR, "memory.json"), { items: [] });
    const flow = readJson(path.join(DIR, "scene", "busy.md"), null);
    const errs = countLines(ERR);
    const histDir = path.join(DIR, "history");
    let histMonths = 0;
    try { histMonths = fs.readdirSync(histDir).filter((f) => f.endsWith(".md")).length } catch {}

    return {
      at: now.toLocaleString("sv-SE"),
      心情: mood ? `${mood.name} ${mood.composite}/100（${mood.policy?.band ?? "-"}）` : "还没有",
      账本人数: Object.keys(people.people || {}).length,
      长期记忆: (mem.items || []).length,
      历史月份: histMonths,
      报错条数: errs,
      最近任务: flow ? fs.readFileSync(path.join(DIR, "scene", "busy.md"), "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("_"))[0] : "(空)"
    };
  }

  if (cmd === "error") {
    const text = argv.slice(1).filter((a) => !a.startsWith("--")).join(" ").trim();
    if (!text) { console.error("要写一句"); process.exit(2) }
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(ERR, JSON.stringify({ at: now.toISOString(), kind: opt("kind", "misc"), text }) + "\n", "utf8");
    console.log("已记一条报错（共 " + countLines(ERR) + " 条）");
  } else if (cmd === "errors") {
    const n = Number(opt("n", 10));
    let lines = [];
    try { lines = fs.readFileSync(ERR, "utf8").split("\n").filter(Boolean) } catch {}
    for (const l of lines.slice(-n)) {
      try { const e = JSON.parse(l); console.log(`  ${e.at.slice(5, 16).replace("T", " ")} [${e.kind}] ${e.text}`) } catch {}
    }
    if (!lines.length) console.log("没有报错记录");
  } else if (cmd === "save") {
    const s = snapshot();
    const body = Object.entries(s).map(([k, v]) => `${k}：${v}`).join("\n");
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(STATUS_TXT, "# 运行状态\n\n" + body + "\n", "utf8");
    console.log("已写：" + STATUS_TXT);
    console.log(body);
  } else {
    const s = snapshot();
    for (const [k, v] of Object.entries(s)) console.log(`${k.padEnd(6, "　")} ${v}`);
  }

}
