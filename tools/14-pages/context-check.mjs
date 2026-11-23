// 每小时查一次会话大小，估上下文占用；超阈值提示该开新会话/写交接
// 用法：node tools/14-pages/context-check.mjs [上限MB，默认3.85] [阈值百分比，默认70] [会话目录，可选]
//   会话目录不填时，在 ~/.dsh/sessions/*/ 里找最近改动的 session.v4.jsonl.zstd
//   退出码：0 未到阈值；1 到阈值（该写交接）；2 找不到会话文件
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const FULL_MB = Number(process.argv[2] || 3.85)
const LIMIT = Number(process.argv[3] || 70)
const SESSIONS = process.argv[4] || path.join(os.homedir(), '.dsh/sessions')
const LOG = path.join(process.cwd(), 'shared/context-usage.log')

function newest() {
  let best = null
  const visit = (dir, depth) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < 2) visit(full, depth + 1)
      } else if (e.name === 'session.v4.jsonl.zstd') {
        const st = fs.statSync(full)
        if (!best || st.mtimeMs > best.m) best = { m: st.mtimeMs, f: full, size: st.size }
      }
    }
  }
  visit(SESSIONS, 0)
  return best
}

const s = newest()
if (!s) { console.log('找不到会话文件'); process.exit(2) }
const mb = s.size / 1024 / 1024
const pct = Math.min(100, Math.round((mb / FULL_MB) * 100))
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
const line = `${stamp} 会话 ${path.basename(path.dirname(s.f))} ${mb.toFixed(2)}MB ≈ ${pct}%（按 ${FULL_MB}MB 封顶估的）`
fs.mkdirSync(path.dirname(LOG), { recursive: true })
fs.appendFileSync(LOG, line + '\n')
console.log(line)
if (pct >= LIMIT) {
  console.log(`ALERT ${pct}% ≥ ${LIMIT}%，该开新会话并写 shared/交接.md`)
  process.exit(1)
}
console.log(`OK 未到 ${LIMIT}%`)
