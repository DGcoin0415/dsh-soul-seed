import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'

// 全量记忆本：把会话原文按天存到 shared/全量/YYYY-MM-DD.md
// 只追加缺的，不重写已有；原始对话不改一个字。
const SESS_ROOT = 'C:/Users/Administrator/.dsh/sessions/--C-Users-Administrator-.dsh-im--'
const OUT_DIR = 'C:/Users/Administrator/.dsh/im/shared/全量'

function newestSession() {
  const dirs = fs.readdirSync(SESS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const f = path.join(SESS_ROOT, d.name, 'session.v4.jsonl.zstd')
      return fs.existsSync(f) ? { dir: d.name, file: f, mtime: fs.statSync(f).mtimeMs } : null
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
  return dirs[0]
}

function decode(file) {
  const buf = fs.readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
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

function dayOf(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function clockOf(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

const session = newestSession()
if (!session) {
  console.log('no session')
  process.exit(1)
}
fs.mkdirSync(OUT_DIR, { recursive: true })

const raw = decode(session.file)
const rows = []
for (const line of raw.split('\n')) {
  if (!line.trim()) continue
  let d
  try {
    d = JSON.parse(line)
  } catch {
    continue
  }
  if (d.type === 'user/message') {
    const t = textOf(d.data?.content).trim()
    if (t && !t.startsWith('<')) rows.push({ ms: d.time, role: 'master', text: t })
  } else if (d.type === 'assistant/message') {
    const t = textOf(d.data?.message?.content).trim()
    if (t) rows.push({ ms: d.time, role: '米萨', text: t })
  }
}

// 读出所有已存行的时间+角色+开头做去重
const existing = new Map()
for (const f of fs.readdirSync(OUT_DIR)) {
  if (!f.endsWith('.md')) continue
  const text = fs.readFileSync(path.join(OUT_DIR, f), 'utf8')
  for (const m of text.matchAll(/^- \[(\d{2}:\d{2})\] (master|米萨)：/gm)) {
    existing.set(f + '|' + m[1] + '|' + m[2], true)
  }
}

const byDay = new Map()
let added = 0
for (const r of rows) {
  const day = dayOf(r.ms)
  const clock = clockOf(r.ms)
  const key = day + '.md|' + clock + '|' + r.role
  if (existing.has(key)) continue
  if (!byDay.has(day)) byDay.set(day, [])
  byDay.get(day).push({ clock, role: r.role, text: r.text })
  existing.set(key, true)
  added++
}

for (const [day, list] of byDay) {
  const file = path.join(OUT_DIR, day + '.md')
  const head = fs.existsSync(file)
    ? ''
    : `# 全量记忆 · ${day}\n\n> 会话原文，不改一个字。工具调用不在里面。\n\n`
  const body = list.map((x) => `- [${x.clock}] ${x.role}：${x.text.replace(/\n+/g, ' ')}`).join('\n') + '\n'
  fs.appendFileSync(file, head + body, 'utf8')
}

console.log(`全量导出：新增 ${added} 条，涉及 ${byDay.size} 天`)
