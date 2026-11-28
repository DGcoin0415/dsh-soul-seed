/**
 * dsh-notify · 挂账检查（每天一次）：工单/任务挂 24 小时没动就推一条
 *
 * 扫两处：
 *   1. shared/工单.md —— 状态含「待处理」、日期超过 staleHours（默认 24 小时）的；
 *   2. shared/任务.md —— 「进行中 / 待办」且超过 staleHours 没在 shared/历史 或 shared/接续.md 里出现过的，
 *      最多列 staleMaxTasks（默认 5）条。
 *
 * 「没动过」的判定：取任务摘要里最长的一段中文/字母（≥4 字）当关键词，
 * 在「接续.md 全文 + 历史文件里最近 staleHours 小时的行」里搜，搜不到才算挂住。
 * 只读文件，不改一个字；出错就当没有，绝不抛。
 */
import fs from 'node:fs'
import path from 'node:path'
import { bjDay, clip } from './util.mjs'

const DAY_MS = 24 * 3600_000
const ACTIVE = ['进行中', '待办']

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** "2026-11-24" / "2026-11-24 09:05" → 毫秒（北京时间）；认不出来返回 0。 */
export function parseStamp(text, now = Date.now()) {
  const s = String(text || '')
  const m = /(20\d\d)-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d))?/.exec(s)
  if (m) {
    const ms = Date.parse(
      `${m[1]}-${m[2]}-${m[3]}T${m[4] || '00'}:${m[5] || '00'}:00+08:00`,
    )
    return Number.isFinite(ms) ? ms : 0
  }
  // 只有 "11-26 13:00" 这种短日期：补今年
  const s2 = /(?:^|[^\d])(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d))?/.exec(s)
  if (s2) {
    const year = bjDay(now).slice(0, 4)
    const ms = Date.parse(
      `${year}-${s2[1]}-${s2[2]}T${s2[3] || '00'}:${s2[4] || '00'}:00+08:00`,
    )
    return Number.isFinite(ms) ? ms : 0
  }
  return 0
}

function tableCells(line) {
  const t = line.trim()
  if (!t.startsWith('|') || /^\|[\s:|-]+\|$/.test(t)) return null
  const cells = t.split('|').slice(1, -1).map((x) => x.trim())
  return cells.length >= 3 ? cells : null
}

function activeStatus(text) {
  const s = String(text || '')
  for (const a of ACTIVE) if (s.includes(a)) return a
  return ''
}

