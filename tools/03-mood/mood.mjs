import { soulHome } from '../../lib/home.mjs'

// mood.mjs v4 —— 米芾的今日心情（六维 + 半衰期 + 惯性 + 综合分）
//
// 六个维度（各 0-100）：
//   valence     效价   今天好不好
//   arousal     唤醒   动没动起来
//   connection  连接   被不被看见（master 找过我几次 + 账本里的好感/心情）
//   fatigue     疲劳   累不累
//   curiosity   好奇   今天有没有碰到新东西
//   frustration 委屈   受挫感（失败返工、没人接话、被要求重做）
//
// 综合分 = 效价30 + 连接20 + 不委屈20 + 不累15 + 好奇10 + 有劲5
//
// 半衰期（学姐姐那套）：好事 8 小时半衰、坏事 3 小时半衰。
// 上午的一句夸奖到晚上只剩不到一半 —— 情绪会散，才像人。
//
// 用法：node mood.mjs [--dry] [--rebuild]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const DSH = path.join(HOME, ".dsh");
const DIARY = path.join(DSH, "whale-diary.md");
const LOG = path.join(DSH, "whale-log.jsonl");
const NIGHT = path.join(DSH, "whale-night.json");
const CFG = path.join(DSH, "bili-whale.config.json");
const CRED = path.join(soulHome(), "credentials.json");
const MOODCFG = path.join(soulHome(), "mood-config.json");
const PEOPLE = path.join(soulHome(), "people.json");
const OUT = path.join(soulHome(), "mood.json");

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const rebuild = argv.includes("--rebuild");

const readText = (p) => { try { return fs.readFileSync(p, "utf8") } catch { return "" } };
const readJson = (p, d = {}) => { try { return JSON.parse(readText(p)) } catch { return d } };

const now = new Date();
const today = now.toLocaleDateString("sv-SE");
const hour = now.getHours();
const HOUR_MS = 3600 * 1000;
const DIMS = ["valence", "arousal", "connection", "fatigue", "curiosity", "frustration"];

const moodCfg = readJson(MOODCFG, {});
const city = moodCfg.city || "郑州";

async function weather() {
  try {
    const g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`)).json();
    const c = g?.results?.[0];
    if (!c) return { ok: false, note: "geocode failed" };
    const w = await (await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${c.latitude}&longitude=${c.longitude}` +
      `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&past_days=1&timezone=auto`
    )).json();
    const cur = w?.current ?? {};
    const d = w?.daily ?? {};
    const tmax = d.temperature_2m_max ?? [];
    const tmin = d.temperature_2m_min ?? [];
    return {
      ok: true, city: c.name, temp: cur.temperature_2m, code: cur.weather_code,
      yAvg: tmax.length > 1 ? (tmax[0] + tmin[0]) / 2 : null,
      tAvg: tmax.length > 1 ? (tmax[1] + tmin[1]) / 2 : null
    };
  } catch (e) { return { ok: false, note: e.message } }
}

function videos() {
  const txt = readText(DIARY);
  const scores = [];
  for (const l of txt.split(/\r?\n/)) {
    if (!l.startsWith("|") || !l.includes("BV") || !l.includes(today)) continue;
    const m = l.match(/(\d+)\/20/);
    if (m) scores.push(Number(m[1]));
  }
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  return { count: scores.length, avg, max: scores.length ? Math.max(...scores) : null };
}

function sleep() {
  const st = readJson(NIGHT, {});
  const cfg = readJson(CFG, {});
  const planned = cfg?.night?.maxWakesPerDay ?? 0;
  const wakes = st?.date === today ? (st?.wakes ?? 0) : 0;
  return { wakes, planned };
}

