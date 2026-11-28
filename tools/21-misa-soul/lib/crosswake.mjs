// 跨渠道互相唤醒：一条渠道（QQ 私聊 / 微信 / 面板）来消息时，
// 顺手戳一下别的活跃会话，让它们重读 shared/实时/ 最新一页，看到另一头刚聊了什么。
//
// 三个约束（2026-11-27 master 定）：
//  1) 节流：同一个目标会话 5 分钟内只戳一次（可改 .wake-cross.json）；
//  2) 防回环：唤醒提示本身以【跨渠道】开头，收到它的会话不再往下传（前缀 + nested 参数 + 短时效标记）；
//  3) 绝不抛错：任何异常只写日志，不能影响正常对话。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { atomicWrite } from './atomic.mjs'
import { readMappedSessions, soulDir } from './soul.mjs'

/** 唤醒提示的前缀：收到这个前缀的消息 = 是被戳醒的，不再往外传。 */
export const CROSS_MARK = '【跨渠道】'

const DEFAULT_GAP_MIN = 5
const DEFAULT_MAX_TARGETS = 2
// 被戳过的会话，这么多毫秒内的下一轮当作「唤醒引发的」，不再往下传
const GUARD_MS = 60 * 1000
// 状态文件里旧记录留多久
const STATE_KEEP_MS = 24 * 60 * 60 * 1000
// 投失败的目标一分钟后再试（成功过就按 gapMin），别一直拿同一个坏目标烧时间
const FAIL_BACKOFF_MS = 60 * 1000
// 一轮最多实际试几个候选（候选再多也不一次投一串）
const MAX_ATTEMPTS = 4

export const WAKE_TEXT =
  `${CROSS_MARK}另一头刚有新消息，先看 shared/实时/ 最新一页，再决定要不要接话；不用回这条。`

/**
 * 开关与阈值：SOUL_WAKE_CROSS=0 关闭（默认开）；
 * 工作区 .wake-cross.json 可改 {"enabled":false,"gapMin":30,"maxTargets":1}。
 * 2026-11-27 master 定：功能保留，本地默认不开——靠 .wake-cross.json 的 enabled:false。
 */
export function crossWakeConfig(home = soulDir()) {
  const cfg = { enabled: true, gapMin: DEFAULT_GAP_MIN, maxTargets: DEFAULT_MAX_TARGETS }
  try {
    if (String(process.env.SOUL_WAKE_CROSS ?? '1').trim() === '0') cfg.enabled = false
  } catch {}
  try {
    const raw = fs.readFileSync(path.join(home, '.wake-cross.json'), 'utf8')
    const json = JSON.parse(raw)
    if (json && json.enabled === false) cfg.enabled = false
    if (json && json.enabled === true) cfg.enabled = true
    const gap = Number(json?.gapMin)
    const max = Number(json?.maxTargets)
    if (Number.isFinite(gap) && gap > 0) cfg.gapMin = gap
    if (Number.isFinite(max) && max > 0) cfg.maxTargets = Math.floor(max)
  } catch {}
  return cfg
}

export function crossWakeStateFile(home = soulDir()) {
  return path.join(home, '.crosswake-state.json')
}

function readState(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!json || typeof json !== 'object') return { targets: {}, nested: {} }
    return {
      targets: json.targets && typeof json.targets === 'object' ? json.targets : {},
      nested: json.nested && typeof json.nested === 'object' ? json.nested : {},
      updatedAt: Number(json.updatedAt) || 0,
    }
  } catch {
    return { targets: {}, nested: {} }
  }
}

function pruneState(state, now) {
  for (const key of ['targets', 'nested']) {
    for (const [sid, val] of Object.entries(state[key])) {
      const at = Number(val && val.at) || 0
      if (!at || now - at > STATE_KEEP_MS) delete state[key][sid]
    }
  }
  return state
}

/** 拿共享锁跑个小脚本（写 shared/ 前要拿锁；拿不到就算了，锁是协作式的）。 */
function runNodeScript(script, argv) {
  try {
    const env = { ...process.env }
    // 插件跑在 Electron 里，要显式当 node 用
    if (process.versions && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    return spawnSync(process.execPath, [script, ...argv], {
      env,
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    })
  } catch {
    return null
  }
}

/** 往 shared/日志/跨渠道唤醒.md 追加一行；失败只吞掉，不影响主流程。 */
function appendWakeLog(home, line) {
  const lockScript = path.join(home, 'shared-lock.mjs')
  const tag = '跨渠道唤醒'
  let locked = false
  try {
    if (fs.existsSync(lockScript)) {
      const r = runNodeScript(lockScript, ['acquire', '--tag', tag, '--wait', '2'])
      locked = !!r && r.status === 0
    }
  } catch {}
  try {
    const dir = path.join(home, 'shared', '日志')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, '跨渠道唤醒.md'), line + '\n')
  } catch {}
  try {
    if (locked && fs.existsSync(lockScript)) {
      runNodeScript(lockScript, ['release', '--tag', tag])
    }
  } catch {}
}