/** 摘要里的候选关键词（≥4 字的中文/字母段，长的排前面）。 */
export function keywordsOf(summary) {
  const s = String(summary || '')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/[`*_<>[\]【】《》「」]/g, ' ')
  const parts = s
    .split(/[^\u4e00-\u9fa5A-Za-z0-9]+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4)
  const uniq = [...new Set(parts)].sort((a, b) => b.length - a.length)
  return uniq.map((x) => x.slice(0, 16))
}

/** 原来那个单关键词版本留着给别处用（取最长的那个）。 */
export function keywordOf(summary) {
  return keywordsOf(summary)[0] || ''
}

/** 最近 staleHours 小时里「有动静」的原文堆：接续.md 全文 + 历史里这几天的行。 */
function recentHaystack(workspace, hours, now) {
  const dir = path.join(String(workspace || ''), 'shared')
  const cutoffDay = bjDay(now - hours * 3600_000)
  const chunks = [readText(path.join(dir, '接续.md'))]
  const histDir = path.join(dir, '历史')
  let files = []
  try {
    files = fs.readdirSync(histDir).filter((f) => f.endsWith('.md'))
  } catch {
    files = []
  }
  for (const f of files) {
    const text = readText(path.join(histDir, f))
    if (!text) continue
    const keep = text
      .split(/\r?\n/)
      .filter((line) => {
        const m = /^\s*-\s*(20\d\d-\d\d-\d\d)/.exec(line)
        return m ? m[1] >= cutoffDay : false
      })
    if (keep.length) chunks.push(keep.join('\n'))
  }
  return chunks.join('\n')
}

/**
 * 抽一次挂账。
 * @returns {{orders:Array, tasks:Array, hours:number, total:number}}
 */
export function collectStale({ workspace, hours = 24, max = 5, now = Date.now() } = {}) {
  const dir = path.join(String(workspace || ''), 'shared')
  const h = Math.max(1, Number(hours) || 24)
  const out = { orders: [], tasks: [], hours: h, total: 0 }
  const ageDays = (ms) => Math.max(1, Math.round((now - ms) / DAY_MS))

  // 1) 工单：状态「待处理」且挂超过 24 小时
  try {
    for (const line of readText(path.join(dir, '工单.md')).split(/\r?\n/)) {
      const cells = tableCells(line)
      if (!cells || cells.length < 5) continue
      const [date, room, who, issue, status] = cells
      if (!/待处理/.test(status)) continue
      const at = parseStamp(date, now)
      if (!at || now - at <= h * 3600_000) continue
      out.orders.push({
        date: String(date).slice(0, 10),
        room: clip(room, 14),
        who: clip(String(who).split(/[｜|]/)[0], 12),
        issue: clip(issue, 24),
        days: ageDays(at),
      })
    }
  } catch {}

  // 2) 任务：「进行中 / 待办」且 24 小时没人提过
  const hay = (() => {
    try {
      return recentHaystack(workspace, h, now)
    } catch {
      return ''
    }
  })()
  const rows = []
  try {
    for (const line of readText(path.join(dir, '任务.md')).split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      const cells = tableCells(t)
      if (cells) {
        const status = activeStatus(cells[3])
        if (!status) continue
        // 「到期/约定」写「长期」的是常态活，不算挂住
        if (/长期/.test(String(cells[4] || ''))) continue
        rows.push({ dateText: cells[0], status, summary: clip(cells[2], 34), owner: clip(cells[1], 8) })
        continue
      }
      if (/^[-*]/.test(t) && /状态[:：]/.test(t)) {
        const m = /状态[:：]\s*([^｜|]+)/.exec(t)
        const status = m ? activeStatus(m[1]) : ''
        if (!status) continue
        const body = t.split('｜')[0].replace(/^[-*]\s*/, '')
        const dm = /(20\d\d-\d\d-\d\d|\d\d-\d\d(?:[ T]\d\d:\d\d)?)/.exec(body)
        rows.push({ dateText: dm ? dm[1] : '', status, summary: clip(body, 34), owner: '' })
      }
    }
  } catch {}

  const seen = new Set()
  for (const r of rows) {
    const at = parseStamp(r.dateText, now)
    if (!at || now - at <= h * 3600_000) continue // 24 小时内新开的不算挂住
    // 摘要里任一个 ≥4 字的词最近提到过 = 有动静（宁可少报，别造假红灯）
    const kws = keywordsOf(r.summary)
    if (kws.length && kws.some((k) => hay.includes(k))) continue
    const key = r.summary.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 10)
    if (seen.has(key)) continue
    seen.add(key)
    out.tasks.push({ summary: r.summary, status: r.status, days: ageDays(at), date: String(r.dateText).slice(0, 10) })
    if (out.tasks.length >= Math.max(1, Number(max) || 5)) break
  }

  out.total = out.orders.length + out.tasks.length
  return out
}

/** 排成一条推送。 */
export function renderStale({ orders = [], tasks = [], hours = 24 } = {}, day = bjDay()) {
  const lines = [`【挂着的活 · ${String(day).slice(5)}】`]
  if (orders.length) {
    lines.push(`工单还挂着 ${orders.length} 单：`)
    for (const o of orders.slice(0, 5)) {
      lines.push(`• ${o.date.slice(5)} ${o.room} ${o.who}：${o.issue}（${o.days} 天）`)
    }
  }
  if (tasks.length) {
    lines.push(`任务超过 ${Math.round(hours)} 小时没动：`)
    for (const t of tasks) lines.push(`• ${t.summary}（${t.status} · 挂了 ${t.days} 天）`)
  }
  if (!orders.length && !tasks.length) return ''
  if (orders.length > 5) lines.push(`（工单还有 ${orders.length - 5} 单没列）`)
  return lines.join('\n')
}
