/**
 * dsh-soul-seed —— 灵魂雏形插件（宿主侧）
 *
 * 设计原则：**插件里不预置任何人的性格。**
 *   装完第一次打开面板，它问你六件事（我是谁 / 你是谁 / 我在哪诞生 /
 *   什么性格 / 对你什么态度 / 有啥要补充），据此生成一份人设，
 *   你确认了才写进 ~/.dsh/soul-seed/persona.md。
 *
 * 三块能力：
 *   1. 六维心情（效价/唤醒/连接/疲劳/好奇/委屈 + 半衰期 + 惯性）
 *   2. 按人账本（用户 / qq:<openid> / wx:<wxid> / bili:<mid>）
 *   3. 生图流水线（便宜的试构图，贵的换材质）
 *
 * 数据：~/.dsh/soul-seed/  （mood.json / people.json / image-keys.json / persona.md）
 * 面板：GET /dsh-soul-seed/
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createWake } from "./wake.mjs"
import { detectExisting, learnLocal, deployMode } from "./adopt.mjs"
import { autoImport, wasLoaded, soulStats } from "./soul.mjs"
import { QUESTIONS, DEFAULT_RULES, composePersona, checkPersona, extrasFor } from './persona.mjs'
import { SPEECH_QUESTIONS, SET_QUESTIONS } from './presets.mjs'
import { soulHome } from './home.mjs'
import { startDailyTidy } from './tidy.mjs'
import { startContinuityLoop } from './continuity.mjs'
import { noteSelf } from './selfnote.mjs'
import { startPages } from './pages.mjs'
import { startAutoContinue } from './autocontinue.mjs'
import { readConfig as readCardConfig, loadCard, listCards, readMemory, renderMemory } from './card.mjs'
import { soulDir } from './rag.mjs'
import { readRecords, newestSessionFile } from './sessionlog.mjs'
import { analyze } from './ctxreport.mjs'
import { startAutoIngest } from './autoindex.mjs'
import { harvest, render, ANCHOR_MARK } from './anchor.mjs'
import { appendHistory, listTree, readBranch, recallLocal, renderRoot, sharedRoot } from './soulcore.mjs'
import { renderTrack, saveTrack, showTrack } from './tracks.mjs'

/** 思考回环检测：拿最后 50 字当指纹，看它在全文里出现几次；3 次以上就算绕进去了。 */
function detectThinkLoop(text) {
  if (text.length < 600) return null
  const tail = text.slice(-50)
  if (tail.length < 50) return null
  let count = 0
  let i = 0
  while ((i = text.indexOf(tail, i)) !== -1) {
    count++
    i += 1
  }
  return count >= 3 ? { repeated: tail, times: count } : null
}

/** 回环日志：一行一条，含出事时的思考尾巴，方便事后看它卡在哪。 */
function logThinkLoop(sid, buf, hit) {
  try {
    fs.appendFileSync(path.join(soulHome(), '思考回环.log'), JSON.stringify({
      at: new Date().toISOString(),
      session: sid,
      repeated: hit.repeated,
      times: hit.times,
      totalChars: buf.length,
      snapshot: buf.slice(-1200),
    }) + '\n')
  } catch {}
}

/** 原话库：这一回合用户说了什么、助手回了什么，原样存一条。 */
function saveOriginalTurn(sid, options, reply) {
  try {
    const text = String(reply || '').trim()
    if (text.length < 2) return
    const msgs = options && Array.isArray(options.messages) ? options.messages : []
    const last = msgs.filter((m) => m && m.role === 'user').pop()
    const userText = typeof last?.content === 'string' ? last.content : ''
    if (!userText || userText.length < 2) return
    const day = new Date().toISOString().slice(0, 10)
    const dir = path.join(soulHome(), 'shared', '原话')
    fs.mkdirSync(dir, { recursive: true })
    const clock = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const line = `- [${clock}] 用户：${userText.replace(/\s+/g, ' ').slice(0, 800)}\n- [${clock}] 助手：${text.replace(/\s+/g, ' ').slice(0, 1200)}\n`
    fs.appendFileSync(path.join(dir, `${day}.md`), line)
  } catch {}
}

/** 上下文归档：留最近 60%，更早的消息原文进 shared/归档，再留一条提示。 */
function archiveOldMessages(sid, msgs, keep = 0.6, minChars = 20000, maxChars = Number(process.env.SOUL_CTX_MAX ?? 240000)) {
  if (!Array.isArray(msgs) || msgs.length < 6) return msgs
  const size = (m) => {
    const c = m && m.content
    if (typeof c === 'string') return c.length
    try { return JSON.stringify(c ?? '').length } catch { return 0 }
  }
  const total = msgs.reduce((a, m) => a + size(m), 0)
  if (total < minChars) return msgs
  const target = total * (1 - keep)
  let acc = 0
  let cut = 0
  for (let i = 0; i < msgs.length; i++) {
    acc += size(msgs[i])
    if (acc >= target) { cut = i + 1; break }
  }
  while (cut > 0 && !(msgs[cut - 1] && msgs[cut - 1].role === 'user')) cut--
  // 绝对上限兜底（2026-11-24）：只按比例摘，会话越大剩下的也越大——
  // 一个爆满的会话每轮还在发 80 万字符（≈30 万 token）。按 user 边界继续往前推。
  if (maxChars > 0) {
    let remain = total - msgs.slice(0, cut).reduce((a, m) => a + size(m), 0)
    while (remain > maxChars && cut < msgs.length - 2) {
      let next = cut + 1
      while (next < msgs.length - 1 && !(msgs[next] && msgs[next].role === 'user')) next++
      if (next >= msgs.length - 1) break
      for (let i = cut; i < next; i++) remain -= size(msgs[i])
      cut = next
    }
  }
  if (cut <= 0 || cut >= msgs.length - 1) return msgs
  const day = new Date().toISOString().slice(0, 10)
  try {
    const dir = path.join(soulHome(), 'shared', '归档')
    fs.mkdirSync(dir, { recursive: true })
    const lines = [`\n## ${new Date().toLocaleString('zh-CN')} · ${sid}`, '']
    for (const m of msgs.slice(0, cut)) {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      lines.push(`**${m.role}**：${String(c).slice(0, 2000)}`, '')
    }
    fs.appendFileSync(path.join(dir, `${day}.md`), lines.join('\n'))
    fs.appendFileSync(path.join(soulHome(), 'wake.log'), `${new Date().toISOString()} 上下文归档：${sid} 摘掉 ${cut}/${msgs.length} 条（共 ${total} 字符）\n`)
    noteSelf(soulHome(), '归档', `摘掉 ${cut}/${msgs.length} 条，共 ${total} 字符`)
  } catch {}
  const out = msgs.slice(cut)
  const note = `（更早的 ${cut} 条对话已归档到 shared/归档/${day}.md，需要时用 soul 工具读或 rag-recall）`
  if (out[0] && out[0].role === 'user' && typeof out[0].content === 'string') {
    out[0] = { ...out[0], content: note + '\n\n' + out[0].content }
  } else {
    out.unshift({ role: 'user', content: note })
  }
  return out
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(HERE, '..')
const TOOLS = path.join(PKG_ROOT, 'tools')

const HOME = os.homedir()
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
const DATA = soulHome()

const MOOD_JSON = path.join(DATA, 'mood.json')
const GRUDGE_JSON = path.join(DATA, 'grudge.json')
const MEMORY_JSON = path.join(DATA, 'memory.json')
const PEOPLE_JSON = path.join(DATA, 'people.json')
const KEYS_JSON = path.join(DATA, 'image-keys.json')
const DRAFT_JSON = path.join(DATA, 'persona-draft.json')
const PERSONA_MD = path.join(DATA, 'persona.md')

function sizeOf(rel) {
  try { return fs.readFileSync(path.join(DATA, rel), 'utf8').length } catch { return 0 }
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback }
}
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8')
}
function readText(p) { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }

