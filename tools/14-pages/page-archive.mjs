import { sharedHome } from '../../lib/shared.mjs'
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

// 把对话按「12 小时一页」切好，存到 <SOUL_HOME>/shared/全量/页/。
// 新会话只按页往前翻，翻不到才去看整天全量。
//
// 用法：node tools/14-pages/page-archive.mjs
// 可选环境变量：
//   SOUL_HOME      灵魂工作区，默认 ~/.dsh/im
//   SOUL_SESSIONS  DSH 会话目录，默认 ~/.dsh/sessions
const HOME = sharedHome()
const SESSIONS = process.env.SOUL_SESSIONS || path.join(os.homedir(), '.dsh', 'sessions')
const ARCHIVE = SESSIONS + '-archive'
const OUT_DIR = path.join(HOME, 'shared', '全量', '页')
const STATE = path.join(OUT_DIR, '.state.json')
const INDEX = path.join(OUT_DIR, '索引.md')
const CONT = path.join(HOME, 'shared', '接续.md')

fs.mkdirSync(OUT_DIR, { recursive: true })

const p = (n) => String(n).padStart(2, '0')
const fmtHM = (ms) => {
  const d = new Date(ms)
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}
const fmtDay = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// DSH 的会话文件是 zstd 帧拼接的，按魔数切帧逐段解
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

function sessions() {
  // 只扫这个工作区的会话（DSH 把工作区路径编码成目录名：C--Users-...-dsh-im--）
  const ws = '--' + HOME.replace(/[:\\/]+/g, '-') + '--'
  const root = path.join(SESSIONS, ws)
  const out = []
  for (const base of [fs.existsSync(root) ? root : SESSIONS, ARCHIVE]) {
    if (!fs.existsSync(base)) continue
    const stack = [base]
    while (stack.length) {
      const dir = stack.pop()
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) stack.push(full)
        else if (e.name === 'session.v4.jsonl.zstd') out.push(full)
      }
    }
  }
  return out
}

const NOISE = ['Current runtime context.', 'Time sampled while preparing turn', '[model changed', '<dsh_im_files>', '<system-reminder>', '<available_skills>']

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8').replace(/^\uFEFF/, '')) : { seen: {}, pages: {} }
const seen = state.seen
const pages = state.pages
const files = state.files || (state.files = {})
let added = 0
let scanned = 0

for (const file of sessions()) {
  // 会话文件没动过就不用再解一遍，省时间
  const mtime = fs.statSync(file).mtimeMs
  if (files[file] === mtime) continue
  let raw
  try {
    raw = decode(file)
  } catch {
    continue
  }
  scanned++
  files[file] = mtime
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (!d.time) continue
    let role = null
    let text = ''
    if (d.type === 'user/message') {
      text = textOf(d.data?.content).trim()
      role = 'master'
    } else if (d.type === 'assistant/message') {
      text = textOf(d.data?.message?.content).trim()
      role = '米萨'
    }
    if (!role || !text) continue
    if (text.startsWith('<') || NOISE.some((n) => text.startsWith(n))) continue
    text = text.replace(/\n+/g, ' ').trim()
    const key = crypto.createHash('sha1').update(`${d.time}|${role}|${text.slice(0, 120)}`).digest('hex').slice(0, 14)
    if (seen[key]) continue
    seen[key] = 1
    added++

    const dt = new Date(d.time)
    const day = fmtDay(d.time)
    const slot = dt.getHours() < 12 ? 'AM' : 'PM'
    const name = `${day}-${slot}.md`
    const f = path.join(OUT_DIR, name)
    if (!fs.existsSync(f)) {
      fs.writeFileSync(f, `# ${day} ${slot === 'AM' ? '上午' : '下午'}（00:00–12:00 / 12:00–24:00 页）\n\n> 自动分页，一行一条，只记说了什么。\n\n`, 'utf8')
    }
    fs.appendFileSync(f, `- [${fmtHM(d.time)}] ${role}：${text.slice(0, 300)}\n`, 'utf8')
    const meta = pages[name] || { count: 0, first: d.time, last: d.time, hint: '' }
    meta.count++
    if (d.time < meta.first) meta.first = d.time
    if (d.time > meta.last) meta.last = d.time
    if (!meta.hint && text.length > 8 && !/^[?\s]/.test(text)) meta.hint = text.slice(0, 40)
    pages[name] = meta
  }
}

fs.writeFileSync(STATE, JSON.stringify({ seen, pages, files }, null, 0), 'utf8')

const rows = Object.entries(pages).sort((a, b) => b[1].last - a[1].last)
const lines = [
  '# 12 小时分页 · 索引',
  '',
  `> 自动生成 ${fmtDay(Date.now())} ${fmtHM(Date.now())}。共 ${rows.length} 页。`,
  `> 读法：新会话先读 \`shared/接续.md\`（最近 12 小时）；往前找就按这张表一页一页翻，一次只读一页。`,
  '',
  '| 页 | 时段 | 条数 | 那会儿在说啥 |',
  '| --- | --- | --- | --- |',
]
for (const [name, m] of rows) {
  const slot = name.includes('-AM') ? '上午' : '下午'
  lines.push(`| [${name}](${name}) | ${fmtDay(m.first)} ${slot} | ${m.count} | ${m.hint.replace(/\|/g, '/')} |`)
}
fs.writeFileSync(INDEX, lines.join('\n') + '\n', 'utf8')

if (fs.existsSync(CONT)) {
  const cur = fs.readFileSync(CONT, 'utf8')
  const marker = '\n> 更早的事：先看 `shared/全量/页/索引.md`，从最新那页往前翻；翻不到再看 `shared/全量/YYYY-MM-DD.md`。\n'
  if (!cur.includes('shared/全量/页/索引.md')) fs.appendFileSync(CONT, marker, 'utf8')
}

console.log(`扫了 ${scanned} 个会话，新增 ${added} 条，${rows.length} 页，索引已更新`)
