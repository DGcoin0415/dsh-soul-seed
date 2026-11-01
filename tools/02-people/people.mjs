#!/usr/bin/env node
// people.mjs —— 按人账本 v2
//
// 每人：好感 / 心情 / 见面次数 / 事件 / 习惯 / 人情账 / 私藏
// 全局：关系网（谁跟谁熟、谁跟谁不对付）
// id 约定：master / qq:<openid> / wx:<wxid> / bili:<mid>
//
//   node people.mjs show [id]
//   node people.mjs meet <id>
//   node people.mjs bump <id> --delta 2 --why "…"
//   node people.mjs mood <id> --delta -8 --kind scold --why "…"
//   node people.mjs habit <id> --add "…"
//   node people.mjs decay
//
//   人情账：
//   node people.mjs favors add <id> --dir in|out --what "…"
//   node people.mjs favors list [id]
//   node people.mjs favors settle <id> <第几笔>
//
//   关系网：
//   node people.mjs link <a> <b> --kind 熟 --note "…"
//   node people.mjs links [id]
//
//   私藏（好感够才给看）：
//   node people.mjs secret <id> --add "…"
//   node people.mjs secret <id> --show
//
//   记仇（默认关）：
//   node people.mjs grudge add <id> --what "…" --level 1-3
//   node people.mjs grudge list
//   node people.mjs grudge chain <id> --next
//   node people.mjs grudge settle <id>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = path.join(os.homedir(), ".bili-ai", "people.json");
const SECRET_MIN_GOODWILL = 70;

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "show";
const pos = argv.slice(1).filter((a) => !a.startsWith("--"));
const opt = (name, def = null) => {
  const i = argv.indexOf("--" + name);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const now = new Date();
const ISO = () => now.toISOString();
const HOUR = 3600 * 1000;
const HALF = { neg: 3 * HOUR, pos: 8 * HOUR };

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!j.people) return { version: 2, people: {}, links: [] };
    if (!j.links) j.links = [];
    return j;
  } catch {
    return { version: 2, people: {}, links: [] };
  }
}
function save(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2), "utf8");
}
function ensure(db, id) {
  if (!db.people[id]) {
    db.people[id] = {
      id,
      nickname: id === "master" ? "master" : id,
      goodwill: 50, mood: 50, meets: 0,
      firstAt: ISO(), lastAt: ISO(),
      habits: [], events: [], favors: [], secrets: []
    };
  }
  const p = db.people[id];
  p.favors = p.favors ?? [];
  p.secrets = p.secrets ?? [];
  return p;
}
function decayPerson(p) {
  const last = new Date(p.moodAt ?? p.lastAt ?? ISO()).getTime();
  const elapsed = now.getTime() - last;
  if (elapsed <= 0) return p;
  const half = p.mood >= 50 ? HALF.pos : HALF.neg;
  p.mood = Math.round(50 + (p.mood - 50) * Math.pow(0.5, elapsed / half));
  p.moodAt = ISO();
  return p;
}
function label(m) {
  if (m >= 80) return "很高兴";
  if (m >= 65) return "不错";
  if (m >= 45) return "平静";
  if (m >= 30) return "有点不爽";
  if (m >= 15) return "烦 / 累";
  return "火大 / 难过";
}
function fmt(p, db) {
  const L = [
    `【${p.nickname}】 ${p.id}`,
    `  好感 ${p.goodwill}/100   心情 ${p.mood}/100（${label(p.mood)}）   见面 ${p.meets} 次`
  ];
  if (p.habits?.length) L.push("  习惯：" + p.habits.join("；"));
  const openFav = (p.favors ?? []).filter((f) => !f.settled);
  if (openFav.length) {
    L.push(`  人情账（未结 ${openFav.length}）：`);
    for (const f of openFav) L.push(`    · [${f.dir === "in" ? "欠着" : "他欠我"}] ${f.what}（${f.at.slice(0, 10)}）`);
  }
  const lk = (db.links ?? []).filter((l) => l.a === p.id || l.b === p.id);
  if (lk.length) {
    L.push("  关系网：");
    for (const l of lk) {
      const other = l.a === p.id ? l.b : l.a;
      L.push(`    · 与 ${other}：${l.kind}${l.note ? "（" + l.note + "）" : ""}`);
    }
  }
  if (p.secrets?.length) {
    if (p.goodwill >= SECRET_MIN_GOODWILL) {
      L.push(`  私藏（好感 ${p.goodwill} ≥ ${SECRET_MIN_GOODWILL}，可以看）：`);
      for (const s of p.secrets) L.push(`    · ${s}`);
    } else {
      L.push(`  私藏：${p.secrets.length} 条（好感 ${p.goodwill} < ${SECRET_MIN_GOODWILL}，不看）`);
    }
  }
  const ev = (p.events ?? []).slice(-3);
  if (ev.length) {
    L.push("  最近事件：");
    for (const e of ev) L.push(`    · ${e.at.slice(5, 16).replace("T", " ")} [${e.kind ?? "-"}] ${e.delta > 0 ? "+" : ""}${e.delta ?? 0}  ${e.why ?? ""}`);
  }
  return L.join("\n");
}