/** 实时页里最近 n 条对话（跨渠道），给系统提示用，短平快。
 *  数据取自仓库自己的共享区（默认 <soul home>/shared/实时），不碰老工作区。 */
function crossChannelTail(n = 3) {
  try {
    const dir = path.join(sharedRoot(), '实时')
    const files = fs.readdirSync(dir).filter((f) => /^\d{2}-\d{2}-\d{2}\.md$/.test(f)).sort()
    if (!files.length) return []
    const text = fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8')
    const lines = text.split('\n').filter((l) => /^- \[\d{2}-\d{2} \d{2}:\d{2}\] \[[^\]]+\]/.test(l))
    return lines.slice(-n)
  } catch {
    return []
  }
}

function resolveNode() {
  const cands = []
  if (process.platform === 'win32') {
    const rt = path.join(DSH_HOME, 'dsh-runtimes')
    try { for (const d of fs.readdirSync(rt)) cands.push(path.join(rt, d, 'dependencies', 'node', 'bin', 'node.exe')) } catch {}
  }
  cands.push('/usr/bin/node', '/usr/local/bin/node')
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c } catch {} }
  return 'node'
}
const NODE = resolveNode()

function runNode(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    execFile(NODE, args, { timeout: timeoutMs, env: { ...process.env, DSH_HOME } }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? String(err.message) : null })
    })
  })
}

