#!/usr/bin/env node
import { soulHome } from '../../lib/home.mjs'
// memory.mjs —— 长期记忆：会淡忘，才记得住重要的
//
//   node memory.mjs add "用户 说他不吃香菜" --imp 4 --tag 偏好
//   node memory.mjs promise "晚上八点提醒我交表" [--at 2026-11-09] [--status 待办]
//   node memory.mjs promise --list [--all]              看未完成的约定
//   node memory.mjs promise "晚上八点提醒我交表" --done   标完成
//   node memory.mjs recall [关键词] [--n 10]
//   node memory.mjs list
//   node memory.mjs forget <id|关键词>
//   node memory.mjs decay              手动结算（一般不跑，recall 时自动算）
//
// 半衰期按重要度定：imp 1 ≈ 1 天，imp 5 ≈ 45 天。
// 淡了不删，只是越来越难被想起来 —— 这跟人的记忆一样。
// 分数 = imp * 0.5 ^ (age / 半衰期)，recall 按分数排序。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = path.join(soulHome(), "memory.json");
const argv = process.argv.slice(2);
const cmd = argv[0] ?? "recall";
const VALUED = new Set(["imp", "tag", "n"]);
// 取位置参数：跳过 --xxx 和它后面的值（否则 --n 5 里的 5 会被当成关键词）
const pos = (() => {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (VALUED.has(a.slice(2))) i++;
      continue;
    }
    out.push(a);
  }
  return out;
})();
const opt = (n, d = null) => { const i = argv.indexOf("--" + n); return i > -1 ? argv[i + 1] : d };
const now = Date.now();
const DAY = 86400 * 1000;

// 重要度 → 半衰期（天）
const HALF_DAYS = { 1: 1, 2: 3, 3: 10, 4: 25, 5: 45 };
const halfOf = (imp) => (HALF_DAYS[imp] ?? 10) * DAY;

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(j.items) ? j : { version: 1, items: [] };
  } catch { return { version: 1, items: [] } }
}
function save(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2), "utf8");
}
function score(it) {
  const age = now - new Date(it.at).getTime();
  const w = Math.pow(0.5, age / halfOf(it.imp ?? 3));
  const recallBonus = 1 + Math.min(0.6, (it.hits ?? 0) * 0.12); // 想起来过的更容易再想起
  return (it.imp ?? 3) * w * recallBonus;
}
const fmt = (it) => {
  const days = Math.floor((now - new Date(it.at).getTime()) / DAY);
  const s = score(it).toFixed(2);
  return `[${it.id}] (imp${it.imp}·${days}天前·分${s}) ${it.text}${it.tags?.length ? "  #" + it.tags.join(" #") : ""}`;
};

const db = load();

if (cmd === "promise") {
  // 约定 / 计划：单独一栏。约定考的是「进展 + 下一步」，
  // 混在流水记忆里检索出来只有半句，答不上「到哪一步了」。
  const rest = argv.slice(1)
  const wantList = rest.includes("--list")
  const all = rest.includes("--all")
  const done = rest.includes("--done")
  const atI = rest.indexOf("--at")
  const stI = rest.indexOf("--status")
  const text = rest
    .filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--at" && rest[i - 1] !== "--status")
    .join(" ")
    .trim()

  const store = load().items

  if (wantList) {
    const open = store.filter((m) => m.kind === "promise" && (all || m.status !== "完成"))
    if (!open.length) console.log("没有未完成的约定")
    else for (const m of open) {
      console.log(
        `- [${m.status || "待办"}] ${m.text}` +
        (m.at ? "  · 期限 " + m.at : "") +
        (m.progress ? "  · 进展 " + m.progress : "")
      )
    }
    process.exit(0)
  }

  if (!text) {
    console.log('用法: node memory.mjs promise "约定内容" [--at 日期] [--status 待办|进行中] [--done]')
    process.exit(1)
  }

  // 同一件事再记一次 = 更新，不新增
  const same = store.find((m) => m.kind === "promise" && m.text === text)
  if (same) {
    if (atI >= 0) same.at = rest[atI + 1]
    if (stI >= 0) same.status = rest[stI + 1]
    if (done) same.status = "完成"
    same.updatedAt = Date.now()
    save(load())
    const db2 = load()
    db2.items = store
    save(db2)
    console.log("更新约定：" + text + "（" + (same.status || "待办") + "）")
    process.exit(0)
  }

  const db3 = load()
  db3.items.push({
    id: "p" + Date.now().toString(36),
    kind: "promise",
    text,
    at: atI >= 0 ? rest[atI + 1] : null,
    status: done ? "完成" : stI >= 0 ? rest[stI + 1] : "待办",
    progress: "",
    tags: ["约定"],
    imp: 5,
    at_ts: Date.now(),
  })
  save(db3)
  console.log("记下约定：" + text + (atI >= 0 ? "（期限 " + rest[atI + 1] + "）" : ""))
  process.exit(0)

} else if (cmd === "add") {
  const text = pos.join(" ").trim();
  if (!text) { console.error('用法：node memory.mjs add "一句话" [--imp 3] [--tag 偏好]'); process.exit(2) }
  const imp = Math.max(1, Math.min(5, Number(opt("imp", 3))));
  const tag = opt("tag");
  const id = String(Date.now()).slice(-6);
  db.items.push({ id, text, imp, tags: tag ? [tag] : [], at: new Date().toISOString(), hits: 0 });
  save(db);
  console.log(`记住 [${id}] imp${imp}：${text}`);
} else if (cmd === "recall") {
  const q = pos.join(" ").trim();
  let items = db.items;
  if (q) items = items.filter((it) => (it.text + " " + (it.tags ?? []).join(" ")).includes(q));
  const top = items
    .map((it) => ({ it, s: score(it) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Number(opt("n", 10)));
  if (!top.length) { console.log("没想起来什么"); process.exit(0) }
  for (const { it } of top) {
    console.log(fmt(it));
    it.hits = (it.hits ?? 0) + 1;
  }
  save(db);
} else if (cmd === "list") {
  for (const it of db.items.slice().sort((a, b) => score(b) - score(a))) console.log(fmt(it));
  console.log(`\n共 ${db.items.length} 条`);
} else if (cmd === "forget") {
  const key = pos.join(" ").trim();
  if (!key) { console.error("要指定 id 或关键词"); process.exit(2) }
  const before = db.items.length;
  db.items = db.items.filter((it) => it.id !== key && !it.text.includes(key));
  save(db);
  console.log(`删了 ${before - db.items.length} 条`);
} else if (cmd === "decay") {
  // 只报「已经淡到想不起来」的，不删
  const faded = db.items.filter((it) => score(it) < 0.5);
  console.log(`总 ${db.items.length} 条，淡到想不起来的 ${faded.length} 条`);
  for (const it of faded) console.log("  " + fmt(it));
} else {
  console.log(`用法：
  node tools/01-memory/memory.mjs add "一句话" [--imp 1-5] [--tag 偏好]
  node tools/01-memory/memory.mjs recall [关键词] [--n 10]
  node tools/01-memory/memory.mjs list
  node tools/01-memory/memory.mjs forget <id|关键词>
  node tools/01-memory/memory.mjs decay`);
}
