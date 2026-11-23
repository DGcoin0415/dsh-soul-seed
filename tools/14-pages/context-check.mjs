// 查会话真实上下文占用（按 token，不再按压缩文件大小估）
// 用法：node tools/14-pages/context-check.mjs [窗口token，默认1048576] [阈值百分比，默认60] [会话目录，可选]
//   会话目录不填时按当前工作目录推导：~/.dsh/sessions/--<cwd 转义>--
//   退出码：0 未到阈值；1 到阈值（该写交接）；2 读不到会话
// 读会话文件里最后一条 assistant/message 的 usage.totalTokens：它≈下一轮要发出去的消息量
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const WINDOW = Number(process.argv[2] || 1048576)
const LIMIT = Number(process.argv[3] || 60)
const ROOT = process.argv[4] || path.join(
  os.homedir(),
  '.dsh/sessions',
  `--${process.cwd().replace(/[:\\]/g, '-')}--`,
)
const LOG = path.join(process.cwd(), 'shared/context-usage.log')
const ACTIVE_HOURS = 12
const USAGE_RE = /"usage":\{"inputTokens":(\d+),"outputTokens":(\d+),"cacheReadTokens":(\d+),"cacheWriteTokens":(\d+),"totalTokens":(\d+)\}/

function decode(buf) {
  const idxs = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) idxs.push(i)
  }
  const outs = []
  for (let k = 0; k < idxs.length; k++) {
    const start = idxs[k]
    const end = k + 1 < idxs.length ? idxs[k + 1] : buf.length
    try { outs.push(zlib.zstdDecompressSync(buf.subarray(start, end))) } catch { /* 写入中的半帧跳过 */ }
  }
  return Buffer.concat(outs).toString('utf8')
}

function lastInfo(file) {
  const text = decode(fs.readFileSync(file))
  const lines = text.split('\n')
  let last = null
  let lastTurnEnd = null
  let lastUser = -1
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l) continue
    let o
    try { o = JSON.parse(l) } catch { continue }
    if (o.type === 'user/message') lastUser = i
    else if (o.type === 'assistant/message') {
      const m = JSON.stringify(o.data).match(USAGE_RE)
      if (m) last = Number(m[5])
    } else if (o.type === 'turn/end') {
      lastTurnEnd = { i, err: JSON.stringify(o.data).indexOf('CONTEXT_WINDOW_EXCEEDED') >= 0 }
    }
  }
  const dead = !!(lastTurnEnd && lastTurnEnd.err && lastTurnEnd.i > lastUser)
  return { total: last, dead }
}

const now = Date.now()
const sessions = []
if (!fs.existsSync(ROOT)) {
  console.log(`找不到会话目录：${ROOT}`)
  process.exit(2)
}
for (const d of fs.readdirSync(ROOT)) {
  const f = path.join(ROOT, d, 'session.v4.jsonl.zstd')
  if (!fs.existsSync(f)) continue
  const st = fs.statSync(f)
  if (now - st.mtimeMs > ACTIVE_HOURS * 3600 * 1000) continue
  sessions.push({ id: d, f, m: st.mtimeMs })
}
sessions.sort((a, b) => b.m - a.m)

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
let alert = false
if (!sessions.length) { console.log('最近没有活跃会话'); process.exit(0) }
for (const s of sessions) {
  let info = null
  try { info = lastInfo(s.f) } catch { info = null }
  const total = info && info.total
  if (total == null) {
    fs.appendFileSync(LOG, `${stamp} 会话 ${s.id} 读不到 usage，跳过\n`)
    console.log(`会话 ${s.id} 读不到 usage，跳过`)
    continue
  }
  const pct = Math.min(100, Math.round((total / WINDOW) * 100))
  const dead = info.dead ? '（已超窗结束，不再接管）' : ''
  const line = `${stamp} 会话 ${s.id} 约 ${total} tokens / ${WINDOW} ≈ ${pct}%${dead}`
  fs.appendFileSync(LOG, line + '\n')
  console.log(line)
  if (info.dead) continue
  if (pct >= LIMIT) { alert = true; console.log(`ALERT ${s.id} ${pct}% ≥ ${LIMIT}%，该写交接了`) }
}
if (alert) process.exit(1)
console.log(`OK 未到 ${LIMIT}%`)