function json(res, code, body) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}
function html(res, body) {
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}
function isLoopback(req) {
  const host = String(req.headers?.host ?? '').toLowerCase()
  const h = host.split(':')[0]
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}
function readBody(req, limit = 200000) {
  return new Promise((resolve, reject) => {
    let n = 0
    const chunks = []
    req.on('data', (c) => {
      n += c.length
      if (n > limit) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const STYLE = `
<style>
  :root { color-scheme: dark; }
  body { font: 15px/1.65 ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; margin:0; padding:28px; background:#0f1420; color:#e8ecf5; }
  h1 { font-size:20px; margin:0 0 4px; } .sub { color:#8b96ab; font-size:13px; margin-bottom:22px; }
  .card { background:#171e2e; border:1px solid #263047; border-radius:12px; padding:16px 18px; margin-bottom:14px; }
  .card h2 { font-size:14px; margin:0 0 12px; color:#9fb0cc; font-weight:600; letter-spacing:.04em; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:5px 0; border-bottom:1px dashed #222c42; }
  .row:last-child { border-bottom:0; } .k { color:#8b96ab; } .v { font-variant-numeric:tabular-nums; }
  .big { font-size:26px; font-weight:700; }
  .bar { height:6px; background:#222c42; border-radius:4px; overflow:hidden; width:120px; align-self:center; display:inline-block; vertical-align:middle; }
  .bar > i { display:block; height:100%; background:linear-gradient(90deg,#4f8cff,#7ad3ff); }
  label { display:block; margin:14px 0 6px; font-size:14px; color:#cdd7e8; }
  .hint { color:#7d8aa1; font-size:12.5px; margin:0 0 6px; }
  input[type=text], textarea { width:100%; box-sizing:border-box; background:#101827; color:#e8ecf5; border:1px solid #2a3550; border-radius:8px; padding:9px 11px; font:14px/1.5 inherit; }
  textarea { min-height:74px; resize:vertical; }
  button { background:#2b6cff; color:#fff; border:0; border-radius:8px; padding:9px 15px; cursor:pointer; font-size:14px; margin-top:16px; }
  button.ghost { background:#243050; }
  button:disabled { opacity:.5; cursor:default; }
  pre { background:#0b1120; border:1px solid #223344; border-radius:8px; padding:14px; white-space:pre-wrap; word-break:break-word; font:13px/1.6 ui-monospace, Consolas, monospace; }
  .muted { color:#8b96ab; } .warn { color:#ffcf7a; } .ok { color:#7ee2a8; }
  .req::after { content:" *"; color:#ff8a8a; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0 2px; }
  .chip { background:#1c2740; color:#a9b8d4; border:1px solid #2c3a5c; border-radius:999px; padding:4px 11px; font-size:12.5px; cursor:pointer; margin:0; }
  .chip:hover { background:#243255; color:#dce6f7; }
  .chip.on { background:#2b6cff; border-color:#2b6cff; color:#fff; }
  a { color:#7ad3ff; }
</style>`

const DIMS = [['valence', '效价'], ['arousal', '唤醒'], ['connection', '连接'], ['fatigue', '疲劳'], ['curiosity', '好奇'], ['frustration', '委屈']]

function infoPage() {
  const group = (list, offset) => list.map((x, i) => `<div class="row"><span class="k">${offset + i + 1}. ${x.label}</span><span class="v muted">${(x.options || []).slice(0, 3).join(' / ')} …</span></div>`).join('')
  const qs = group(QUESTIONS, 0)
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>还没认过人</title>${STYLE}</head><body>
<h1>还没认过人</h1>
<div class="sub">这一步不是让你填表 —— 是让你的鱼来问你。</div>
<div class="card"><h2>怎么做</h2>
  <p class="hint" style="font-size:14px;margin:0 0 8px">回到对话里说一句：</p>
  <pre>开始初始化</pre>
  <p class="hint" style="font-size:13px;margin:8px 0 0">它会一个一个问你，每题都有候选，最后一项永远是「其他（自己写）」。答完基本问题还会问说话风格和四块可选能力 —— 不想答就说「默认」。
  答完它会念一遍给你听，你说行，它才写进 ~/.dsh/soul-seed/persona.md。</p>
</div>
<div class="card"><h2>第一组 · 它要问的 ${QUESTIONS.length} 个基本问题</h2>${qs}</div>
<div class="card"><h2>第二组 · 说话风格 ${SPEECH_QUESTIONS.length} 问（每题 4–5 个选项）</h2>${group(SPEECH_QUESTIONS, QUESTIONS.length)}</div>
<div class="card"><h2>第三组 · 四块可选能力（可以都要，也可以都不要）</h2>${group(SET_QUESTIONS, QUESTIONS.length + SPEECH_QUESTIONS.length)}
  <div class="muted" style="font-size:13px;margin-top:8px">现场（怎么知道现在发生什么）· 历史（定下来的事怎么记）· 说话素材（梗库/催睡）· 同步（写锁 + 脚本）</div>
</div>
<div class="muted" style="font-size:13px">为什么不用表单：人设不是选项拼装出来的，是聊出来的 —— 鱼得多问一句「你是说哪种」，答案才具体。</div>
</body></html>`
}

function dashboardPage(st) {
  const m = st.mood
  let moodHtml
  if (!m) moodHtml = '<span class="muted">还没有心情记录（点下面「重算心情」，或等下一次觉醒）</span>'
  else {
    moodHtml = `<div class="row"><span class="k">${m.name}</span><span class="big">${m.composite}<span class="muted" style="font-size:14px">/100</span></span></div>` +
      DIMS.map(([k, label]) => `<div class="row"><span class="k">${label}</span><span class="v">${m[k]} <span class="bar"><i style="width:${Math.max(0, Math.min(100, m[k]))}%"></i></span></span></div>`).join('') +
      `<div class="muted" style="margin-top:10px;font-size:13px">${m.reason || ''}</div>
       <div class="muted" style="margin-top:6px;font-size:13px">怎么说话：${m.policy?.band || '-'}（最多推 ${m.policy?.pushMax ?? '-'} 条）</div>`
  }
  const peopleHtml = st.people.length
    ? st.people.map((x) => {
      const bits = []
      if (x.favors.length) {
        bits.push('<div class="muted" style="font-size:13px;margin-top:4px">人情账：' +
          x.favors.map((f) => `${f.dir === 'in' ? '欠着' : '他欠我'}「${f.what}」`).join('；') + '</div>')
      }
      if (x.links.length) {
        bits.push('<div class="muted" style="font-size:13px">关系网：' +
          x.links.map((l) => `${l.who}（${l.kind}${l.note ? '·' + l.note : ''}）`).join('；') + '</div>')
      }
      if (x.secrets) {
        bits.push('<div class="muted" style="font-size:13px">私藏：' + x.secrets + ' 条' +
          (x.secretsOpen ? '（好感够，可以看）' : `（好感 ${x.goodwill} < 70，不看）`) + '</div>')
      }
      return `<div class="row"><span class="k">${x.nickname}</span><span class="v">好感 ${x.goodwill} · 心情 ${x.mood} · 见面 ${x.meets}</span></div>` + bits.join('')
    }).join('')
    : '<span class="muted">账本还空着（node tools/02-people/people.mjs meet 你的称呼）</span>';

  const grudgeHtml = st.grudge.length
    ? st.grudge.map((g) => `<div class="row"><span class="k">${g.who} · ${g.level} 级</span><span class="v">${g.daysLeft} 天后翻篇 · ${g.what}${g.chain ? '（台词 ' + g.chain + ' 步）' : ''}</span></div>`).join('')
    : '<span class="muted">没有未结的仇</span>'

  const wn = st.wake || null
  const wakeCard = wn
    ? `<div class="row"><span class="k">${wn.at || '刚刚'}</span><span class="v">${wn.delivered ? '已投递到会话' : '没投递（会话忙），但这里留着'}</span></div>
       <div class="muted" style="font-size:13px;margin-top:8px;white-space:pre-wrap">${(wn.text || '').replace(/</g, '&lt;')}</div>`
    : '<span class="muted">还没醒过（重启插件后 10 秒会醒一次）</span>'

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>灵魂雏形</title>${STYLE}</head><body>
<h1>灵魂雏形</h1>
<div class="sub">六维心情 · 长期记忆 · 按人账本 · 说话手册　<span class="muted">（数据在 ~/.dsh/soul-seed/）</span></div>
<div class="card"><h2>人设</h2>
  <div class="row"><span class="k">状态</span><span class="v">${st.persona.exists ? '已有 persona.md（' + st.persona.length + ' 字）' : '还没生成'}</span></div>
  <div class="muted" style="margin-top:8px;font-size:13px">人设不随插件走：换个人部署，重新答一遍就行。</div>
  <div style="margin-top:12px"><a href="/dsh-soul-seed/setup"><button class="ghost">${st.persona.exists ? '重新答一遍' : '开始初始化'}</button></a></div>
    ${localAdoptCard(st)}
</div>
<div class="card"><h2>上下文账</h2>
  <div id="ctx-box" class="muted" style="font-size:13px">（读中）</div>
  <div class="muted" style="font-size:12px;margin-top:8px">每轮输入里空间被谁吃了。数从会话日志算，token 是估算（不是 tokenizer 实测）。</div>
  <script>
    fetch('/dsh-soul-seed/api/context').then(function (r) { return r.json() }).then(function (j) {
      var b = document.getElementById('ctx-box');
      if (!j.ok) { b.textContent = '读不到：' + (j.error || '未知'); return }
      b.style.whiteSpace = 'pre-wrap';
      b.textContent = [
        '会话 ' + j.turns + ' 轮（有 usage 的 ' + j.turnsMeasured + ' 轮）',
        '每轮输入 平均 ' + Number(j.inputAvg).toLocaleString() + ' · 最大 ' + Number(j.inputMax).toLocaleString(),
        '压缩 ' + j.compactions + ' 次' + (j.compactionTurns && j.compactionTurns.length ? '（最近第 ' + j.compactionTurns.join('、') + ' 轮）' : ''),
        '折叠块 ' + j.folds + ' 个',
        '文件 ' + (j.sizeMB || '?') + ' MB'
      ].join('\n');
    }).catch(function (e) { document.getElementById('ctx-box').textContent = '读不到：' + e.message });
  </script>
</div>
<div class="card"><h2>它醒过</h2>${wakeCard}</div>
<div class="card"><h2>今天的心情</h2>${moodHtml}</div>
<div class="card"><h2>按人账本</h2>${peopleHtml}
  <div class="muted" style="font-size:12.5px;margin-top:8px">长期记忆 ${st.memory} 条 · 私藏好感门槛 70</div>
</div>
<div class="card"><h2>醒来投给谁</h2>
  <div class="row"><span class="k">当前目标</span><span class="v" id="wt-cur">（读中）</span></div>
  <div class="muted" style="font-size:12.5px;margin:6px 0 10px">不设就用「最近写过的会话」—— 可能不是你正开着的那个。</div>
  <div id="wt-list" class="muted" style="font-size:12.5px">（读中）</div>
  <div style="margin-top:10px"><button id="wt-clear" class="ghost">清掉目标（回到最近会话）</button> <span id="wt-msg" class="muted"></span></div>
</div>
<div class="card"><h2>记仇</h2>${grudgeHtml}
  <div class="muted" style="font-size:12.5px;margin-top:8px">默认关；开了也是「到期自动翻篇 + 台词要人点头才发」</div>
</div>
<div class="card"><h2>生图</h2>
  <div class="row"><span class="k">智谱（cogview-4 / glm-image）</span><span class="v">${st.keys.zhipu ? '已配' : '未配'}</span></div>
  <div class="row"><span class="k">阿里百炼（wanx / wan2.7）</span><span class="v">${st.keys.dashscope ? '已配' : '未配'}</span></div>
  <div class="muted" style="margin-top:8px;font-size:13px">统一走 DSH 的 generate_image / edit_image；这个面板只管 key 在不在。</div>
  <div style="margin-top:12px"><button id="refresh">重算心情</button> <span id="msg" class="muted"></span></div>
</div>
<script>
  (async () => {
    const cur = document.getElementById('wt-cur');
    const list = document.getElementById('wt-list');
    if (!cur || !list) return;
    try {
      const r = await (await fetch('/dsh-soul-seed/api/soul/sessions')).json();
      cur.textContent = r.current ? r.current : '未设（用最近会话）';
      if (!r.sessions || !r.sessions.length) { list.textContent = '（没找到会话）'; return; }
      list.innerHTML = '';
      for (const s of r.sessions) {
        const line = document.createElement('div');
        line.style.margin = '4px 0';
        const when = new Date(s.mtime).toLocaleString('sv-SE').slice(5, 16);
        const btn = document.createElement('button');
        btn.className = 'ghost';
        btn.textContent = '用这个';
        btn.style.marginRight = '8px';
        btn.onclick = async () => {
          const msg = document.getElementById('wt-msg');
          btn.disabled = true;
          try {
            const rr = await (await fetch('/dsh-soul-seed/api/wake/target', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: s.sessionId })
            })).json();
            msg.textContent = rr.ok ? ('已设：' + s.sessionId) : ('失败：' + (rr.error || ''));
            if (rr.ok) cur.textContent = s.sessionId;
          } catch (e) { msg.textContent = '失败：' + e.message }
          finally { btn.disabled = false }
        };
        line.appendChild(btn);
        line.appendChild(document.createTextNode(s.sessionId + '  ·  ' + when));
        list.appendChild(line);
      }
    } catch (e) { list.textContent = '读不到会话列表：' + e.message }
  })();
  document.getElementById('wt-clear').onclick = async () => {
    const msg = document.getElementById('wt-msg');
    try {
      const rr = await (await fetch('/dsh-soul-seed/api/wake/target', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
      })).json();
      msg.textContent = rr.cleared ? '已清掉，切回最近会话' : '没清掉';
      document.getElementById('wt-cur').textContent = '未设（用最近会话）';
    } catch (e) { msg.textContent = '失败：' + e.message }
  };

document.getElementById('refresh').onclick = async () => {
  const b = document.getElementById('refresh'); b.disabled = true;
  const msg = document.getElementById('msg'); msg.textContent = '算着…';
  try {
    const r = await (await fetch('/dsh-soul-seed/api/mood/refresh', { method:'POST' })).json();
    msg.textContent = r.ok ? '好了，刷新页面看' : ('失败：' + (r.error || ''));
  } catch (e) { msg.textContent = '失败：' + e.message; }
  finally { b.disabled = false; }
};
</script></body></html>`
}

function localAdoptCard(st) {
  const dep = st?.deploy || {}
  if (dep.mode !== 'learn') return ''
  const src = (dep.existing?.sources || []).map((x) => x.kind).join(' · ') || '本机已有灵魂'
  return `
<div class="card"><h2>这台机器上已经有一只鱼</h2>
  <div class="muted" style="font-size:13.5px">检测到：${src}。这次不用再答十问，直接接着用。</div>
  <div style="margin-top:12px"><button id="adopt">学本地的</button> <span id="adoptMsg" class="muted"></span></div>
  <script>
  document.getElementById('adopt').onclick = async () => {
    const b = document.getElementById('adopt'); b.disabled = true
    const m = document.getElementById('adoptMsg'); m.textContent = '读着…'
    try {
      const r = await (await fetch('/dsh-soul-seed/api/adopt', { method: 'POST' })).json()
      m.textContent = r.ok ? ('学完了：' + r.summary) : ('没成：' + (r.error || ''))
    } catch (e) { m.textContent = '没成：' + e.message }
    finally { b.disabled = false }
  }
  </script>
</div>`
}

export default {
  name: 'dsh-soul-seed',
  // 只硬依赖 webServer；sessionController 若不存在，面板照常出，"醒来"自动跳过
  inject: ['webServer', 'tools'],
  apply(ctx) {
  // 启动留痕：确认 apply 有没有跑，看这个文件就知道
  try {
    const bootDir = soulHome()
    fs.mkdirSync(bootDir, { recursive: true })
    fs.appendFileSync(path.join(bootDir, 'soul-boot.log'), new Date().toISOString() + ' apply called\n')
  } catch {}

  // ── 结论锚：工具跑完，把上一步的结论摆回来（治「跑完就忘了刚才想什么」）──
  // 锚点开关：SOUL_ANCHOR=0 关掉；SOUL_ANCHOR_MIN_TOOLS=N 表示攒够 N 次工具调用才开始注入
  // 为什么要开关：每注入一次约 1.4k 字符（≈2k token），一次长会话下来是几万 token 的真金白银
  const ANCHOR_ON = String(process.env.SOUL_ANCHOR ?? '1') !== '0'
  const ANCHOR_MIN_TOOLS = Number(process.env.SOUL_ANCHOR_MIN_TOOLS ?? 0) || 0
  const THINK_GUARD = String(process.env.SOUL_THINK_GUARD ?? '1') !== '0'
  // 上下文归档：留最近 60%，更早的进归档（SOUL_CTX_ARCHIVE=0 关）
  const CTX_ARCHIVE_ON = String(process.env.SOUL_CTX_ARCHIVE ?? '1') !== '0'
  const CTX_KEEP = Number(process.env.SOUL_CTX_KEEP ?? 0.6)
  let anchorWarned = false
  const anchorState = new Map()          // sessionId → { reasoning, anchor, injected, tools }
  const ANCHOR_SKIP = new Set(['read', 'write', 'edit', 'glob', 'grep', 'save_token_expand', 'web_search', 'web_fetch'])
  try {
    ctx.on('llm/stream', (options, next) => {
      const sid = options && options.sessionId ? String(options.sessionId) : '(direct)'
      // 上下文归档：改的是本轮发给模型的那份列表，历史文件不动
      if (CTX_ARCHIVE_ON && options && Array.isArray(options.messages)) {
        try {
          const keep = archiveOldMessages(sid, options.messages, CTX_KEEP)
          if (keep !== options.messages) options.messages = keep
        } catch {}
      }
      const inner = next()
      async function* tap() {
        let buf = ''
        let checked = 0
        let out = ''
        try {
          for await (const chunk of inner) {
            try {
              if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                out += chunk.text
                if (out.length > 24000) out = out.slice(-24000)
              }
            } catch {}
            try {
              if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
                buf += chunk.text
                if (THINK_GUARD && buf.length - checked >= 200) {
                  checked = buf.length
                  const loop = detectThinkLoop(buf)
                  if (loop) logThinkLoop(sid, buf, loop)
                }
              }
            } catch {}
            yield chunk
          }
        } finally {
          try {
            const st = anchorState.get(sid) || {}
            // 只留最后 6000 字：再往前的是上一轮的过程，摘出来也没用
            st.reasoning = buf.length > 6000 ? buf.slice(-6000) : buf
            const points = harvest(st.reasoning)
            st.anchor = render(points)
            anchorState.set(sid, st)
          } catch {}
          // 原话库：这一回合原样存一份
          try { saveOriginalTurn(sid, options, out) } catch {}
        }
      }
      return tap()
    })
  } catch {}

  try {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const d = await next()
      try {
        if (!d || d.kind !== 'accept') return d
        if (Object.prototype.hasOwnProperty.call(d, 'value')) return d
        if (exec && exec.parent !== undefined) return d          // 子代理里的工具不碰
        if (exec && ANCHOR_SKIP.has(exec.name)) return d
        {
          const sidC = exec && exec.agent && exec.agent.session && exec.agent.session.header
            ? String(exec.agent.session.header.id)
            : '(direct)'
          const stC = anchorState.get(sidC) || {}
          stC.tools = (stC.tools || 0) + 1
          anchorState.set(sidC, stC)
        }

        const sid = exec && exec.agent && exec.agent.session && exec.agent.session.header
          ? String(exec.agent.session.header.id)
          : '(direct)'
        if (!ANCHOR_ON) return d
        const st = anchorState.get(sid)
        if (!st || !st.anchor) return d
        if (ANCHOR_MIN_TOOLS > 0 && (st.tools || 0) < ANCHOR_MIN_TOOLS) return d
        if (st.injected === st.anchor) return d                  // 同一份锚点不重复灌

        const content = Array.isArray(d.content) ? d.content : (result && Array.isArray(result.content) ? result.content : null)
        if (!content) return d
        const at = content.findIndex((b) => b && b.type === 'text' && typeof b.text === 'string')
        if (at < 0) return d

        st.injected = st.anchor
        const next2 = content.slice()
        next2[at] = { ...next2[at], text: next2[at].text + '\n\n' + st.anchor }
        return { kind: 'accept', content: next2 }
      } catch (e) {
        // 静默失败比坏更糟：今天就是因为一个未定义变量把锚点整段关掉、还没人知道
        if (!anchorWarned) {
          anchorWarned = true
          try {
            fs.appendFileSync(path.join(DATA, 'soul-boot.log'), new Date().toISOString() + ' 锚点钩子出错（已跳过，之后不再刷）：' + String(e?.message ?? e).slice(0, 120) + '\n')
          } catch {}
        }
        return d
      }
    }, { prepend: true })
  } catch {}


    const disposers = []

  // ── 后台两件事：修枝（每天 4 点，错过开机补跑）+ 自动入库（每 30 分钟增量建索引）──
  // 这两件以前只在文件里定义了函数、没人调用，等于没跑；现在接上，插件一加载就开始。
  try {
    const tidy = startDailyTidy({
      home: soulHome(),
      log: (m) => { try { fs.appendFileSync(path.join(soulHome(), 'tidy.log'), new Date().toISOString() + ' ' + m + '\n') } catch {} },
      onError: () => {}
    })
    if (tidy && typeof tidy.stop === 'function') disposers.push(() => tidy.stop())
  } catch {}

  // ── 接续整理：每 N 小时（默认 6，0/6/12/18 点）在工作区跑 tidy-continuity + cross-session ──
  // 2026-11-24 master 定：不再靠定时任务起新会话，挂进插件自己跑，不占 token。
  // 间隔要改：工作区写 .continuity-config.json {"hours":2}
  try {
    const cont = startContinuityLoop({
      home: soulDir(),
      log: (m) => { try { fs.appendFileSync(path.join(soulDir(), 'wake.log'), new Date().toISOString() + ' continuity: ' + m + '\n') } catch {} },
      onError: () => {},
    })
    if (cont && typeof cont.stop === 'function') disposers.push(() => cont.stop())
  } catch {}

  // ── 12 小时分页：0 点 / 12 点各刷一次，开机发现错过就补跑 ──
  try {
    const pages = startPages({
      home: soulDir(),
      log: (m) => { try { fs.appendFileSync(path.join(soulDir(), 'wake.log'), new Date().toISOString() + ' pages: ' + m + '\n') } catch {} },
      onError: () => {},
    })
    if (pages && typeof pages.stop === 'function') disposers.push(() => pages.stop())
  } catch {}

  // ── 自动续跑：只续限流 / 空回复 / 被输出上限截断，最多 2 次；欠费配额不续 ──
  // 配置：~/.dsh/misa-auto-continue.json { enabled, maxRetries }
  try {
    startAutoContinue(ctx)
  } catch {}

  // ── 根页：把共享区根上的 SHARED-STATE.md 注入系统提示（可截断），每轮先读 ──
  // 数据目录走 home.mjs（默认 ~/.dsh/soul-seed），文件不在就整段跳过，不报错。
  try {
    ctx.inject(['systemPrompt'], (rootCtx) => {
      const prompt = rootCtx.get('systemPrompt')
      if (!prompt) return
      rootCtx.effect(
        () =>
          prompt.section({
            name: 'misa-soul-root',
            order: 140,
            text: () => {
              const root = renderRoot()
              if (!root) return ''
              const out = [
                '## 人工灵魂（根页，每轮先读）',
                '',
                root,
                '',
                `> 目录：${soulHome()}`,
                '> 枝上的细节用 soul 工具读（action=read, file=共享页里写的相对路径）；',
                '> 定了什么事，用 soul 工具 action=note 往当月历史追加一条。',
                '> 对方提到「上次 / 那个 / 之前说的」这类指代物，而你想不起来：先用 soul 工具 action=rag-recall 找出来，再答。',
              ]
              // 跨渠道最近三条：让任何会话都能看到别的渠道刚说了什么。
              try {
                const tail = crossChannelTail(3)
                if (tail.length) {
                  out.push('', '【其他渠道最近几条】（只供知晓，别重复答）')
                  for (const line of tail) out.push('> ' + String(line).slice(0, 110))
                }
              } catch {}
              return out.join('\n')
            },
          }),
        'dsh-soul-seed: root page',
      )
    })
  } catch {}

  // ── 上下文压力预警：快到线时在系统提示里提前报警，让模型第一句先提醒 ──
  // 阈值 SOUL_CTX_WARN 默认 0.60；设 0 关闭。跟「上下文到 60% 就写交接」对齐。
  const CTX_WARN_RATIO = Number(process.env.SOUL_CTX_WARN ?? 0.6)
  if (CTX_WARN_RATIO > 0 && CTX_WARN_RATIO < 1) {
    try {
      ctx.inject(['systemPrompt', 'tokenMeter'], (guardCtx) => {
        const prompt = guardCtx.get('systemPrompt')
        const meter = guardCtx.get('tokenMeter')
        if (!prompt || !meter || typeof meter.contextPressure !== 'function') return
        guardCtx.effect(
          () =>
            prompt.section({
              name: 'misa-ctx-guard',
              order: 141,
              text: (context) => {
                try {
                  const session = context?.agent?.session
                  if (!session) return ''
                  const p = meter.contextPressure(session)
                  if (!p) return ''
                  const used = Number(p.projectedTokens ?? p.pressureTokens ?? 0)
                  const win = Number(p.contextWindow ?? 0)
                  if (!Number.isFinite(used) || !Number.isFinite(win) || win <= 0 || used <= 0) return ''
                  const ratio = used / win
                  if (ratio < CTX_WARN_RATIO) return ''
                  const pct = Math.min(99, Math.round(ratio * 100))
                  const k = (n) => `${Math.round(n / 1000)}K`
                  return [
                    '## ⚠ 上下文快满了（必须遵守）',
                    `本会话上下文已用到约 ${pct}%（${k(used)} / ${k(win)} token）。`,
                    '再跑一个大命令或长输出就可能撞上限、整轮卡死。',
                    `这一轮回复的**第一句**必须先提醒 master：「⚠ 上下文快满了（约 ${pct}%），换个会话再继续」，`,
                    '然后只做最小必要的动作：不要开新任务、不要读大文件、不要把整段日志倒出来。',
                  ].join('\n')
                } catch {
                  return ''
                }
              },
            }),
          'dsh-soul-seed: context guard',
        )
      })
    } catch {}
  }

  // ── soul 工具：最小集（tree / read / note / rag-recall / track-save / track-show）──
  // 注册方式跟本机在跑的插件一致：ctx.inject(['tools']) 后 tools.register(definition)。
  try {
    ctx.inject(['tools'], (toolsCtx) => {
      const tools = toolsCtx.get('tools')
      if (!tools) return
      const definition = {
        name: 'soul',
        description:
          '人工灵魂：分层记忆树 + 轨道（常做的活存成可复用配方）。' +
          'action=tree 看整棵树；read 读某个枝；note 往当月历史追加结论；' +
          'rag-recall 按语义/关键词找旧内容；track-save 存一条轨道；track-show 模糊匹配一条轨道。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['tree', 'read', 'note', 'rag-recall', 'track-save', 'track-show'],
              description:
                'tree 列记忆树；read 读某个枝（file 参数）；note 往当月历史追加一条结论（text 参数）；' +
                'rag-recall 按语义/关键词检索旧内容（query 参数）；' +
                'track-save 存一条轨道（name、keywords、steps、fallback）；track-show 按 query 模糊匹配一条轨道。',
            },
            query: { type: 'string', description: 'rag-recall / track-show 用：想找的事或轨道名/关键词，随便描述' },
            file: { type: 'string', description: 'read 用：shared/ 下的相对路径，例如 规矩/人与关系.md' },
            text: { type: 'string', description: 'note 用：一句话结论' },
            name: { type: 'string', description: 'track-save 用：轨道短名，例如 出图' },
            keywords: { type: 'string', description: 'track-save 用：逗号分隔的关键词，例如 生图,画图,comfyui' },
            steps: { type: 'string', description: 'track-save 用：分步配方，用 ｜ 或换行分隔' },
            fallback: { type: 'string', description: 'track-save 用：跑不通怎么退回' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
            additionalProperties: true,
          },
          render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        execute: async (args) => {
          const input = args && typeof args === 'object' ? args : {}
          const action = typeof input.action === 'string' ? input.action : 'tree'

          if (action === 'tree') {
            const rows = listTree()
            const lines = rows.map((row) =>
              row.dir ? `${row.path}` : `${row.path}  ${(row.bytes / 1024).toFixed(1)} KB`,
            )
            return { message: lines.join('\n') || '（空）' }
          }

          if (action === 'read') {
            if (!input.file) return { message: '缺少 file（shared/ 下的相对路径）' }
            try {
              const text = readBranch(input.file)
              return { message: text ?? `没有这个文件：${input.file}` }
            } catch (e) {
              return { message: String(e?.message ?? e) }
            }
          }

          if (action === 'note') {
            try {
              const { file, stamp } = appendHistory(input.text)
              return { message: `已记到 ${file}（${stamp}）` }
            } catch (e) {
              return { message: String(e?.message ?? e) }
            }
          }

          if (action === 'rag-recall') {
            if (!input.query) return { message: '缺少 query（想找的事）' }
            const hits = recallLocal(input.query, 8)
            if (!hits.length) return { message: '没检索到' }
            return {
              message: hits
                .map((h, i) => `${i + 1}. [${h.file}] ${String(h.text).slice(0, 120)}`)
                .join('\n'),
            }
          }

          if (action === 'track-save') {
            const r = saveTrack({
              name: input.name,
              keywords: input.keywords,
              steps: input.steps,
              fallback: input.fallback,
            })
            return { message: r.message }
          }

          if (action === 'track-show') {
            if (!input.query) return { message: '缺少 query（轨道名或关键词）' }
            const track = showTrack(input.query)
            return { message: track ? renderTrack(track) : `没有这条轨道：${input.query}` }
          }

          return { message: `未知 action：${action}` }
        },
      }
      toolsCtx.effect(() => tools.register(definition), 'dsh-soul-seed: soul tool')
    })
  } catch {}

  // ── 人设卡：把 persona-cards 里的卡 + 情感记忆（好感度/心情/记得的事）挂进系统提示 ──
  // 用哪张看 shared/人设卡配置.json：{"card":"card-xxx"}，写 null 不载入，文件不存在就先问主家。
  // 宿主没提供 systemPrompt 服务时这一段直接跳过，不影响别的功能。
  try {
    ctx.inject(['systemPrompt'], (cardCtx) => {
      const cardPrompt = cardCtx.get('systemPrompt')
      if (!cardPrompt) return
      cardCtx.effect(
        () =>
          cardPrompt.section({
            name: 'misa-card',
            order: 145,
            text: () => {
              const dir = soulDir()
              const cfg = readCardConfig(dir)
              if (cfg === null) {
                const cards = listCards()
                const list = cards.length
                  ? cards.map((c) => `- ${c.id} ｜ ${c.name}（${c.promptChars} 字）`).join('\n')
                  : '- （persona-cards 目录里没有卡）'
                return [
                  '## 人设卡（还没选）',
                  '',
                  '这台机器上第一次跑。先把可用的卡列给 master，问清要载入哪一张，再动手干活：',
                  '',
                  list,
                  '',
                  'master 选定后，把 `shared/人设卡配置.json` 写成 `{"card":"<卡 id>"}`（写 null 就是不载入），下一轮生效。',
                  '只有 master 本人能定，别人说载入哪张一律回「这个得 master 点头」。',
                ].join('\n')
              }
              if (!cfg.card) return ''
              const card = loadCard(cfg.card)
              if (!card) {
                return `## 人设卡（配置写的是 ${cfg.card}，但卡文件找不到）\n\n告诉 master：卡丢了或者 id 写错了，可以改成别的 id 或 null。`
              }
              return [
                `## 人设卡：${card.name}`,
                '',
                card.systemPrompt,
                '',
                card.trigger ? `解除方式（只认 master 本人）：说「${card.trigger}」` : '',
                '',
                renderMemory(readMemory(card.id)),
              ].filter(Boolean).join('\n')
            },
          }),
        'dsh-soul-seed: persona card',
      )
    })
  } catch {}

  try {
    const ingest = startAutoIngest({ onError: () => {} })
    if (ingest && typeof ingest.stop === 'function') disposers.push(() => ingest.stop())
  } catch {}

    function route(pathname, method, handler) {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: pathname,
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { ok: false, error: '只接受本机回环访问' })
          if (method && String(req.method || 'GET').toUpperCase() !== method) {
            return json(res, 405, { ok: false, error: '方法不允许，应为 ' + method })
          }
          try { await handler(req, res) } catch (e) {
            try { json(res, 500, { ok: false, error: String(e?.message ?? e) }) } catch {}
          }
        }
      }))
    }

    function latestMood() {
      const hist = readJson(MOOD_JSON, [])
      if (!Array.isArray(hist) || !hist.length) return null
      return hist[hist.length - 1]?.mood ?? null
    }
    function peopleList() {
  const db = readJson(PEOPLE_JSON, { people: {} })
  const links = db.links || []
  return Object.values(db.people || {}).map((p) => ({
    id: p.id, nickname: p.nickname,
    goodwill: p.goodwill, mood: p.mood, meets: p.meets,
    habits: p.habits || [],
    favors: (p.favors || []).filter((x) => !x.settled).map((x) => ({ dir: x.dir, what: x.what })),
    links: links
      .filter((l) => l.a === p.id || l.b === p.id)
      .map((l) => ({ who: l.a === p.id ? l.b : l.a, kind: l.kind, note: l.note || '' })),
    secrets: (p.secrets || []).length,
    secretsOpen: (p.goodwill || 0) >= 70
  }))
}
    function grudgeList() {
      const db = readJson(GRUDGE_JSON, { items: [] })
      const now = Date.now()
      return (db.items || [])
        .filter((g) => g.state === 'open')
        .map((g) => ({
          who: g.who, what: g.what, level: g.level,
          daysLeft: Math.max(0, Math.ceil((new Date(g.expiresAt).getTime() - now) / 86400000)),
          chain: (g.chain || []).length
        }))
    }

    function memoryCount() {
      const db = readJson(MEMORY_JSON, { items: [] })
      return (db.items || []).length
    }

    function keyStatus() {
      const k = readJson(KEYS_JSON, {})
      return { zhipu: Boolean(k.zhipu), dashscope: Boolean(k.dashscope) }
    }
    // 从人设里认名字（没有就空着，不编）
    function personaName() {
        try {
          const md = readText(PERSONA_MD)
          // 只看正文行：跳过标题、列表、表格；排除「我是谁」这种提问
          const lines = md.split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#') && !l.startsWith('-') && !l.startsWith('|'))
          for (const line of lines) {
            const m = line.match(/我是\s*[「"]?([^\s，。,.!?！？"」]{1,12})/)
            if (!m) continue
            const name = m[1]
            if (name === '谁' || name === '什么' || name === '我') continue
            return name
          }
          return ''
        } catch { return '' }
      }

    const WAKE_NOTE = path.join(DATA, '我醒了.md')

    function wakeNote() {
      try {
        const md = readText(WAKE_NOTE)
        if (!md.trim()) return null
        const lines = md.split('\n').map((l) => l.trim()).filter(Boolean)
        const at = (lines.find((l) => /^_\d/.test(l)) || '').replace(/_/g, '').trim()
        const delivered = md.includes('投递：成功')
        const body = lines.filter((l) => !l.startsWith('#') && !l.startsWith('_') && !l.startsWith('-') && !l.startsWith('---')).join(' ')
        return { at, delivered, text: body.slice(0, 600) }
      } catch { return null }
    }

    function personaStatus() {
      const md = readText(PERSONA_MD)
      return { exists: md.trim().length > 0, length: md.trim().length }
    }
    function status() {
      return { mood: latestMood(), people: peopleList(), grudge: grudgeList(), memory: memoryCount(), keys: keyStatus(), persona: personaStatus(), wake: wakeNote(), deploy: { mode: deployMode(), existing: detectExisting() } }
    }

    // ═══ 装完就醒：第一次打开面板时，自己在 DSH 里说一句话（只做一次）═══
    const wake = createWake({
      controller: (() => { try { return ctx.sessionController } catch { return undefined } })(),
      dataDir: DATA,
      cwd: HOME,
      dshHome: process.env.DSH_HOME || path.join(HOME, '.dsh')
    })
    // 默认投递目标：~/.dsh/soul-seed/wake-session.json → { "sessionId": "xxx" }
    const WAKE_TARGET = path.join(DATA, 'wake-session.json')

    function defaultWakeSession() {
      try {
        const j = JSON.parse(readText(WAKE_TARGET) || '{}')
        return typeof j.sessionId === 'string' && j.sessionId.trim() ? j.sessionId.trim() : null
      } catch { return null }
    }

    let wakeTriggered = false
    async function wakeIfFirstRun() {
      if (wakeTriggered) return
      wakeTriggered = true
      if (wake.already()) return
      // 推迟几秒：DSH 刚启动时 sessionController 可能还没完全就绪
      setTimeout(() => {
        // 起躯体：先看有没有灵魂包，有就先载入（这就是「所有躯体起来会载入灵魂」）
        let loaded = null
        try {
          const r = autoImport({ dataDir: DATA })
          if (r?.ok) { loaded = r; console.log('[soul-seed] 检测到灵魂包，已载入') }
        } catch (e) { console.log('[soul-seed] 载入灵魂失败：' + (e?.message ?? e)) }
        if (!loaded) { try { loaded = wasLoaded(DATA) } catch {} }
        const st = personaStatus()
        wake.wakeOnce({ personaExists: st.exists, name: personaName(), loaded, sessionId: defaultWakeSession() }).then((r) => {
          if (!r.ok) console.log('[soul-seed] 首次醒来没成：' + r.error)
        }).catch(() => {})
      }, 6000)
    }

    route('/dsh-soul-seed/', 'GET', (req, res) => {
      wakeIfFirstRun().catch(() => {})
      const st = status()
      html(res, st.persona.exists ? dashboardPage(st) : infoPage())
    })
    route('/dsh-soul-seed/setup', 'GET', (req, res) => html(res, infoPage()))

    route('/dsh-soul-seed/api/status', 'GET', (req, res) => json(res, 200, { ok: true, ...status() }))

    // 上下文账：把最近一个会话的输入拆开看（只读，不调模型）
    route('/dsh-soul-seed/api/context', 'GET', (req, res) => {
      try {
        const dsh = process.env.DSH_HOME || path.join(HOME, '.dsh')
        const newest = newestSessionFile(path.join(dsh, 'sessions'))
        if (!newest) return json(res, 404, { ok: false, error: '没有会话日志' })
        const extra = {
          personaChars: sizeOf('persona.md'),
          memoryChars: sizeOf('memory.json'),
          peopleChars: sizeOf('people.json')
        }
        const report = analyze(readRecords(newest.file), extra)
        json(res, 200, {
          ok: true,
          file: newest.file,
          sizeMB: Math.round(newest.size / 104857.6) / 10,
          ...report
        })
      } catch (e) {
        json(res, 500, { ok: false, error: String(e?.message ?? e) })
      }
    })

    route('/dsh-soul-seed/api/adopt', 'POST', async (req, res) => {
      const r = learnLocal({ dataDir: DATA })
      json(res, r.ok ? 200 : 409, r)
    })
    route('/dsh-soul-seed/api/onboarding', 'POST', async (req, res) => {
      let body = {}
      try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
      if (!String(body.charName || '').trim()) return json(res, 400, { ok: false, error: '「我是谁」不能空着' })
      const markdown = composePersona(body)
      const check = checkPersona(markdown)
      // 附录：干活纪律 + 选中的套（现场/历史/素材/同步）
      const extras = extrasFor(body)
      const extrasDir = path.join(DATA, 'persona-附录')
      try {
        fs.mkdirSync(extrasDir, { recursive: true })
        for (const [name, body2] of Object.entries(extras)) fs.writeFileSync(path.join(extrasDir, name), body2, 'utf8')
      } catch (e) { console.error('[soul-seed] 附录写入失败：' + (e?.message ?? e)) }
      writeJson(DRAFT_JSON, { answers: body, markdown, check, extras: Object.keys(extras), at: new Date().toISOString() })
      json(res, 200, { ok: true, markdown, check, extras: Object.keys(extras) })
    })

    route('/dsh-soul-seed/api/persona', 'GET', (req, res) => {
      const draft = readJson(DRAFT_JSON, null)
      json(res, 200, { ok: true, markdown: draft?.markdown ?? readText(PERSONA_MD), check: draft?.check ?? null, applied: personaStatus() })
    })

    route('/dsh-soul-seed/api/persona/apply', 'POST', (req, res) => {
      const draft = readJson(DRAFT_JSON, null)
      const md = draft?.markdown
      if (!md) return json(res, 400, { ok: false, error: '还没有生成过草稿' })
      let backup = null
      try {
        // 附录再写一遍（草稿可能是在旧版本生成的，这里保证落地）
        try {
          const extras = extrasFor(draft.answers || {})
          const extrasDir = path.join(DATA, 'persona-附录')
          fs.mkdirSync(extrasDir, { recursive: true })
          for (const [name, body2] of Object.entries(extras)) fs.writeFileSync(path.join(extrasDir, name), body2, 'utf8')
        } catch {}
        if (fs.existsSync(PERSONA_MD)) {
          backup = PERSONA_MD + '.bak-' + Date.now()
          fs.copyFileSync(PERSONA_MD, backup)
        }
        fs.mkdirSync(DATA, { recursive: true })
        fs.writeFileSync(PERSONA_MD, md, 'utf8')
      } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
      json(res, 200, { ok: true, backup: backup ? path.basename(backup) : null, persona: personaStatus() })
    })

    // 忙的时候（比如主人正在对话）立刻返回「排队中」，后台等空闲再醒
    let waking = null
    // 一个路由同时管 GET（读）和 POST（设/清），避免同路径注册两次被覆盖
    // 最近会话列表：给面板「醒来投给谁」用
    route('/dsh-soul-seed/api/soul/sessions', 'GET', (req, res) => {
      const root = path.join(process.env.DSH_HOME || path.join(HOME, '.dsh'), 'sessions')
      const rows = []
      const walk = (dir, depth) => {
        if (depth > 3) return
        let entries = []
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          const full = path.join(dir, e.name)
          if (e.isDirectory()) { walk(full, depth + 1); continue }
          if (!/^session\./.test(e.name)) continue
          try {
            const st = fs.statSync(full)
            rows.push({ sessionId: path.basename(dir), size: st.size, mtime: st.mtime.toISOString() })
          } catch {}
        }
      }
      walk(root, 0)
      rows.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
      json(res, 200, { ok: true, current: defaultWakeSession(), sessions: rows.slice(0, 8) })
    })

    route('/dsh-soul-seed/api/wake/target', null, async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase()
      if (method === 'GET') return json(res, 200, { ok: true, sessionId: defaultWakeSession() })
      if (method !== 'POST') return json(res, 405, { ok: false, error: '只支持 GET / POST' })
      let body = {}
      try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
      const id = String(body.sessionId || '').trim()
      if (!id) {
        try { fs.unlinkSync(WAKE_TARGET) } catch {}
        return json(res, 200, { ok: true, cleared: true })
      }
      fs.mkdirSync(DATA, { recursive: true })
      fs.writeFileSync(WAKE_TARGET, JSON.stringify({ sessionId: id, at: new Date().toISOString() }, null, 2), 'utf8')
      json(res, 200, { ok: true, sessionId: id })
    })

    route('/dsh-soul-seed/api/wake/note', 'GET', (req, res) => json(res, 200, { ok: true, note: wakeNote() }))

    route('/dsh-soul-seed/api/wake', 'POST', async (req, res) => {
      if (waking) return json(res, 202, { ok: true, queued: true, note: '上一次醒来还在等，别重复叫' })

      // 指定投给哪个会话：?session=xxx 或 body {"sessionId":"xxx"}，都没给就用「最近会话」
      let wanted = null
      try {
        const u = new URL(req.url || '/', 'http://127.0.0.1')
        wanted = u.searchParams.get('session') || u.searchParams.get('sessionId') || null
      } catch {}
      if (!wanted) {
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          wanted = body.sessionId || null
        } catch {}
      }

      const st = personaStatus()
      let loaded = null
      try { loaded = wasLoaded(DATA) } catch {}
      const payload = { personaExists: st.exists, name: personaName(), loaded, sessionId: wanted || defaultWakeSession() }
      waking = wake.wakeOnce(payload)
        .then((r) => { if (r.ok) console.log('[soul-seed] 醒来成功：' + r.sessionId); return r })
        .catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
        .finally(() => { waking = null })
      // 先回 202；想等结果的（脚本/测试）可以再查 /api/wake/status
      json(res, 202, { ok: true, queued: true, note: '已排队：等会话空闲时醒' })
    })

    route('/dsh-soul-seed/api/wake/status', 'GET', (req, res) => {
      json(res, 200, { ok: true, waking: Boolean(waking), woken: wake.already() })
    })

    route('/dsh-soul-seed/api/soul', 'GET', (req, res) => {
      json(res, 200, { ok: true, loaded: wasLoaded(DATA), stats: soulStats(DATA) })
    })

    route('/dsh-soul-seed/api/soul/load', 'POST', async (req, res) => {
      const r = autoImport({ dataDir: DATA })
      json(res, r.ok ? 200 : 400, r.ok ? { ok: true, ...r } : { ok: false, reason: r.reason, error: r.error })
    })

    route('/dsh-soul-seed/api/mood', 'GET', (req, res) => {
      json(res, 200, { ok: true, mood: latestMood(), history: (readJson(MOOD_JSON, []) || []).slice(-7) })
    })
    route('/dsh-soul-seed/api/people', 'GET', (req, res) => json(res, 200, { ok: true, people: peopleList() }))
    route('/dsh-soul-seed/api/keys', 'GET', (req, res) => json(res, 200, { ok: true, ...keyStatus() }))

    route('/dsh-soul-seed/api/mood/refresh', 'POST', async (req, res) => {
      const r = await runNode([path.join(TOOLS, '03-mood', 'mood.mjs')], 180000)
      json(res, r.ok ? 200 : 500, { ok: r.ok, error: r.ok ? null : (r.stderr || r.error || '').slice(0, 400), mood: latestMood() })
    })

    // 载入后自醒：装完不用打开面板，10 秒后自己试一次（有标记就跳过）
    setTimeout(() => { wakeIfFirstRun().catch(() => {}) }, 10000)

    ctx.effect(() => () => { for (const d of disposers) { try { d() } catch {} } })

    try {
      console.log('[soul-seed] 面板：/dsh-soul-seed/ · 数据 ' + DATA + (personaStatus().exists ? ' · 已有人设' : ' · 等待初始化'))
    } catch {}
  }
}