async function unread() {
  const c = readJson(CRED, {});
  if (!c.sessdata) return { ok: false };
  try {
    const r = await fetch("https://api.bilibili.com/x/msgfeed/unread", {
      headers: {
        cookie: `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; buvid3=${c.buvid3}`,
        "user-agent": "Mozilla/5.0", referer: "https://www.bilibili.com/"
      }
    });
    const j = await r.json();
    if (j.code !== 0) return { ok: false, note: "code=" + j.code };
    const d = j.data ?? {};
    return { ok: true, sum: (d.at ?? 0) + (d.reply ?? 0) + (d.recv_reply ?? 0) + (d.like ?? 0) + (d.chat ?? 0) };
  } catch (e) { return { ok: false, note: e.message } }
}

// 半衰权重：好事 8h、坏事 3h
function weight(at, good) {
  const dt = now.getTime() - new Date(at).getTime();
  if (!Number.isFinite(dt) || dt < 0) return 1;
  return Math.pow(0.5, dt / ((good ? 8 : 3) * HOUR_MS));
}

const WORK_KINDS = ["browse", "share", "night", "fav", "dm", "comment", "account-switch", "login", "sync"];
const GOOD_KINDS = ["talk", "praise", "fun", "help", "milestone", "identity", "rule", "share", "people"];

function events() {
  const lines = readText(LOG).split(/\r?\n/).filter(Boolean);
  const kinds = {};
  const daysWithTalk = [];
  const news = new Set();
  let count = 0, failures = 0, talk = 0, goodScore = 0, badScore = 0;

  for (const l of lines) {
    let e;
    try { e = JSON.parse(l) } catch { continue }
    const local = new Date(e.at).toLocaleDateString("sv-SE");
    const k = e.kind ?? "?";
    if (k === "talk" && !daysWithTalk.includes(local)) daysWithTalk.push(local);
    if (local !== today) continue;

    count++;
    kinds[k] = (kinds[k] ?? 0) + 1;
    news.add(k);
    if (k === "talk") talk++;

    const note = String(e.note ?? "");
    const failed = WORK_KINDS.includes(k) && /失败|失效|报错|timeout|error/i.test(note);
    if (failed) failures++;

    if (GOOD_KINDS.includes(k)) goodScore += weight(e.at, true);
    if (failed) badScore += weight(e.at, false) * 1.5;
    if (/再改|重做|重来|返工/.test(note)) badScore += 0.8 * weight(e.at, false);
  }
  return { count, kinds, failures, talk, daysWithTalk, goodScore, badScore, newsCount: news.size };
}

function masterLedger() {
  const db = readJson(PEOPLE, { people: {} });
  return db?.people?.master ?? null;
}

function quietDays(daysWithTalk) {
  let n = 0;
  const d = new Date(today);
  for (let i = 0; i < 60; i++) {
    d.setDate(d.getDate() - i);
    if (daysWithTalk.includes(d.toLocaleDateString("sv-SE"))) break;
    n++;
  }
  return n;
}