function shortId(id) {
  const s = String(id || '')
  if (s.length <= 12) return s || '(空)'
  return '…' + s.slice(-8)
}

function normalizeTargets(list) {
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    if (!item) continue
    const id = typeof item === 'string' ? item : String(item.id || item.sessionId || '')
    if (!id) continue
    const src = typeof item === 'string' ? '' : String(item.src || item.channel || '')
    const live = typeof item === 'string' ? false : item.live === true
    const subagent = typeof item === 'string' ? false : item.subagent === true
    const lastActive = typeof item === 'string' ? 0 : Number(item.lastActive) || 0
    const known = out.find((x) => x.id === id)
    if (known) {
      // 同一个会话被两个来源都列出来：合并成信息更全的那份，别投两遍
      known.src = known.src || src
      known.live = known.live || live
      known.subagent = known.subagent || subagent
      known.lastActive = Math.max(known.lastActive, lastActive)
      continue
    }
    out.push({ id, src, live, subagent, lastActive })
  }
  return out
}

/**
 * 候选排序 + 剔除：subagent 路由占着的会话普通投递必被拒，直接剔掉；
 * 剩下的按「活着的 → 最近有活动的」排，好会话先试。
 */
function rankTargets(targets, from) {
  const skippedSubagent = []
  const usable = []
  targets.forEach((t, order) => {
    if (t.id === from) return
    if (t.subagent) { skippedSubagent.push(t); return }
    usable.push({ ...t, order })
  })
  usable.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1
    if (a.lastActive !== b.lastActive) return b.lastActive - a.lastActive
    return a.order - b.order
  })
  return { usable, skippedSubagent }
}

/**
 * 全投不进去时的兜底：往 dsh-notify 的收件箱丢一条，插件下一轮会把它推出去。
 * 宁可多一条提示，也不能静默丢（2026-11-28 master 定）。
 */
