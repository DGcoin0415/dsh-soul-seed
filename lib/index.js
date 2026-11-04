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
 *   2. 按人账本（master / qq:<openid> / wx:<wxid> / bili:<mid>）
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
import { QUESTIONS, SPEECH_QUESTIONS, SET_QUESTIONS, DEFAULT_RULES, composePersona, checkPersona, extrasFor } from './persona.mjs'
import { soulHome } from './home.mjs'

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

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback }
}
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8')
}
function readText(p) { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }

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
  inject: ['webServer'],
  apply(ctx) {
  // 启动留痕：确认 apply 有没有跑，看这个文件就知道
  try {
    const bootDir = soulHome()
    fs.mkdirSync(bootDir, { recursive: true })
    fs.appendFileSync(path.join(bootDir, 'soul-boot.log'), new Date().toISOString() + ' apply called\n')
  } catch {}

    const disposers = []

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
