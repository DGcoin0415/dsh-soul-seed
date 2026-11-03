// 修枝：把长得太乱的地方收拾一下——翻叶只留近的，落叶把太旧的归档，索引重建。
import fs from 'node:fs'
import path from 'node:path'
import { buildIndex, longDir, soulDir } from './rag.mjs'

const KEEP_TURN_LINES = 200
const ARCHIVE_DAYS = 45

/** 落叶（长文）目录，兼容旧名「长文」。 */
export function leavesDir() {
  const base = path.join(soulDir(), 'shared')
  const modern = path.join(base, '落叶')
  const legacy = path.join(base, '长文')
  if (fs.existsSync(modern)) return modern
  if (fs.existsSync(legacy)) return legacy
  return modern
}

export async function tidy({ log = () => {} } = {}) {
  const base = soulDir()
  const report = { trimmed: 0, archived: 0, reindexed: 0 }

  // 1. 翻叶太长就截断
  const turnFile = path.join(base, 'shared', '翻叶.md')
  try {
    const lines = fs.readFileSync(turnFile, 'utf8').split('\n').filter((l) => l.trim())
    if (lines.length > KEEP_TURN_LINES) {
      const head = '# 翻叶（最近用过的记忆，新的在后）\n'
      fs.writeFileSync(turnFile, head + '\n' + lines.slice(-KEEP_TURN_LINES).join('\n') + '\n', 'utf8')
      report.trimmed = lines.length - KEEP_TURN_LINES
    }
  } catch {}

  // 2. 落叶里太久没动过的归档到 落叶/旧/
  const dir = leavesDir()
  const oldDir = path.join(dir, '旧')
  try {
    const cutoff = Date.now() - ARCHIVE_DAYS * 86400_000
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const full = path.join(dir, f)
      const st = fs.statSync(full)
      if (st.mtimeMs < cutoff) {
        fs.mkdirSync(oldDir, { recursive: true })
        fs.renameSync(full, path.join(oldDir, f))
        report.archived += 1
      }
    }
  } catch {}

  // 3. 索引重建（只补缺，不会重复花钱）
  try {
    const r = await buildIndex({ log })
    report.reindexed = r.added
  } catch (e) {
    log('索引重建失败：' + (e?.message ?? e))
  }

  log(`修枝完成：翻叶截断 ${report.trimmed} 行，归档 ${report.archived} 份，索引新增 ${report.reindexed} 块`)
  return report
}

/** 每天跑一次。 */
export function startDailyTidy({ hourLocal = 4, onError = () => {} } = {}) {
  let timer = null
  let stopped = false
  const schedule = () => {
    const now = new Date()
    const next = new Date(now)
    next.setHours(hourLocal, 10, 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    timer = setTimeout(async () => {
      try { await tidy() } catch (e) { onError(e) }
      if (!stopped) schedule()
    }, next - now)
  }
  schedule()
  return { stop() { stopped = true; if (timer) clearTimeout(timer) } }
}
