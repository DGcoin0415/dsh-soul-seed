#!/usr/bin/env node
// 米萨 · 按人写的关系账本（心情 + 好感 + 记忆），不分躯体、全渠道共用一份。
// 用法：
//   node people.mjs get <key>                     看某人当前记录（没有就按全局默认建一条）
//   node people.mjs list                          列出所有人
//   node people.mjs set <key> --name 名字 --mood "一句话" --affinity 80
//   node people.mjs bump <key> --delta 2 | --value 90
//   node people.mjs note <key> "摘要" --feeling "当时的感受" --kind chat
//   node people.mjs profile <key>                 看十六格（称呼/身份/偏好/爱好/雷区/习惯/目标/关系/性格/经历/边界/近况/承诺/话题/专长/作息）
//   node people.mjs profile <key> add <维度> "内容" 往某一格记一条；del <维度> <序号> 删一条
//   node people.mjs seen <key>                    记一次见面（lastSeen + 计数）
// key 写法：qq:<openid> / wx:<wxid> / any:<任意名字>，只给纯 id 默认按 qq: 处理。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os'

const ROOT = path.join(os.homedir(), '.dsh/im/shared/people');
const FILE = path.join(ROOT, 'people.json');
const DEFAULT = { affinity: 55, mood: '平静' };

// 对一个人的认识，固定十六格。preference 格直接用 p.preferences，不另存一份。
const DIMENSIONS = {
  address: '称呼',
  identity: '身份',
  preference: '偏好',
  hobby: '爱好',
  dislike: '雷区',
  habit: '习惯',
  goal: '目标',
  relation: '关系',
  personality: '性格',
  experience: '经历',
  boundary: '边界',
  recent: '近况',
  promise: '承诺',
  topic: '话题',
  skill: '专长',
  schedule: '作息',
};
const DIM_ALIAS = Object.fromEntries(Object.entries(DIMENSIONS).flatMap(([k, v]) => [[k, k], [v, k]]));

function normKey(k) {
  const s = String(k || '').trim();
  if (!s) throw new Error('缺少 key');
  if (/^(qq|wx|any):/i.test(s)) return s.replace(/^QQ:/i, 'qq:').replace(/^WX:/i, 'wx:').replace(/^ANY:/i, 'any:');
  return 'qq:' + s;
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!j || typeof j !== 'object') throw new Error('bad');
    j.people ||= {};
    j.links ||= [];
    j.habits ||= [];
    j.masterKeys ||= ['qq:6165B9EBDDF8D6DCA298AB1746EA55A6'];
    j.grudgeThreshold ??= 30;
    j.global ||= { ...DEFAULT };
    j.version ||= 1;
    return j;
  } catch {
    return { version: 1, global: { ...DEFAULT }, people: {} };
  }
}

function save(db) {
  fs.mkdirSync(ROOT, { recursive: true });
  db.updatedAt = new Date().toISOString();
  const data = JSON.stringify(db, null, 2) + '\n';
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, data, 'utf8');
  // Windows 上杀软/别的进程可能短暂占用目标文件，重命名会 EPERM：重试，最后直接覆盖
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, FILE); return; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60); }
  }
  try { fs.writeFileSync(FILE, data, 'utf8'); } catch {}
  try { fs.unlinkSync(tmp); } catch {}
}

