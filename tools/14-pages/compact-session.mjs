import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import os from 'node:os'

// 把最近 N 小时的对话抽成一页「接续」，给新会话当开头。
// 用法：node tools/14-pages/compact-session.mjs [小时数，默认 12]
// 可选环境变量：SOUL_HOME（默认 ~/.dsh/im）、SOUL_SESSIONS（默认 ~/.dsh/sessions）
const HOME = process.env.SOUL_HOME || path.join(os.homedir(), '.dsh', 'im')
const SESSIONS = process.env.SOUL_SESSIONS || path.join(os.homedir(), '.dsh', 'sessions')
const OUT = path.join(HOME, 'shared', '接续.md')
const HOURS = Number(process.argv[2] || 12)

function newest() {
  // 只找这个工作区的会话：~/.dsh/sessions/--C-...-.dsh-im--/session-xxx/
  const ws = '--' + HOME.replace(/[:\\/]+/g, '-') + '--'
  const roots = [path.join(SESSIONS, ws), SESSIONS].filter((d) => fs.existsSync(d))
  let best = null
  for (const root of roots) {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, 'session.v4.jsonl.zstd')
      if (fs.existsSync(f)) {
        const m = fs.statSync(f).mtimeMs
        if (!best || m > best.m) best = { m, f, dir: d }
      }
    }
  }
  return best
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

const s = newest()
if (!s) {
  console.error('没找到会话文件：' + SESSIONS)
  process.exit(1)
}

const cutoff = Date.now() - HOURS * 3600 * 1000
const rows = []
for (const line of decode(s.f).split('\n')) {
  if (!line.trim()) continue
  let d
  try {
    d = JSON.parse(line)
  } catch {
    continue
  }
  if (!d.time || d.time < cutoff) continue
  if (d.type === 'user/message') {
    const t = textOf(d.data?.content).trim()
    if (t && !t.startsWith('<')) rows.push({ ms: d.time, role: 'master', text: t })
  } else if (d.type === 'assistant/message') {
    const t = textOf(d.data?.message?.content).trim()
    if (t) rows.push({ ms: d.time, role: '米萨', text: t })
  }
}

rows.sort((a, b) => a.ms - b.ms)

const p = (n) => String(n).padStart(2, '0')
const fmt = (ms) => {
  const d = new Date(ms)
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const head = [
  `# 接续 · 最近 ${HOURS} 小时`,
  '',
  `> 生成于 ${fmt(Date.now())}，来源会话 ${s.dir}`,
  `> 共 ${rows.length} 条。更早的事按 12 小时分页存在 \`shared/全量/页/\`，先看那里的 \`索引.md\`，从最新一页往前一页一页翻；翻不到再用 \`soul action=rag-recall\`。`,
  '',
]
const body = rows.map((r) => `- [${fmt(r.ms)}] ${r.role}：${r.text.replace(/\n+/g, ' ').slice(0, 400)}`)
fs.writeFileSync(OUT, head.concat(body).join('\n') + '\n', 'utf8')

console.log(`接续页写好了：${rows.length} 条 → ${OUT}`)
