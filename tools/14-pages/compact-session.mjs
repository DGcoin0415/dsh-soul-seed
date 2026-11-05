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
const cutoff = Date.now() - HOURS * 3600 * 1000

// 同一时间可能开了好几个会话（两个窗口、换过会话），都算进来，不然会漏
function recentSessions() {
  const ws = '--' + HOME.replace(/[:\\/]+/g, '-') + '--'
  const roots = [path.join(SESSIONS, ws), SESSIONS].filter((d) => fs.existsSync(d))
  const found = []
  for (const root of roots) {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      const m = fs.statSync(f).mtimeMs
      if (m >= cutoff - 3600 * 1000) found.push({ m, f, dir: d })
    }
  }
  return found.sort((a, b) => b.m - a.m).slice(0, 6)
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

// 系统塞进来的那些，不是人说的话
const NOISE = [/^Current runtime context/, /^Time sampled while preparing/, /^\[model changed/, /^<dsh_im_files>/, /^<system-reminder>/, /^<available_skills>/]
const noisy = (t) => t.startsWith('<') || NOISE.some((re) => re.test(t))

const found = recentSessions()
if (!found.length) {
  console.error('没找到会话文件：' + SESSIONS)
  process.exit(1)
}

const rows = []
const seen = new Set()
for (const s of found) {
  let raw
  try {
    raw = decode(s.f)
  } catch {
    continue
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (!d.time || d.time < cutoff) continue
    let role = null
    let text = ''
    if (d.type === 'user/message') {
      text = textOf(d.data?.content).trim()
      role = 'master'
    } else if (d.type === 'assistant/message') {
      text = textOf(d.data?.message?.content).trim()
      role = '米萨'
    }
    if (!role || !text || noisy(text)) continue
    text = text.replace(/\n+/g, ' ').trim()
    // 图片附件清单这类尾巴不要，正文留下
    const cut = text.indexOf('<dsh_im_files>')
    if (cut > 0) text = text.slice(0, cut).trim()
    const key = `${d.time}|${role}|${text.slice(0, 80)}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ ms: d.time, role, text })
  }
}

rows.sort((a, b) => a.ms - b.ms)

// 12 小时也可能聊出好几百条，接续页按字数封顶（约 1.2 万字），更早的去页里翻
const CAP_CHARS = 3000
let kept = 0
let used = 0
for (let i = rows.length - 1; i >= 0; i--) {
  const len = rows[i].text.length + 20
  if (used + len > CAP_CHARS) break
  used += len
  kept++
}
const dropped = rows.length - kept
if (dropped > 0) rows.splice(0, dropped)

const p = (n) => String(n).padStart(2, '0')
const fmt = (ms) => {
  const d = new Date(ms)
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 每条后面挂个「下一跳」：这条出自哪一页，想细看直接翻那页
const pageOf = (ms) => {
  const d = new Date(ms)
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return `${day}-${d.getHours() < 12 ? 'AM' : 'PM'}`
}

const head = [
  `# 接续 · 最近 ${HOURS} 小时`,
  '',
  `> 生成于 ${fmt(Date.now())}，来源 ${found.length} 个会话`,
  `> 共 ${rows.length} 条${dropped ? `（更早的 ${dropped} 条留在分页里）` : ''}。括号里是出处页，想细看翻 ` + '`shared/全量/页/` 里对应那页。',
  '',
]
const body = rows.map((r) => `- [${fmt(r.ms)}] ${r.role}：${r.text.replace(/\n+/g, ' ').slice(0, 400)} 〔${pageOf(r.ms)}〕`)
fs.writeFileSync(OUT, head.concat(body).join('\n') + '\n', 'utf8')

console.log(`接续页写好了：${rows.length} 条（${found.length} 个会话）→ ${OUT}`)
