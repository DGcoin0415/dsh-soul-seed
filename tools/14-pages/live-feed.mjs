// 实时共享：把所有工作区的会话新消息按标签追加到 shared/实时.md。
// 每 2 小时一份（shared/实时/MM-DD-HH.md），实时.md 只镜像当前段，超过两天的段直接清。
// 平时 3 分钟扫一次；碰到规则类 / 维护类的消息，切成 30 秒扫，持续 15 分钟。
// 手动加速：touch shared/.live-fast（一小时内有效）。停：建 shared/.live-feed-stop。
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const DSH = path.join(os.homedir(), '.dsh')
const HOME = process.env.DSH_SOUL_DIR || process.env.SOUL_HOME || path.join(DSH, 'im')
const SESSIONS = path.join(DSH, 'sessions')
const ARCHIVE = SESSIONS + '-archive'
const OUT = path.join(HOME, 'shared', '实时.md')
const DIR = path.join(HOME, 'shared', '实时')
const STATE = path.join(HOME, 'shared', '.live-feed.state.json')
const FAST_FLAG = path.join(HOME, 'shared', '.live-fast')
const STOP_FLAG = path.join(HOME, 'shared', '.live-feed-stop')
const PID_FILE = path.join(HOME, 'shared', '.live-feed.pid')

const BASE_MS = 180 * 1000
const FAST_MS = 30 * 1000
const FAST_HOLD_MS = 15 * 60 * 1000
const FIRST_RUN_WINDOW_MS = 2 * 60 * 60 * 1000
const KEYWORDS = /规则|维护|重启|部署|升级|版本|回滚|迁移|改配置|人设|权限|同步/

const p2 = (n) => String(n).padStart(2, '0')
const stamp = (ms) => {
  const d = new Date(ms)
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

function decode(file) {
  const buf = fs.readFileSync(file)
  const starts = []
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
  }
  const chunks = []
  for (let k = 0; k < starts.length; k++) {
    const a = starts[k]
    const b = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(a, b)))
    } catch {}
  }
  return Buffer.concat(chunks).toString('utf8')
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((x) => x && (x.type === 'text' || x.type === 'input_text') && typeof x.text === 'string')
    .map((x) => x.text)
    .join('')
}

// 会话 id → 渠道标签
function channelMap() {
  const map = {}
  const readJson = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      return null
    }
  }
  const put = (sessions, labels) => {
    if (!sessions) return
    for (const [key, sid] of Object.entries(sessions)) {
      if (typeof sid !== 'string') continue
      for (const [prefix, label] of Object.entries(labels)) {
        if (key.startsWith(prefix)) map[sid] = label
      }
    }
  }
  const qqDir = path.join(DSH, 'integrations', 'dsh-qq', 'bots')
  if (fs.existsSync(qqDir)) {
    for (const id of fs.readdirSync(qqDir)) {
      const st = readJson(path.join(qqDir, id, 'state.json'))
      if (st) put(st.sessions, { 'c2c:': 'QQ私聊', group: 'QQ群' })
    }
  }
  const wxDir = path.join(DSH, 'integrations', 'dsh-weixin', 'accounts')
  if (fs.existsSync(wxDir)) {
    for (const id of fs.readdirSync(wxDir)) {
      const st = readJson(path.join(wxDir, id, 'state.json'))
      if (st) put(st.sessions, { 'p2p:': '微信', group: '微信群' })
    }
  }
  return map
}

function workspaceLabel(dirName) {
  const inner = dirName.replace(/^--|--$/g, '')
  if (inner.includes('dsh-im') || inner.includes('dsh\im')) return '面板'
  if (inner.includes('weixin') || inner.includes('wechat')) return '微信'
  if (inner.includes('terminal') || inner.includes('work')) return '终端'
  return '其他'
}