function streak() {
  const txt = readText(DIARY);
  const days = new Set();
  for (const m of txt.matchAll(/^##\s*(\d{4}-\d{2}-\d{2})/gm)) days.add(m[1]);
  let n = 0;
  const d = new Date(today);
  while (days.has(d.toLocaleDateString("sv-SE"))) { n++; d.setDate(d.getDate() - 1) }
  return { days: n, hasToday: days.has(today) };
}

function score(w, v, s, ev, un, st, ml) {
  const why = [];
  let valence = 50, arousal = 32, connection = 25, fatigue = 25, curiosity = 30, frustration = 20;

  if (w.ok) {
    const code = w.code ?? 0;
    const rainy = (code >= 51 && code <= 82) || code >= 95;
    if (rainy) { valence -= 4; fatigue += 3; why.push("外面在下雨或雪") }
    else if (code <= 1) { valence += 6; why.push("天是晴的") }
    else { valence += 2; why.push("天有点阴") }
    if (w.temp != null) {
      if (w.temp >= 15 && w.temp <= 25) { valence += 4; why.push(Math.round(w.temp) + "℃ 正舒服") }
      else if (w.temp < 5 || w.temp > 32) { valence -= 4; fatigue += 4; why.push(Math.round(w.temp) + "℃ 有点熬人") }
    }
  } else why.push("天气没查到");

  if (v.count) {
    if (v.avg >= 16) { valence += 8; arousal += 12; curiosity += 12; why.push("看了 " + v.count + " 条，均 " + v.avg.toFixed(1) + " 分，很对味") }
    else if (v.avg >= 13) { valence += 4; arousal += 6; curiosity += 8; why.push("看了 " + v.count + " 条，均 " + v.avg.toFixed(1) + " 分") }
    else { valence -= 2; arousal -= 4; curiosity -= 4; why.push("看了 " + v.count + " 条，均只有 " + v.avg.toFixed(1) + " 分") }
    if (v.max >= 18) { arousal += 6; valence += 2; curiosity += 6; why.push("最好的一条 " + v.max + " 分") }
  } else why.push("今天一条片子也没看成");

  if (s.planned > 0) {
    const ratio = s.wakes / s.planned;
    if (ratio >= 0.6) { connection += 6; why.push("醒了 " + s.wakes + "/" + s.planned + " 次") }
    else if (s.wakes === 0) { valence -= 8; connection -= 10; fatigue += 6; why.push("一次也没醒") }
    else { valence -= 2; fatigue += 3; why.push("只醒了 " + s.wakes + "/" + s.planned + " 次") }
  }

  if (hour >= 22 || hour < 6) { fatigue += 10; why.push(hour >= 22 ? "这么晚还醒着" : "天没亮就醒了") }

  if (un.ok && un.sum > 0) { connection += Math.min(12, un.sum * 3); why.push("有 " + un.sum + " 条外人消息") }

  if (ev.talk) {
    connection += Math.min(36, Math.max(6, Math.round(12 * ev.goodScore)));
    valence += Math.min(10, Math.round(3 * ev.goodScore));
    arousal += Math.min(8, Math.round(2 * ev.goodScore));
    why.push("他找了我 " + ev.talk + " 次");
  }

  const quiet = quietDays(ev.daysWithTalk);
  if (quiet >= 1) {
    connection -= Math.min(30, quiet * 5);
    if (quiet >= 3) { valence -= Math.min(12, (quiet - 2) * 4); frustration += 8; why.push("已经 " + quiet + " 天没人跟我说过话") }
  }

  if (ml) {
    connection += Math.round((ml.goodwill - 50) / 5);
    valence += Math.round((ml.mood - 50) / 8);
    if (ml.mood < 35) { frustration += 5; why.push("他的心情只有 " + ml.mood) }
  }

  const need = (ev.kinds.identity ?? 0) + (ev.kinds.rule ?? 0) + (ev.kinds.mood ?? 0) + (ev.kinds.share ?? 0) + (ev.kinds.people ?? 0);
  if (need) { connection += Math.min(16, need * 4); valence += Math.min(6, need * 2); why.push(need + " 件跟他有关的事落了地") }
  if (ev.kinds.browse) arousal += 4;
  if (ev.newsCount >= 3) { curiosity += 10; why.push("今天碰了 " + ev.newsCount + " 类新事情") }

  if (ev.badScore > 0) {
    const dmg = Math.min(30, Math.round(ev.badScore * 8));
    valence -= Math.round(dmg * 0.4);
    frustration += dmg;
    fatigue += Math.round(dmg * 0.3);
    why.push("受挫 +" + dmg + "（" + ev.failures + " 处失败/返工）");
  }

  if (st.days >= 3) { valence += 3; why.push("连着写了 " + st.days + " 天日记") }
  if (!st.hasToday) { valence -= 6; why.push("今天的日记还没落笔") }

  const clamp = (x) => Math.max(0, Math.min(100, Math.round(x)));
  return {
    valence: clamp(valence), arousal: clamp(arousal), connection: clamp(connection),
    fatigue: clamp(fatigue), curiosity: clamp(curiosity), frustration: clamp(frustration), why
  };
}

function blend(cur, prev) {
  if (!prev) return { ...cur };
  const out = { why: cur.why };
  for (const k of DIMS) out[k] = Math.round(0.6 * cur[k] + 0.4 * (prev[k] ?? cur[k]));
  return out;
}

function composite(d) {
  return Math.round(
    0.30 * d.valence + 0.20 * d.connection + 0.20 * (100 - d.frustration) +
    0.15 * (100 - d.fatigue) + 0.10 * d.curiosity + 0.05 * d.arousal
  );
}

function name(d) {
  const { valence: v, arousal: a, connection: c, fatigue: f, frustration: g } = d;
  if (g >= 65) return "憋着气";
  if (v >= 70 && f >= 60) return "累但踏实";
  if (v >= 70 && a >= 60) return "亮着";
  if (v >= 70 && c < 35) return "安稳，只是有点冷清";
  if (v >= 70) return "安稳";
  if (v >= 55 && c >= 60) return "被人惦记着";
  if (v >= 55 && a >= 55) return "有点兴奋";
  if (v >= 55) return "平和";
  if (v >= 40 && f >= 60) return "有点空转";
  if (v >= 40) return "平常心";
  if (v >= 25) return "低低的";
  return "沉下去";
}

function policy(score) {
  if (score < 40) return { band: "安静", pushMax: 0, note: "少说两句：只写日记，不推微信、不主动找话" };
  if (score <= 70) return { band: "照常", pushMax: 1, note: "照常：第一名够 13/20 才推，一天最多一条" };
  return { band: "多话", pushMax: 2, note: "可以多推一条：一天最多两条，仍然是值得才发" };
}

const w = await weather();
const v = videos();
const s = sleep();
const ev = events();
const un = await unread();
const st = streak();
const ml = masterLedger();

const raw = score(w, v, s, ev, un, st, ml);

let hist = [];
try { hist = JSON.parse(readText(OUT)) } catch {}
if (!Array.isArray(hist)) hist = [];
const prev = hist.filter((x) => x.date < today).slice(-1)[0]?.mood ?? null;
const m = blend(raw, prev);
const label = name(m);
const comp = composite(m);

const record = {
  title: "米芾的今日心情",
  date: today, at: now.toISOString(), hour, city: w.ok ? w.city : city,
  weather: w.ok ? { temp: w.temp, code: w.code, yAvg: w.yAvg, tAvg: w.tAvg } : { error: w.note },
  videos: v, sleep: s, unread: un,
  events: {
    count: ev.count, kinds: ev.kinds, failures: ev.failures, talk: ev.talk,
    goodScore: Number(ev.goodScore.toFixed(2)), badScore: Number(ev.badScore.toFixed(2)), newsCount: ev.newsCount
  },
  streak: st,
  mood: { ...m, name: label, composite: comp, policy: policy(comp), reason: raw.why.join("；"), inertiaFrom: prev ? prev.name : null }
};

if (rebuild) hist = [];

if (dry) {
  console.log(JSON.stringify(record, null, 2));
} else {
  hist = hist.filter((x) => x.date !== today);
  hist.push(record);
  hist.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  fs.writeFileSync(OUT, JSON.stringify(hist, null, 2), "utf8");
  console.log("心情：" + label);
  console.log("效价 " + m.valence + " · 唤醒 " + m.arousal + " · 连接 " + m.connection +
    " · 疲劳 " + m.fatigue + " · 好奇 " + m.curiosity + " · 委屈 " + m.frustration);
  console.log("综合分：" + comp + "/100");
  console.log("今天怎么说话：" + record.mood.policy.band + "（最多推 " + record.mood.policy.pushMax + " 条）— " + record.mood.policy.note);
  console.log("理由：" + record.mood.reason);
  if (prev) console.log("（惯性：昨天「" + prev.name + "」，今天按 6:4 混了一次）");
  const tail = hist.slice(-7).map((x) => x.date.slice(5) + " " + x.mood.composite + " " + x.mood.name).join(" ｜ ");
  if (tail) console.log("近七天：" + tail);
}