const db = load();
for (const p of Object.values(db.people)) decayPerson(p);

if (cmd === "show" || cmd === "list") {
  const id = pos[0];
  if (id) {
    const p = db.people[id];
    if (!p) { console.error("没有这个人：" + id); process.exit(1) }
    console.log(fmt(p, db));
  } else {
    const all = Object.values(db.people);
    if (!all.length) console.log("账本还空着（node people.mjs meet master）");
    for (const p of all) console.log(fmt(p, db) + "\n");
  }
  save(db);
} else if (cmd === "meet") {
  const id = pos[0];
  if (!id) { console.error("要指定谁"); process.exit(2) }
  const p = ensure(db, id);
  p.meets += 1; p.goodwill = Math.min(100, p.goodwill + 1); p.lastAt = ISO();
  p.events.push({ at: ISO(), kind: "meet", delta: 1, why: opt("why", "见了一面") });
  save(db);
  console.log(`记下：${p.nickname} 第 ${p.meets} 次，好感 ${p.goodwill}`);
} else if (cmd === "bump") {
  const id = pos[0];
  const delta = Number(opt("delta", 1));
  if (!id) { console.error("要指定谁"); process.exit(2) }
  const p = ensure(db, id);
  p.goodwill = Math.max(0, Math.min(100, p.goodwill + delta));
  p.lastAt = ISO();
  p.events.push({ at: ISO(), kind: opt("kind", "bump"), delta, why: opt("why", "") });
  save(db);
  console.log(`${p.nickname} 好感 ${delta > 0 ? "+" : ""}${delta} → ${p.goodwill}`);
} else if (cmd === "mood") {
  const id = pos[0];
  const delta = Number(opt("delta", 0));
  if (!id) { console.error("要指定谁"); process.exit(2) }
  const p = ensure(db, id);
  const kind = opt("kind", "mood");
  const recentSame = p.events.filter((e) => e.kind === kind && now.getTime() - new Date(e.at).getTime() < 2 * HOUR).length;
  const applied = Math.round(delta * Math.pow(0.5, recentSame));
  p.mood = Math.max(0, Math.min(100, p.mood + applied));
  p.lastAt = ISO(); p.moodAt = ISO();
  p.events.push({ at: ISO(), kind, delta: applied, why: opt("why", ""), raw: delta });
  save(db);
  console.log(`${p.nickname} 心情 ${applied > 0 ? "+" : ""}${applied} → ${p.mood}（${label(p.mood)}）` + (recentSame ? `，同类叠加减半（原始 ${delta}）` : ""));
} else if (cmd === "habit") {
  const id = pos[0];
  const add = opt("add");
  if (!id || !add) { console.error('用法：node people.mjs habit master --add "…"'); process.exit(2) }
  const p = ensure(db, id);
  p.habits = p.habits ?? [];
  if (!p.habits.includes(add)) p.habits.push(add);
  p.lastAt = ISO();
  save(db);
  console.log(`${p.nickname} 的习惯：${p.habits.join("；")}`);
} else if (cmd === "decay") {
  save(db);
  for (const p of Object.values(db.people)) console.log(`  ${p.nickname} 心情 ${p.mood}/100（${label(p.mood)}）`);
} else if (cmd === "favors") {
  const sub = pos[0];
  const id = pos[1];
  if (sub === "add") {
    const what = opt("what");
    const dir = opt("dir", "in");
    if (!id || !what) { console.error('用法：node people.mjs favors add master --dir in --what "…"'); process.exit(2) }
    const p = ensure(db, id);
    p.favors.push({ at: ISO(), dir, what, settled: false });
    save(db);
    console.log(`人情账：${p.nickname} [${dir === "in" ? "欠着" : "他欠我"}] ${what}`);
  } else if (sub === "settle") {
    const idx = Number(pos[2] ?? 0);
    if (!id) { console.error("要指定谁"); process.exit(2) }
    const p = ensure(db, id);
    const open = p.favors.filter((f) => !f.settled);
    const target = open[idx - 1];
    if (!target) { console.error("没有第 " + idx + " 笔未结的"); process.exit(1) }
    target.settled = true;
    save(db);
    console.log(`结掉了：${p.nickname} · ${target.what}`);
  } else {
    const all = id ? [ensure(db, id)] : Object.values(db.people);
    for (const p of all) {
      const open = p.favors.filter((f) => !f.settled);
      console.log(`【${p.nickname}】未结 ${open.length} 笔`);
      for (const f of open) console.log(`  · [${f.dir === "in" ? "欠着" : "他欠我"}] ${f.what}`);
    }
    save(db);
  }
} else if (cmd === "link") {
  const a = pos[0], b = pos[1];
  const kind = opt("kind", "熟");
  if (!a || !b) { console.error('用法：node people.mjs link master qq:xxx --kind 熟 --note "…"'); process.exit(2) }
  ensure(db, a); ensure(db, b);
  const exists = db.links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  if (exists) { exists.kind = kind; exists.note = opt("note", exists.note) }
  else db.links.push({ a, b, kind, note: opt("note", "") });
  save(db);
  console.log(`关系网：${a} ↔ ${b} = ${kind}`);
} else if (cmd === "links") {
  const id = pos[0];
  const list = id ? db.links.filter((l) => l.a === id || l.b === id) : db.links;
  if (!list.length) console.log("关系网还空着");
  for (const l of list) console.log(`  ${l.a} ↔ ${l.b}  ${l.kind}${l.note ? "（" + l.note + "）" : ""}`);
  save(db);
} else if (cmd === "secret") {
  const id = pos[0];
  const add = opt("add");
  if (!id) { console.error("要指定谁"); process.exit(2) }
  const p = ensure(db, id);
  if (add) {
    p.secrets.push(add);
    save(db);
    console.log(`私藏 +1：${p.nickname}（现在 ${p.secrets.length} 条）`);
  } else {
    if (p.goodwill < SECRET_MIN_GOODWILL) {
      console.log(`好感 ${p.goodwill} < ${SECRET_MIN_GOODWILL}，私藏不看。`);
      process.exit(1);
    }
    console.log(p.secrets.length ? p.secrets.map((s) => "· " + s).join("\n") : "没有私藏");
    save(db);
  }
} else if (cmd === "grudge") {
  handleGrudge(argv.slice(1))
} else {
  console.error("未知命令：" + cmd);
  process.exit(2);
}