function sessionFiles() {
  const out = []
  for (const base of [SESSIONS, ARCHIVE]) {
    if (!fs.existsSync(base)) continue
    for (const ws of fs.readdirSync(base, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue
      const wsDir = path.join(base, ws.name)
      for (const s of fs.readdirSync(wsDir, { withFileTypes: true })) {
        if (!s.isDirectory()) continue
        const f = path.join(wsDir, s.name, 'session.v4.jsonl.zstd')
        if (fs.existsSync(f)) out.push({ file: f, ws: ws.name, sid: s.name })
      }
    }
  }
  return out
}

const NOISE = ['Current runtime context.', 'Time sampled while preparing turn', '[model changed', '<dsh_im_files>', '<system-reminder>', '<available_skills>']

const state = fs.existsSync(STATE)
  ? JSON.parse(fs.readFileSync(STATE, 'utf8').replace(/^\uFEFF/, ''))
  : { seen: {}, files: {}, fastUntil: 0 }
const seen = state.seen || (state.seen = {})
const files = state.files || (state.files = {})
const firstRun = Object.keys(files).length === 0
const since = firstRun ? Date.now() - FIRST_RUN_WINDOW_MS : 0

function segOf(ms) {
  const d = new Date(ms)
  const h = Math.floor(d.getHours() / 2) * 2
  return {
    key: `${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(h)}`,
    label: `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(h)}:00-${p2(h + 2)}:00`,
  }
}

// 每 2 小时一份：实时.md 只镜像当前段，超过两天的段直接删（全量存档在 shared/全量/）
function rewriteLive(rows) {
  const cur = segOf(Date.now())
  fs.mkdirSync(DIR, { recursive: true })
  const head = (s) => `# 实时共享 · ${s.label}\n\n> 标签：实时 · 对话 | 每 2 小时一份，超过两天直接清；全量在 shared/全量/。\n\n## 对话\n\n`
  const curFile = path.join(DIR, `${cur.key}.md`)
  if (!fs.existsSync(curFile)) fs.writeFileSync(curFile, head(cur), 'utf8')
  for (const r of rows) {
    const s = segOf(r.time)
    const f = path.join(DIR, `${s.key}.md`)
    if (!fs.existsSync(f)) fs.writeFileSync(f, head(s), 'utf8')
    fs.appendFileSync(f, r.line, 'utf8')
  }
  fs.copyFileSync(curFile, OUT)
  const cutoff = Date.now() - 2 * 86400_000
  const segTime = (key) => {
    const [mm, dd, hh] = key.split('-').map(Number)
    const d = new Date(new Date().getFullYear(), mm - 1, dd, hh)
    if (d.getTime() > Date.now() + 180 * 86400_000) d.setFullYear(d.getFullYear() - 1)
    return d.getTime()
  }
  for (const name of fs.readdirSync(DIR)) {
    if (!name.endsWith('.md')) continue
    if (segTime(name.slice(0, -3)) < cutoff) {
      try { fs.unlinkSync(path.join(DIR, name)) } catch {}
    }
  }
}

function scan() {
  let added = 0
  let fast = false
  const map = channelMap()
  const rows = []

  for (const { file, ws, sid } of sessionFiles()) {
    let mtime
    try {
      mtime = fs.statSync(file).mtimeMs
    } catch {
      continue
    }
    if (files[file] === mtime) continue
    let raw
    try {
      raw = decode(file)
    } catch {
      continue
    }
    files[file] = mtime
    const label = map[sid] || workspaceLabel(ws)
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let d
      try {
        d = JSON.parse(line)
      } catch {
        continue
      }
      if (!d.time || d.time < since) continue
      let role = null
      let text = ''
      if (d.type === 'user/message') {
        text = textOf(d.data?.content).trim()
        role = '用户'
      } else if (d.type === 'assistant/message') {
        text = textOf(d.data?.message?.content).trim()
        role = '米萨'
      }
      if (!role || !text) continue
      if (text.startsWith('<') || NOISE.some((n) => text.startsWith(n))) continue
      text = text.replace(/\s*\n+\s*/g, ' ').trim()
      const key = crypto.createHash('sha1').update(`${d.time}|${role}|${text.slice(0, 120)}`).digest('hex').slice(0, 14)
      if (seen[key]) continue
      seen[key] = 1
      added++
      if (KEYWORDS.test(text)) fast = true
      rows.push({ time: d.time, line: `- [${stamp(d.time)}] [${label}] ${role}：${text.slice(0, 240)}\n` })
    }
  }

  if (rows.length) {
    rows.sort((a, b) => a.time - b.time)
    rewriteLive(rows)
  } else {
    rewriteLive([])
  }

  if (fast) state.fastUntil = Date.now() + FAST_HOLD_MS
  try {
    if (fs.existsSync(FAST_FLAG) && Date.now() - fs.statSync(FAST_FLAG).mtimeMs < 60 * 60 * 1000) {
      state.fastUntil = Date.now() + FAST_HOLD_MS
    }
  } catch {}
  fs.writeFileSync(STATE, JSON.stringify(state, null, 0), 'utf8')
  return added
}

function interval() {
  const fastUntil = Math.max(state.fastUntil || 0, 0)
  return Date.now() < fastUntil ? FAST_MS : BASE_MS
}

try {
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8')
} catch {}

let stopped = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  try {
    process.on(sig, () => {
      stopped = true
    })
  } catch {}
}

while (!stopped) {
  if (fs.existsSync(STOP_FLAG)) break
  try {
    scan()
  } catch (e) {
    try {
      fs.appendFileSync(path.join(HOME, 'wake.log'), `${new Date().toISOString()} live-feed: ${e?.message ?? e}\n`, 'utf8')
    } catch {}
  }
  if (process.env.LIVE_FEED_ONCE) break
  const wait = interval()
  await new Promise((r) => setTimeout(r, wait))
}

try {
  fs.unlinkSync(PID_FILE)
} catch {}