function writeFallbackInbox(home, text) {
  const dir = path.join(home, '.notify-outbox')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${Date.now()}-crosswake-${process.pid}.json`)
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, JSON.stringify({ text, source: 'crosswake', session: '' }, null, 2), 'utf8')
  fs.renameSync(temp, file)
  return file
}

/**
 * 戳一下别的活跃会话。永不抛错。
 *
 * @param {object} opts
 * @param {string} opts.fromSessionId 谁那儿刚有新消息（自己的会话 id）
 * @param {boolean} [opts.nested] 本次触发是不是「被跨渠道提示戳醒」引发的
 * @param {(msg:string)=>void} [opts.log] 日志函数（默认不写）
 * @param {object} [opts.deps] 注入依赖（测试/插件用）
 * @param {string} [opts.deps.home] 工作区（默认 soulDir()）
 * @param {()=>Array} [opts.deps.listTargets] 候选会话（默认走渠道映射表）
 * @param {(sid:string,text:string)=>Promise<{ok:boolean,detail?:string}>} [opts.deps.deliver] 投递
 * @returns {Promise<{skipped?:string, woken?:string[], failed?:string[]}>}
 */
export async function maybeCrossWake({ fromSessionId, nested = false, log = () => {}, deps = {} } = {}) {
  const result = { woken: [], failed: [] }
  try {
    const home = deps.home || soulDir()
    const cfg = crossWakeConfig(home)
    if (!cfg.enabled) return { skipped: '开关关着（SOUL_WAKE_CROSS=0）' }

    const from = String(fromSessionId || '')
    const now = Date.now()
    const stateFile = crossWakeStateFile(home)
    const state = pruneState(readState(stateFile), now)

    // 防回环（第一道）：调用方明确说这次是唤醒引发的，就不再往下传，顺手把标记消掉
    if (nested) {
      if (from && state.nested[from]) {
        delete state.nested[from]
        try { atomicWrite(stateFile, { ...state, updatedAt: now }) } catch {}
      }
      return { skipped: '这次就是唤醒引发的（nested）' }
    }
    if (!from) return { skipped: '没有来源会话 id' }

    // 防回环（第二道）：刚被戳过（60 秒内）的会话，这一轮算唤醒引发的，不再往外传
    const mark = Number(state.nested[from]?.at) || 0
    if (mark && now - mark < GUARD_MS) {
      delete state.nested[from]
      try { atomicWrite(stateFile, { ...state, updatedAt: now }) } catch {}
      return { skipped: '来源会话刚被戳过，本轮不再传（防回环）' }
    }

    // 候选：插件注入的优先（活跃会话），否则退回渠道映射表
    let candidates = []
    try {
      if (typeof deps.listTargets === 'function') candidates = normalizeTargets(deps.listTargets())
    } catch {}
    if (!candidates.length) {
      try {
        candidates = normalizeTargets(readMappedSessions().map((s) => ({ id: s.sessionId, src: s.channel })))
      } catch {}
    }
    const ranked = rankTargets(candidates, from)

    // 节流：同一个目标 gapMin 分钟内只戳一次；失败过的一分钟后再试
    const gapMs = cfg.gapMin * 60 * 1000
    const retryMs = Math.min(gapMs, FAIL_BACKOFF_MS)
    let targets = ranked.usable.filter((t) => {
      const prev = state.targets[t.id]
      const at = Number(prev?.at) || 0
      if (!at) return true
      return now - at >= (prev?.ok ? gapMs : retryMs)
    })

    if (!targets.length) {
      return {
        skipped: ranked.skippedSubagent.length
          ? `没有可投的会话（${ranked.skippedSubagent.length} 个由 subagent 路由占用，其余在节流期内）`
          : '没有别的会话可戳（或都在节流期内）',
      }
    }
    targets = targets.slice(0, MAX_ATTEMPTS)

    const deliver = typeof deps.deliver === 'function' ? deps.deliver : null
    const lines = []
    const maxOk = Math.max(1, cfg.maxTargets)
    for (const target of targets) {
      // 已经戳够数了就不再多戳，剩下的留到下一轮
      if (result.woken.length >= maxOk) break
      let ok = false
      let detail = '无投递通道'
      if (deliver) {
        try {
          const r = await deliver(target.id, WAKE_TEXT)
          ok = !!r?.ok
          detail = String(r?.detail || (ok ? '已投' : '投递失败'))
        } catch (error) {
          ok = false
          detail = '投递异常：' + String(error?.message ?? error)
        }
      }
      // 先记时间戳再记结果：成功按 gapMin 节流，失败按一分钟退避
      state.targets[target.id] = { at: now, ok, from, detail: detail.slice(0, 120) }
      if (ok) {
        // 给这个目标留个短时效标记：它下一轮是唤醒引发的，不许接着传
        state.nested[target.id] = { at: now }
        result.woken.push(target.id)
      } else {
        result.failed.push(target.id)
      }
      const who = `${shortId(target.id)}${target.src ? `（${target.src}）` : ''}`
      lines.push(`${new Date(now).toLocaleString('zh-CN', { hour12: false })} · 从 ${shortId(from)} · 戳 ${who} · ${ok ? '已投' : detail}`)
      try { log(`跨渠道唤醒 ${who}: ${ok ? '已投' : detail}`) } catch {}
    }

    // 一个都没投进去：写收件箱 + 日志，把原因说清楚，别静默丢
    if (!result.woken.length) {
      const reasons = []
      for (const id of result.failed) {
        const d = String(state.targets[id]?.detail || '未知原因')
        if (!reasons.includes(d)) reasons.push(d)
      }
      const summary = reasons.slice(0, 3).join('；') || '没有可投的目标'
      try {
        const file = writeFallbackInbox(
          home,
          `【跨渠道唤醒失败】试了 ${result.failed.length} 个会话都没投进去：${summary}\n要传的话：${WAKE_TEXT}`,
        )
        lines.push(`${new Date(now).toLocaleString('zh-CN', { hour12: false })} · 全部失败（${result.failed.length} 个）：${summary} · 已丢进收件箱 ${path.basename(file)}`)
      } catch (error) {
        lines.push(`${new Date(now).toLocaleString('zh-CN', { hour12: false })} · 全部失败（${result.failed.length} 个）：${summary} · 收件箱也写不进去：${String(error?.message ?? error)}`)
      }
      result.skipped = '全部失败：' + summary
    }

    try { atomicWrite(stateFile, { ...state, updatedAt: now }) } catch (error) {
      try { log('跨渠道唤醒状态写失败：' + String(error?.message ?? error)) } catch {}
    }
    if (lines.length) appendWakeLog(home, lines.join('\n'))
    return result
  } catch (error) {
    try { log('跨渠道唤醒失败：' + String(error?.message ?? error)) } catch {}
    return { skipped: '异常：' + String(error?.message ?? error) }
  }
}