function ensure(db, key) {
  db.people[key] ||= {
    name: null,
    affinity: db.global.affinity ?? DEFAULT.affinity,
    mood: db.global.mood ?? DEFAULT.mood,
    firstSeen: null,
    lastSeen: null,
    encounters: 0,
    notes: [],
  };
  const p = db.people[key];
  if (!p.profile || typeof p.profile !== 'object') p.profile = {};
  for (const k of Object.keys(DIMENSIONS)) {
    if (k === 'preference') continue;
    if (!Array.isArray(p.profile[k])) p.profile[k] = [];
  }
  return p;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

function moodLabel(score) {
  if (score <= 20) return '火大';
  if (score <= 35) return '烦';
  if (score <= 45) return '有点不爽';
  if (score < 55) return '平静';
  if (score < 70) return '不错';
  if (score < 85) return '开心';
  return '特别高兴';
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const db = load();

switch (cmd) {
  case 'get': {
    const key = normKey(args._[0]);
    const p = ensure(db, key);
    save(db);
    console.log(JSON.stringify({ key, ...p, global: db.global }, null, 2));
    break;
  }
  case 'list': {
    const lines = Object.entries(db.people)
      .map(([k, p]) => `${k}\t${p.name ?? '-'}\t好感${p.affinity}\t${p.mood}\t${p.encounters}次\t${(p.notes || []).length}条记忆`)
      .sort();
    console.log(`全局默认：好感${db.global.affinity}，心情${db.global.mood}\n` + lines.join('\n'));
    break;
  }
  case 'set': {
    const key = normKey(args._[0]);
    const p = ensure(db, key);
    if (typeof args.name === 'string') p.name = args.name;
    if (typeof args.mood === 'string') p.mood = args.mood;
    if (args.affinity !== undefined) p.affinity = clamp(Number(args.affinity));
    save(db);
    console.log(`改好了：${key} 名字=${p.name ?? '-'} 好感=${p.affinity} 心情=${p.mood}`);
    break;
  }
  case 'bump': {
    const key = normKey(args._[0]);
    const p = ensure(db, key);
    const before = p.affinity;
    if (args.value !== undefined) p.affinity = clamp(Number(args.value));
    else p.affinity = clamp(before + Number(args.delta ?? 0));
    save(db);
    console.log(`好感 ${before} → ${p.affinity}（${key}）`);
    break;
  }
  case 'note': {
    const key = normKey(args._[0]);
    const p = ensure(db, key);
    const summary = String(args._[1] ?? '').trim();
    if (!summary) throw new Error('缺少摘要');
    p.notes.push({
      at: new Date().toISOString(),
      kind: typeof args.kind === 'string' ? args.kind : 'chat',
      summary: summary.slice(0, 120),
      feeling: typeof args.feeling === 'string' ? args.feeling.slice(0, 80) : null,
    });
    if (p.notes.length > 80) p.notes = p.notes.slice(-80);
    save(db);
    console.log(`记下了（${key}）：${summary}`);
    break;
  }
  case 'pref': {
    // 偏好：单独立一份，跟普通闲聊笔记分开，取的时候不用从一堆 chat 里翻
    const key = normKey(args._[0]);
    const p = ensure(db, key);
    const text = String(args._[1] ?? '').trim();
    if (!text) throw new Error('缺少偏好内容');
    if (!Array.isArray(p.preferences)) p.preferences = []
    const now = new Date().toISOString()
    const hit = p.preferences.find((x) => x.text === text)
    if (hit) {
      hit.seen = (hit.seen || 1) + 1
      hit.at = now
    } else {
      p.preferences.push({ at: now, text: text.slice(0, 120), seen: 1, why: typeof args.why === 'string' ? args.why.slice(0, 80) : null })
    }
    if (p.preferences.length > 40) p.preferences = p.preferences.slice(-40)
    p.notes.push({ at: now, kind: 'preference', summary: text.slice(0, 120), feeling: null })
    if (p.notes.length > 80) p.notes = p.notes.slice(-80)
    save(db)
    console.log(`偏好记下（${key}）：${text}`)
    break
  }
  case 'prefs': {
    const key = normKey(args._[0]);
    const p = db.people[key];
    if (!p) { console.log('没这个人'); break }
    const list = p.preferences || []
    console.log(list.length ? list.map((x, i) => `${i + 1}. ${x.text}${x.seen > 1 ? `（提过 ${x.seen} 次）` : ''}${x.why ? ` ← ${x.why}` : ''}`).join('\n') : '还没记过偏好')
    break
  }
  case 'profile': {
    // 十二维：对一个人的认识按格子存；看的时候只列有内容的，空的略过
    const key = normKey(args._[0]);
    const p = ensure(db, key);
    const sub = args._[1];
    const dim = args._[2] ? (DIM_ALIAS[args._[2]] || null) : null;
    if (sub === 'add') {
      if (!dim) throw new Error(`维度要在这十二个里：${Object.values(DIMENSIONS).join('、')}`);
      const text = String(args._[3] ?? '').trim();
      if (!text) throw new Error('profile add <维度> "内容"');
      const at = new Date().toISOString();
      if (dim === 'preference') {
        if (!Array.isArray(p.preferences)) p.preferences = [];
        const hit = p.preferences.find((x) => x.text === text);
        if (hit) { hit.seen = (hit.seen || 1) + 1; hit.at = at; }
        else p.preferences.push({ at, text: text.slice(0, 120), seen: 1, why: null });
        if (p.preferences.length > 40) p.preferences = p.preferences.slice(-40);
      } else {
        p.profile[dim].push({ at, text: text.slice(0, 140) });
        if (p.profile[dim].length > 30) p.profile[dim] = p.profile[dim].slice(-30);
      }
      save(db);
      console.log(`记下（${key} · ${DIMENSIONS[dim]}）：${text}`);
      break;
    }
    if (sub === 'del') {
      if (!dim) throw new Error('profile del <维度> <序号>');
      const arr = dim === 'preference' ? p.preferences : p.profile[dim];
      const idx = Number(args._[3]);
      if (!Number.isInteger(idx) || idx < 1 || idx > (arr?.length ?? 0)) { console.log('没这个序号'); break; }
      const [gone] = arr.splice(idx - 1, 1);
      save(db);
      console.log(`删了（${key} · ${DIMENSIONS[dim]}）：${gone?.text ?? ''}`);
      break;
    }
    const rows = [];
    for (const [k, label] of Object.entries(DIMENSIONS)) {
      const arr = k === 'preference' ? (p.preferences || []) : (p.profile[k] || []);
      if (!arr.length) continue;
      rows.push(`【${label}】`);
      arr.forEach((x, i) => rows.push(`  ${i + 1}. ${x.text}${x.seen > 1 ? `（${x.seen} 次）` : ''}`));
    }
    console.log(rows.length ? `${key} ${p.name ?? ''}\n` + rows.join('\n') : `${key} ${p.name ?? ''}：十二格还空着`);
    break;
  }
  case 'seen': {
    const key = normKey(args._[0]);
    const p = ensure(db, key);
    const now = new Date().toISOString();
    p.firstSeen ||= now;
    p.lastSeen = now;
    p.encounters = (p.encounters || 0) + 1;
    if (typeof args.name === 'string') p.name = args.name;
    save(db);
    console.log(`见面 +1（${key} ${p.name ?? ''}，共 ${p.encounters} 次）`);
    break;
  }
  case 'mood': {
    const key = normKey(args._[0]);
    const p = ensure(db, key);
    const now = Date.now();
    let score = typeof p.moodScore === 'number' ? p.moodScore : 50;
    if (args.score !== undefined) {
      score = clamp(Number(args.score));
    } else if (args.delta !== undefined) {
      let d = Number(args.delta);
      // 习惯化：2 小时内同一类事件效果减半，免得被夸十次就飞到天上去
      const kind = typeof args.kind === 'string' ? args.kind : null;
      const lastAt = Date.parse(p.lastMoodAt || 0);
      if (kind && p.lastMoodKind === kind && now - lastAt < 2 * 3.6e6) d *= 0.5;
      score = clamp(score + d);
      if (kind) p.lastMoodKind = kind;
      p.lastMoodAt = new Date(now).toISOString();
    }
    p.moodScore = score;
    p.mood = typeof args.label === 'string' ? args.label : moodLabel(score);
    p.moodAt = new Date(now).toISOString();
    if (typeof args.why === 'string' && args.why.trim()) {
      p.lastCause = args.why.trim().slice(0, 90);
      p.notes.push({ at: p.moodAt, kind: 'mood', summary: p.lastCause, feeling: p.mood });
      if (p.notes.length > 80) p.notes = p.notes.slice(-80);
    }
    // 记仇只算「故意找上来」的；无心的、开玩笑的、误会的，照常自然消退
    if (typeof args.intent === 'string') {
      p.lastIntent = /无心|无意|accident|unintentional/i.test(args.intent) ? '无心' : '故意';
    }
    save(db);
    console.log(`心情已记：${key} ${p.mood}（${p.moodScore}/100）${p.lastCause ? ' 因为：' + p.lastCause : ''}`);
    break;
  }
  case 'link': {
    const a = normKey(args._[0]);
    const b = normKey(args._[1]);
    if (!b) throw new Error('要两个人：link <a> <b> --type 熟|不对付 --note "…"');
    db.links ||= [];
    const type = typeof args.type === 'string' ? args.type : '认识';
    const note = typeof args.note === 'string' ? args.note.slice(0, 100) : null;
    const hit = db.links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
    if (hit) { hit.type = type; hit.note = note; hit.at = new Date().toISOString(); }
    else db.links.push({ a, b, type, note, at: new Date().toISOString() });
    save(db);
    console.log(`关系记下：${a} ↔ ${b} = ${type}${note ? '（' + note + '）' : ''}`);
    break;
  }
  case 'links': {
    const only = args._[0] ? normKey(args._[0]) : null;
    const rows = (db.links || []).filter((l) => !only || l.a === only || l.b === only);
    console.log(rows.length ? rows.map((l) => `${l.a} ↔ ${l.b}：${l.type}${l.note ? '（' + l.note + '）' : ''}`).join('\n') : '还没有关系记录');
    break;
  }
  case 'habit': {
    db.habits ||= [];
    const sub = args._[0];
    if (sub === 'add') {
      const h = String(args._[1] ?? '').trim();
      if (!h) throw new Error('habit add "一条习惯"');
      if (!db.habits.includes(h)) db.habits.push(h.slice(0, 90));
      save(db);
      console.log('习惯 +1：' + h);
    } else if (sub === 'rm') {
      const h = String(args._[1] ?? '').trim();
      db.habits = db.habits.filter((x) => x !== h);
      save(db);
      console.log('删掉了：' + h);
    } else {
      console.log(db.habits.length ? db.habits.map((h) => '- ' + h).join('\n') : '还没有习惯记录');
    }
    break;
  }
  case 'favor': {
    // 人情账：别人对咱好（帮过忙、给过好处、说过软话）记一笔，回头要还
    const key = normKey(args._[0]);
    const p = ensure(db, key);
    const what = String(args.note ?? args._[1] ?? '').trim() || '对咱好过一次';
    p.favors ||= [];
    p.favors.push({ at: new Date().toISOString(), what: what.slice(0, 100), repaid: false });
    if (p.favors.length > 60) p.favors = p.favors.slice(-60);
    p.favorScore = (p.favorScore || 0) + 1;
    p.affinity = clamp((p.affinity ?? 50) + 2);
    save(db);
    console.log(`人情 +1（${key}）：${what}｜共 ${p.favorScore} 笔人情，好感 ${p.affinity}`);
    break;
  }
  case 'favors': {
    const key = normKey(args._[0]);
    const p = ensure(db, key);
    const list = p.favors || [];
    console.log(list.length ? list.map((f) => `${f.at.slice(0, 10)} ${f.repaid ? '(已还)' : '(欠着)'} ${f.what}`).join('\n') : '没有欠着的人情');
    break;
  }
  case 'repay': {
    // 把人情还了：帮回去、送东西、认真搭话都算
    const key = normKey(args._[0]);
    const p = ensure(db, key);
    const open = (p.favors || []).filter((f) => !f.repaid);
    if (!open.length) { console.log('没有欠着的人情'); break; }
    open.forEach((f) => { f.repaid = true; f.repaidAt = new Date().toISOString(); });
    p.notes.push({ at: new Date().toISOString(), kind: 'repay', summary: '还了人情：' + open.map((f) => f.what).join('，').slice(0, 80), feeling: null });
    save(db);
    console.log(`还了 ${open.length} 笔人情（${key}）`);
    break;
  }
  case 'treasure': {
    // 自己的私藏：谁都不给；好感够高的人可以破例看一眼
    db.treasures ||= [];
    const sub = args._[0];
    if (sub === 'add') {
      const name = String(args._[1] ?? '').trim();
      if (!name) throw new Error('treasure add "名字" --note "是什么"');
      db.treasures.push({
        name: name.slice(0, 60),
        note: typeof args.note === 'string' ? args.note.slice(0, 120) : null,
        at: new Date().toISOString(),
        givenTo: [],
      });
      save(db);
      console.log('私藏 +1：' + name);
    } else if (sub === 'list') {
      console.log(db.treasures.length
        ? db.treasures.map((t, i) => `${i + 1}. ${t.name}${t.note ? '（' + t.note + '）' : ''}${t.givenTo?.length ? ' 给过 ' + t.givenTo.length + ' 人' : ''}`).join('\n')
        : '还没有私藏');
    } else if (sub === 'give') {
      const pick = String(args._[1] ?? '').trim();
      const idx = Number(pick);
      const t = Number.isInteger(idx) && idx >= 1 ? db.treasures[idx - 1] : db.treasures.find((x) => x.name === pick);
      if (!t) { console.log('没找到这个私藏'); break; }
      const key = normKey(args._[2]);
      const p = ensure(db, key);
      const threshold = Number(args['min-affinity'] ?? 80);
      if ((p.affinity ?? 50) < threshold) {
        console.log(`不给（${key} 好感 ${p.affinity ?? 50}，得 ${threshold} 以上才破例）`);
        break;
      }
      t.givenTo ||= [];
      t.givenTo.push({ key, at: new Date().toISOString() });
      save(db);
      console.log(`破例给 ${key} 看了「${t.name}」——说一句只限你就行`);
    } else {
      console.log('用法：treasure add "名字" --note "…" / treasure list / treasure give <序号或名字> <key> [--min-affinity 80]');
    }
    break;
  }
  case 'decay': {
    const halfLife = Number(args['half-life'] ?? 6);
    const now = Date.now();
    const threshold = Number(args['grudge-threshold'] ?? (db.grudgeThreshold ?? 30));
    const changed = [];
    for (const [key, p] of Object.entries(db.people)) {
      if (typeof p.moodScore !== 'number') { p.moodScore = 50; p.moodAt ||= new Date(now).toISOString(); continue; }
      const isMaster = (db.masterKeys || []).includes(key);
      // 记仇：除 master 外，分数掉到阈值以下就不自然消退，等对方赔礼、服软或咱点过头才解
      if (p.grudge && !isMaster) { continue; }
      const at = Date.parse(p.moodAt || new Date(now).toISOString());
      const hours = Math.max(0, (now - at) / 3.6e6);
      if (hours < 0.1) continue;
      // 难过的半衰期短（默认 3 小时），开心留得久（默认 8 小时）
      const hl = p.moodScore < 50 ? Number(args['neg-half']) || 3 : Number(args['pos-half']) || 8;
      const drift = (p.moodScore - 50) * Math.pow(0.5, hours / hl);
      const next = 50 + drift;
      const rounded = Math.round(next);
      const near = Math.abs(next - 50) < 4;
      p.moodScore = near ? 50 : rounded;
      p.moodAt = new Date(now).toISOString();
      p.mood = near ? '平静' : moodLabel(p.moodScore);
      if (!isMaster && p.moodScore <= threshold && !p.grudge && p.lastIntent !== '无心') {
        p.grudge = true;
        p.grudgeAt = p.moodAt;
        changed.push(`${key} 记仇了(${p.moodScore})`);
        continue;
      }
      changed.push(`${key} ${p.mood}(${p.moodScore})`);
    }
    save(db);
    console.log(changed.length ? '回落后：' + changed.join('，') : '都在基线上');
    break;
  }
  case 'settle': {
    // 对方赔礼、服软、示好，或者咱已经小报复过了：把仇解掉，让情绪重新能自然消退
    const key = normKey(args._[0]);
    const p = ensure(db, key);
    const before = typeof p.moodScore === 'number' ? p.moodScore : 50;
    const why = typeof args.why === 'string' ? args.why.slice(0, 80) : '和解';
    p.grudge = false;
    delete p.grudgeAt;
    p.moodScore = Math.min(50, Math.round(before + (Number(args.lift) || 8)));
    p.mood = moodLabel(p.moodScore);
    p.moodAt = new Date().toISOString();
    p.notes.push({ at: p.moodAt, kind: 'settle', summary: why, feeling: p.mood });
    if (p.notes.length > 80) p.notes = p.notes.slice(-80);
    save(db);
    console.log(`仇解了（${key}）：${why}，心情回到 ${p.mood}(${p.moodScore})`);
    break;
  }
  default:
    console.log('用法：get / list / set / bump / note / seen / mood / decay / settle / link / links / habit / profile');
}
