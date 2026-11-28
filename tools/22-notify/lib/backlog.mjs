/**
 * dsh-notify · 早报附录①：今天接着干的
 *
 * 从 shared/任务.md 抽「进行中 / 待办 / 卡住」的行，从 shared/接续.md 的「没完的」抽最近几条，
 * 每条压成一句话（不贴整行），去重后最多 5 条；整段不超过新闻原长的 1/3（超了砍条数）。
 * 一条都没有就写「今天没有挂着的活」。
 *
 * 全只读，一个字都不改；读不到、格式变了都当没有，绝不抛。
 */
import fs from 'node:fs'
import path from 'node:path'
import { clip } from './util.mjs'

/** 算「没完」的三种状态 */
const ACTIVE = ['进行中', '待办', '卡住']

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function activeStatus(text) {
  const s = String(text || '')
  for (const a of ACTIVE) if (s.includes(a)) return a
  return ''
}

/** 一条任务压成一句话（≤40 字），不贴整行。 */
export function summarize(text) {
  let s = String(text == null ? '' : text)
  s = s.replace(/^[-*+\s]+/, '')
  s = s.replace(/^\[[^\]]{1,24}\]\s*/, '') // [鱼世界] / [学习] 这种前缀
  s = s.replace(/[`*]/g, '')
  s = s.replace(/\s*[（(](?:20\d\d-\d\d-\d\d|无)[）)]\s*/g, ' ') // 尾巴上的日期
  s = s.replace(/\s+/g, ' ').trim()
  const cut = s.split(/[；;。]/)[0].trim()
  if (cut.length >= 6) s = cut
  return clip(s, 40)
}

/** 去重键：把标点空格去掉取前 8 个字，差不多的话就算同一件事。 */
function dedupeKey(summary) {
  return String(summary || '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
    .slice(0, 8)
}

function tableCells(line) {
  const t = line.trim()
  if (!t.startsWith('|') || /^\|[\s:|-]+\|$/.test(t)) return null
  const cells = t.split('|').slice(1, -1).map((x) => x.trim())
  return cells.length >= 3 ? cells : null
}

/**
 * 抽一版「今天接着干的」。
 * @returns {{items:Array<{summary:string,tag:string,status:string}>, head:string}}
 */
export function collectBacklog({ workspace, max = 5 } = {}) {
  const dir = path.join(String(workspace || ''), 'shared')
  const items = []
  const seen = new Set()

  const add = (raw, status, from) => {
    const summary = summarize(raw)
    if (!summary || summary.length < 4) return
    const key = dedupeKey(summary)
    if (!key || seen.has(key)) return
    seen.add(key)
    items.push({ summary, status, tag: `${from}·${status}` })
  }

  // 1) shared/任务.md：表格行 + 「状态：」的列表行
  try {
    for (const line of readText(path.join(dir, '任务.md')).split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      const cells = tableCells(t)
      if (cells) {
        // | 日期 | 谁 | 任务 | 状态 | 到期 | 备注 |
        const status = activeStatus(cells[3])
        if (status) add(cells[2], status, '任务')
        continue
      }
      if (/^[-*]/.test(t) && /状态[:：]/.test(t)) {
        const m = /状态[:：]\s*([^｜|]+)/.exec(t)
        const status = m ? activeStatus(m[1]) : ''
        if (!status) continue
        add(t.split('｜')[0], status, '任务')
      }
    }
  } catch {}

  // 2) shared/接续.md 的「没完的」：只捡最近 3 条（文件是时间正序，取尾部）
  try {
    const text = readText(path.join(dir, '接续.md'))
    const m = /##\s*没完的([\s\S]*?)(?:\n##\s|$)/.exec(text)
    const body = m ? m[1] : ''
    const lines = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('-'))
      .slice(-3)
      .reverse()
    for (const l of lines) {
      let s = l.replace(/^-\s*/, '')
      s = s.replace(/^\[[^\]]{1,24}\]\s*/, '') // [11-27 11:23]
      s = s.replace(/^(米萨|master|咱|我)\s*[:：]\s*/, '')
      add(s, '接着聊', '接续')
    }
  } catch {}

  const out = items.slice(0, Math.max(1, Number(max) || 5))
  return { items: out }
}

/**
 * 排成早报附录的一段。
 * @param {object} o
 * @param {Array} o.items  collectBacklog 的 items
 * @param {number} o.budget 整段字数上限（0=不限）—— 调用方按原新闻长度/3 给
 */
export function renderBacklog({ items = [], budget = 0 } = {}) {
  const head = '今天接着干的'
  if (!items.length) return `\n\n${head}\n• 今天没有挂着的活`
  const rows = []
  let used = 0
  for (const it of items) {
    const line = `• ${it.summary}｜${it.tag}`
    if (budget > 0 && rows.length && used + line.length + 1 > budget) break
    rows.push(line)
    used += line.length + 1
  }
  if (!rows.length) return `\n\n${head}\n• 今天没有挂着的活`
  return `\n\n${head}\n${rows.join('\n')}`
}

/** 一步到位：抽 + 排（失败返回 ''，绝不影响新闻本体）。 */
export function backlogSection({ workspace, max = 5, budget = 0 } = {}) {
  try {
    const { items } = collectBacklog({ workspace, max })
    return renderBacklog({ items, budget })
  } catch {
    return ''
  }
}