// ═══════════ 记仇 + 报复链（原 tools/02-people/people.mjs，并进来少一个文件） ═══════════
function handleGrudge(rawArgv) {
  const GRUDGE_FILE = path.join(os.homedir(), ".bili-ai", "grudge.json");
  const argv = rawArgv;
  const cmd = argv[0] ?? "list";
  const pos = (() => {
    const out = [];
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a.startsWith("--")) { if (["what", "level", "note", "step"].includes(a.slice(2))) i++; continue }
      out.push(a);
    }
    return out;
  })();
  const opt = (n, d = null) => { const i = argv.indexOf("--" + n); return i > -1 ? argv[i + 1] : d };
  const now = Date.now();
  const DAY = 86400 * 1000;
  const TTL = { 1: 3 * DAY, 2: 10 * DAY, 3: 30 * DAY };

  function load() { try { const j = JSON.parse(fs.readFileSync(GRUDGE_FILE, "utf8")); return Array.isArray(j.items) ? j : { version: 1, items: [] } } catch { return { version: 1, items: [] } } }
  function save(db) { fs.mkdirSync(path.dirname(GRUDGE_FILE), { recursive: true }); fs.writeFileSync(GRUDGE_FILE, JSON.stringify(db, null, 2), "utf8") }

  const db = load();
  // 过期自动翻篇
  let expired = 0;
  for (const g of db.items) {
    if (g.state === "open" && now - new Date(g.at).getTime() > (TTL[g.level] ?? TTL[2])) { g.state = "faded"; expired++ }
  }

  if (cmd === "add") {
    const id = pos[0];
    const what = opt("what");
    const level = Math.max(1, Math.min(3, Number(opt("level", 1))));
    if (!id || !what) { console.error('用法：node grudge.mjs add <id> --what "…" --level 1-3'); process.exit(2) }
    db.items.push({
      id: "g" + String(Date.now()).slice(-5),
      who: id, what, level,
      at: new Date().toISOString(),
      expiresAt: new Date(now + TTL[level]).toISOString(),
      state: "open", chain: [], settledNote: null
    });
    save(db);
    console.log(`记一笔（${level} 级，${TTL[level] / DAY} 天后翻篇）：${id} —— ${what}`);
  } else if (cmd === "list") {
    const open = db.items.filter((g) => g.state === "open");
    if (!open.length) { console.log("没有未结的仇" + (expired ? `（刚翻篇 ${expired} 笔）` : "")); process.exit(0) }
    for (const g of open) {
      const left = Math.ceil((new Date(g.expiresAt).getTime() - now) / DAY);
      console.log(`[${g.id}] ${g.who} · ${g.level} 级 · 还有 ${left} 天 · ${g.what}`);
      for (const [i, s] of g.chain.entries()) console.log(`   ${i + 1}. ${s}${g.done?.includes(i) ? "（做过了）" : ""}`);
    }
    save(db);
  } else if (cmd === "settle") {
    const id = pos[0];
    const target = db.items.filter((g) => g.state === "open" && g.who === id).pop();
    if (!target) { console.error("没有这个人的未结"); process.exit(1) }
    target.state = "settled";
    target.settledNote = opt("note", "翻篇");
    save(db);
    console.log(`算了：${target.who} · ${target.what}（${target.settledNote}）`);
  } else if (cmd === "chain") {
    const id = pos[0];
    const g = db.items.filter((x) => x.state === "open" && x.who === id).pop();
    if (!g) { console.error("没有这个人的未结"); process.exit(1) }
    const step = opt("step");
    if (step) {
      if (g.chain.length >= 3) { console.error("最多三步 —— 再多就不叫报复叫纠缠了"); process.exit(1) }
      g.chain.push(step);
      save(db);
      console.log(`第 ${g.chain.length} 步：${step}`);
    } else if (argv.includes("--show")) {
      if (!g.chain.length) console.log("还没编台词");
      for (const [i, s] of g.chain.entries()) console.log(`  ${i + 1}. ${s}`);
    } else if (argv.includes("--next")) {
      const i = g.chain.findIndex((_, idx) => !(g.done ?? []).includes(idx));
      if (i < 0) { console.log("没下一步了（编完了/做完了）"); process.exit(0) }
      console.log(`下一步（第 ${i + 1} 步，**要人点头才发**）：\n  ${g.chain[i]}`);
    } else {
      console.log(`用法：
    node grudge.mjs chain <id> --step "台词"
    node grudge.mjs chain <id> --show
    node grudge.mjs chain <id> --next`);
    }
  } else if (cmd === "decay") {
    save(db);
    console.log(`未结 ${db.items.filter((g) => g.state === "open").length} 笔，本次翻篇 ${expired} 笔`);
  } else {
    console.log(`用法：
    node grudge.mjs add <id> --what "…" --level 1-3
    node grudge.mjs list
    node grudge.mjs settle <id> [--note "…"]
    node grudge.mjs chain <id> --step "…" | --show | --next
    node grudge.mjs decay`);
  }

}
