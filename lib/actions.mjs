// soul 工具的 action 实现（从 lib/index.js 抽出来：
// 不碰宿主 API，能单独跑测试，也不会把一段逻辑散在注册代码里）。
//
// 15 个 action：
//   tree / read / note / rag-recall / where / leaves / tidy
//   person-get / person-bump / person-mood / decay
//   track-save / track-list / track-show / track-bump
import fs from 'node:fs'
import path from 'node:path'
import { appendHistory, listTree, readBranch, recallLocal, sharedBase, ROOT_FILE } from './soulcore.mjs'
import {
  bumpTrack,
  listTracks,
  renderBump,
  renderTrack,
  renderTrackList,
  saveTrack,
  showTrack,
} from './tracks.mjs'
import {
  bumpAffinity,
  decayAll,
  ensurePerson,
  isGrudge,
  ledgerFile,
  loadLedger,
  nameOf,
  renderPerson,
  saveLedger,
  setMood,
} from './people.mjs'
import { recentTurns, recordTurn } from './turnlog.mjs'
import { tidy } from './tidy.mjs'
import { soulHome } from './home.mjs'

export const ACTIONS = [
  'tree',
  'read',
  'note',
  'person-get',
  'person-bump',
  'person-mood',
  'decay',
  'rag-recall',
  'leaves',
  'tidy',
  'where',
  'track-save',
  'track-list',
  'track-show',
  'track-bump',
]

const errorText = (e) => String(e?.message ?? e)

function tidyReport(report) {
  return `修枝：截断 ${report.trimmed} 行，归档 ${report.archived} 份，索引新增 ${report.reindexed} 块`
}

/**
 * 执行一个 soul 工具 action。
 * @param {object} input 工具参数（action 必填，其余按 action 取）
 * @returns {Promise<{message: string}>}
 */
export async function runSoulAction(input = {}) {
  const args = input && typeof input === 'object' ? input : {}
  const action = typeof args.action === 'string' && args.action ? args.action : 'tree'

  // ------------------------------------------------------------ 记忆树
  if (action === 'tree') {
    const rows = listTree()
    const lines = rows.map((row) =>
      row.dir ? `${row.path}` : `${row.path}  ${(row.bytes / 1024).toFixed(1)} KB`,
    )
    return { message: lines.join('\n') || '（空）' }
  }

  if (action === 'read') {
    if (!args.file) return { message: '缺少 file（shared/ 下的相对路径）' }
    try {
      const text = readBranch(args.file)
      if (text !== null) recordTurn(sharedBase(), '读枝', args.file)
      return { message: text ?? `没有这个文件：${args.file}` }
    } catch (e) {
      return { message: errorText(e) }
    }
  }

  if (action === 'note') {
    try {
      const { file, stamp } = appendHistory(args.text)
      return { message: `已记到 ${file}（${stamp}）` }
    } catch (e) {
      return { message: errorText(e) }
    }
  }

  if (action === 'rag-recall') {
    if (!args.query) return { message: '缺少 query（想找的事）' }
    recordTurn(sharedBase(), '翻落叶', args.query)
    const hits = recallLocal(args.query, 8)
    if (!hits.length) return { message: '没检索到' }
    return {
      message: hits
        .map((h, i) => `${i + 1}. [${h.file}] ${String(h.text).slice(0, 120)}`)
        .join('\n'),
    }
  }

  // ------------------------------------------------------------ 维护
  if (action === 'where') {
    const base = sharedBase()
    let rootBytes = 0
    try {
      rootBytes = fs.statSync(path.join(base, ROOT_FILE)).size
    } catch {}
    return {
      message: [
        `记忆目录：${base}`,
        `根页：${rootBytes} 字节`,
        `数据目录：${soulHome()}`,
        `账本：${ledgerFile()}`,
      ].join('\n'),
    }
  }

  if (action === 'leaves') {
    const rows = recentTurns(sharedBase(), 15)
    return { message: rows.length ? rows.join('\n') : '还没有翻叶记录' }
  }

  if (action === 'tidy') {
    try {
      const report = await tidy({ log: () => {} })
      return { message: tidyReport(report) }
    } catch (e) {
      return { message: `修枝没跑完：${errorText(e)}` }
    }
  }

  // ------------------------------------------------------------ 心情
  if (action === 'decay') {
    try {
      const ledger = loadLedger()
      const changed = decayAll(ledger)
      if (changed) saveLedger(ledger)
      return { message: `衰减完成，变动 ${changed} 人` }
    } catch (e) {
      return { message: `衰减没跑完：${errorText(e)}` }
    }
  }

  // ------------------------------------------------------------ 按人账本
  if (action === 'person-get' || action === 'person-bump' || action === 'person-mood') {
    const key = String(args.key ?? '').trim()
    if (!key) return { message: '缺少 key（账号键）' }
    const ledger = loadLedger()

    if (action === 'person-get') {
      const person = ledger.people[key]
      if (!person) return { message: `账本里还没有 ${key}` }
      return { message: renderPerson(key, person, ledger) }
    }

    if (action === 'person-bump') {
      const person = ensurePerson(ledger, key, args.name)
      const next = bumpAffinity(ledger, person, args.delta)
      saveLedger(ledger)
      return { message: `${nameOf(person, key)} 好感 → ${next}` }
    }

    const person = ensurePerson(ledger, key, args.name)
    const next = setMood(ledger, person, args.score, args.label, args.intent)
    saveLedger(ledger)
    const label = typeof args.label === 'string' && args.label.trim() ? `（${args.label.trim()}）` : ''
    const grudged = isGrudge(ledger, person) ? '　低于门槛，记着了' : ''
    return { message: `${nameOf(person, key)} 心情 → ${next}${label}${grudged}` }
  }

  // ------------------------------------------------------------ 轨道
  if (action === 'track-save') {
    const result = saveTrack({
      name: args.name,
      keywords: args.keywords,
      steps: args.steps,
      fallback: args.fallback,
    })
    return { message: result.message }
  }

  if (action === 'track-list') {
    return { message: renderTrackList(listTracks()) }
  }

  if (action === 'track-show') {
    if (!args.query) return { message: '缺少 query（轨道名或关键词）' }
    const track = showTrack(args.query)
    return { message: track ? renderTrack(track) : `没有这条轨道：${args.query}` }
  }

  if (action === 'track-bump') {
    if (!args.query) return { message: '缺少 query（轨道名或关键词）' }
    const ok = args.ok !== false
    const track = bumpTrack(args.query, ok)
    return { message: track ? renderBump(track, ok) : `没有这条轨道：${args.query}` }
  }

  return { message: `未知 action：${action}` }
}
