// 修枝：把长得太乱的地方收拾一下——翻叶只留近的，落叶把太旧的归档，索引重建。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
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

  // 3. 日志别长成一座山：wake.log 只留最后 2000 行
  try {
    const wakeLog = path.join(base, 'wake.log')
    if (fs.existsSync(wakeLog)) {
      const lines = fs.readFileSync(wakeLog, 'utf8').split('\n')
      if (lines.length > 4000) {
        fs.writeFileSync(wakeLog, lines.slice(-2000).join('\n'), 'utf8')
        report.trimmed += lines.length - 2000
      }
    }
  } catch {}

  // 4. 心情：按半衰期重算一遍，写回 mood.md（没变会自己跳过）
  try {
    const nodeExe = 'C:/Users/Administrator/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe'
    const syncMood = [path.join(base, 'sync-mood.mjs'), path.join(base, 'tools', '17-mood', 'sync-mood.mjs')].find((p) => fs.existsSync(p))
    if (nodeExe && syncMood && fs.existsSync(nodeExe)) {
      execFileSync(nodeExe, [syncMood], { cwd: base, timeout: 120000, stdio: 'ignore' })
      report.mood = true
    }
  } catch {}

  // 5. 日档：把昨天 master 说的话落一份（当天已经有就跳过，不覆盖手动记录）
  try {
    const nodeExe = 'C:/Users/Administrator/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe'
    const daily = path.join(base, 'memory-daily.mjs')
    if (fs.existsSync(nodeExe) && fs.existsSync(daily)) {
      execFileSync(nodeExe, [daily], { cwd: base, timeout: 60000, stdio: 'ignore' })
      report.daily = true
    }
  } catch {}

  // 6. 摘要目录重建（几乎不花钱，就是扫一遍文件头）
  try {
    const nodeExe = 'C:/Users/Administrator/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe'
    const memIdx = path.join(base, 'memory-index.mjs')
    if (fs.existsSync(nodeExe) && fs.existsSync(memIdx)) execFileSync(nodeExe, [memIdx], { cwd: base, timeout: 60000, stdio: 'ignore' })
  } catch {}

  // 8. 指针体检：根页、AGENTS 里反引号写着的路径挨个走一遍，走不通记一笔
  try {
    const nodeExe = 'C:/Users/Administrator/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe'
    const checker = path.join(base, 'path-check.mjs')
    if (fs.existsSync(nodeExe) && fs.existsSync(checker)) {
      const out = execFileSync(nodeExe, [checker], { cwd: base, timeout: 30000, encoding: 'utf8' })
      report.paths = true
      log('指针体检：' + String(out).trim().split('\n')[0])
    }
  } catch (e) {
    report.paths = false
    const detail = e?.stdout ? String(e.stdout).trim().replace(/\n/g, ' / ') : (e?.message ?? String(e))
    log('指针体检：' + detail)
  }

  // 7. 索引重建（只补缺，不会重复花钱）
  try {
    const r = await buildIndex({ log })
    report.reindexed = r.added
  } catch (e) {
    log('索引重建失败：' + (e?.message ?? e))
  }

  log(`修枝完成：翻叶截断 ${report.trimmed} 行，归档 ${report.archived} 份，索引新增 ${report.reindexed} 块`)
  return report
}

/** 每天该跑的时间点里最近的一个（今天 4:10 过了就是今天，没过就是昨天）。 */
export function latestTidyBoundary(hourLocal = 4, now = Date.now()) {
  const d = new Date(now)
  d.setHours(hourLocal, 10, 0, 0)
  if (d.getTime() > now) d.setDate(d.getDate() - 1)
  return d.getTime()
}

/** 下一个该跑的时间点。 */
export function nextTidyBoundary(hourLocal = 4, now = Date.now()) {
  const d = new Date(now)
  d.setHours(hourLocal, 10, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** 每天 4:10 跑一次；开机时发现错过就跑，和分页一个路子。 */
export function startDailyTidy({ hourLocal = 4, home = soulDir(), log = () => {}, onError = () => {} } = {}) {
  const stateFile = path.join(home, '.tidy-schedule.json')
  let timer = null
  let stopped = false
  let running = false

  const readLast = () => {
    try {
      return Number(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastRun) || 0
    } catch {
      return 0
    }
  }
  const writeLast = (ms) => {
    try {
      fs.writeFileSync(stateFile, JSON.stringify({ lastRun: ms }), 'utf8')
    } catch {}
  }

  const run = async (why) => {
    if (running || stopped) return
    running = true
    try {
      await tidy({ log })
      writeLast(Date.now())
      log(`修枝完成（${why}）`)
    } catch (e) {
      onError(e)
    } finally {
      running = false
    }
  }

  const arm = () => {
    if (stopped) return
    const ms = Math.max(60_000, nextTidyBoundary(hourLocal) - Date.now())
    timer = setTimeout(async () => {
      await run('到点')
      arm()
    }, ms)
  }

  // 开机补跑：上一次该跑的点过了还没跑，说明那会儿不在
  const last = readLast()
  const boundary = latestTidyBoundary(hourLocal)
  if (last < boundary) {
    const gap = Math.max(1, Math.round((Date.now() - Math.max(last, boundary)) / 3600000))
    run(`补跑，距上次约 ${gap} 小时`)
  }
  arm()

  return { stop() { stopped = true; if (timer) clearTimeout(timer) } }
}
