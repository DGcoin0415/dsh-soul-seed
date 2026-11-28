/**
 * dsh-notify · 核心
 *
 * 收事件 → 决定投到哪 → 投递 → 落状态。
 *
 * 投递顺序（master 2026-11-27 定：在哪问的就在哪回）：
 *   1. 事件带发起会话（sessionId）→ 直接 followup 回那条会话
 *   2. 配置 preferSession + fallbackChannel=session → 投到 fallbackSession / 最近活跃会话
 *   3. 其余 → 兜底发微信私聊
 * 投不进就进 pending，下一轮重试；重试用完就丢并记日志，绝不崩。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { paths, loadConfig } from './config.mjs'
import { readJson, atomicWriteJson, appendLog, bjShort, bjDay, clip, clipLines, redact, ensureDir } from './util.mjs'
import { pollYuyu, drainInbox } from './sources.mjs'
import { sendWechatText } from './wechat.mjs'
import { buildDailyNews } from './news.mjs'
import { backlogSection } from './backlog.mjs'
import { healthLine } from './health.mjs'
import { collectStale, renderStale } from './stale.mjs'

const STATE_VERSION = 1

function emptyState() {
  return {
    version: STATE_VERSION,
    yuyuCursor: '',
    sentKeys: [],
    pending: [],
    sessions: {},
    lastNewsDay: '',
    lastNewsAt: 0,
    lastStaleDay: '',
    lastStaleAt: 0,
    stats: { pushed: 0, failed: 0, dropped: 0, lastPushAt: 0, lastError: '' },
  }
}

function normalizeState(raw) {
  const s = { ...emptyState(), ...(raw && typeof raw === 'object' ? raw : {}) }
  if (!Array.isArray(s.sentKeys)) s.sentKeys = []
  if (!Array.isArray(s.pending)) s.pending = []
  if (!s.sessions || typeof s.sessions !== 'object') s.sessions = {}
  if (!s.stats || typeof s.stats !== 'object') s.stats = emptyState().stats
  return s
}

function keyOf(source, text) {
  return `${source}|${text}`.slice(0, 400)
}

/** 会话注入用的消息（和 yuyu-world 唤醒同一种形状）。 */
function sessionMessage(text) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'schedule' },
  }
}

export function createNotify({ workspace = '', agents = null, logger = null } = {}) {
  const ws = workspace || paths().workspace
  const P = paths(ws)
  let stopping = false
  let timer = null
  let ticking = false
  let agentsRef = agents

  function log(line) {
    appendLog(P.log, line)
    try {
      logger?.(redact(line))
    } catch {}
  }

  function readState() {
    return normalizeState(readJson(P.state, {}))
  }

  function saveState(state) {
    // 原子写失败（Windows 上 rename 偶尔被占用）就直接覆盖写兜底，别让状态丢、别让同一条重复推
    for (let i = 0; i < 3; i++) {
      try {
        atomicWriteJson(P.state, state)
        return
      } catch {}
    }
    try {
      fs.writeFileSync(P.state, JSON.stringify(state, null, 2), 'utf8')
    } catch {}
  }

  function setAgents(service) {
    agentsRef = service || null
  }

  function resolveAgent(id) {
    if (!agentsRef || !id) return null
    try {
      const a = typeof agentsRef.get === 'function' ? agentsRef.get(id) : null
      if (a) return a
    } catch {}
    try {
      const list = typeof agentsRef.list === 'function' ? agentsRef.list() : []
      const hit = (Array.isArray(list) ? list : []).find((a) => a && a.id === id)
      if (hit) return hit
    } catch {}
    return null
  }

  /** 记一下哪个会话最近有动静，fallbackChannel=session 时用它。 */
  function noteSession(agentId, label = '') {
    const id = String(agentId || '').trim()
    if (!id) return
    try {
      const state = readState()
      state.sessions[id] = { at: Date.now(), label: clip(label, 60) }
      const ids = Object.keys(state.sessions).sort((a, b) => (state.sessions[b]?.at || 0) - (state.sessions[a]?.at || 0))
      for (const dead of ids.slice(12)) delete state.sessions[dead]
      saveState(state)
    } catch {}
  }

  function latestSession(state, withinMs = 6 * 3600_000) {
    const now = Date.now()
    const rows = Object.entries(state.sessions || {})
      .map(([id, v]) => ({ id, at: Number(v?.at) || 0 }))
      .filter((x) => x.at && now - x.at < withinMs)
      .sort((a, b) => b.at - a.at)
    return rows[0]?.id || ''
  }

  function pickChannel(event, cfg, state) {
    if (cfg.preferSession !== false) {
      const origin = String(event.sessionId || '').trim()
      if (origin) return { kind: 'session', sessionId: origin }
      if (cfg.fallbackChannel === 'session') {
        const id = String(cfg.fallbackSession || '').trim() || latestSession(state)
        if (id) return { kind: 'session', sessionId: id }
      }
    }
    return { kind: 'wechat' }
  }

  async function deliver(channel, text) {
    const body = clipLines(text, cfg_maxChars())
    if (channel.kind === 'session') {
      const agent = resolveAgent(channel.sessionId)
      if (!agent || typeof agent.followup !== 'function') {
        throw new Error(`会话 ${channel.sessionId} 不在（或不能投）`)
      }
      agent.followup(sessionMessage(body))
      return { channel: `会话 ${channel.sessionId}` }
    }
    const r = await sendWechatText({ workspace: ws, text: body })
    return { channel: '微信私聊', id: r.id }
  }

  function cfg_maxChars() {
    try {
      return loadConfig(ws).maxChars || 1200
    } catch {
      return 1200
    }
  }

  /**
   * 推一条。成功返回 {ok:true}；失败进 pending（不抛）。
   */
  async function push(event) {
    const cfg = loadConfig(ws)
    const state = readState()
    const limit = Number(event.maxChars) > 0 ? Number(event.maxChars) : cfg.maxChars
    const text = clipLines(String(event.text || ''), limit)
    if (!text) return { ok: false, reason: '空内容' }
    if (!cfg.enabled) return { ok: false, reason: '推送已关' }

    const key = keyOf(event.source || 'notify', text)
    if (state.sentKeys.includes(key)) return { ok: false, reason: '重复' }

    const channel = pickChannel(event, cfg, state)
    try {
      const sent = await deliver(channel, text)
      state.sentKeys = [...state.sentKeys, key].slice(-500)
      // 同一内容之前失败进了 pending（比如会话投不进退回微信），这次成了就别再重试一遍
      state.pending = state.pending.filter((p) => p.key !== key)
      state.stats.pushed += 1
      state.stats.lastPushAt = Date.now()
      saveState(state)
      log(`已推送到${sent.channel}：${clip(text, 80)}`)
      return { ok: true, channel: sent.channel }
    } catch (e) {
      const reason = redact(e?.message || e)
      state.pending = [
        ...state.pending,
        { key, text, channel, tries: 1, at: Date.now(), error: reason },
      ].slice(-50)
      state.stats.failed += 1
      state.stats.lastError = reason
      saveState(state)
      log(`推送失败（下次重试）：${reason}｜${clip(text, 60)}`)
      return { ok: false, reason }
    }
  }

  /** 重试 pending；重试用完就丢。 */
  async function retryPending(cfg) {
    const state = readState()
    if (!state.pending.length) return 0
    const keep = []
    let okCount = 0
    for (const item of state.pending) {
      try {
        const sent = await deliver(item.channel, item.text)
        state.sentKeys = [...state.sentKeys, item.key].slice(-500)
        state.stats.pushed += 1
        state.stats.lastPushAt = Date.now()
        okCount += 1
        log(`重试成功（${sent.channel}）：${clip(item.text, 60)}`)
      } catch (e) {
        const tries = (Number(item.tries) || 0) + 1
        if (tries > cfg.maxRetry) {
          state.stats.dropped += 1
          log(`重试 ${cfg.maxRetry} 次仍失败，丢掉：${clip(item.text, 60)}`)
        } else {
          keep.push({ ...item, tries, at: Date.now(), error: redact(e?.message || e) })
        }
      }
    }
    state.pending = keep
    saveState(state)
    return okCount
  }

  /** 某个 "HH:mm" 今天的时刻（毫秒）；配置坏了按 08:30。 */
  function slotMs(at, now = Date.now()) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(at || '08:30').trim())
    const h = m ? Number(m[1]) : 8
    const mi = m ? Number(m[2]) : 30
    return Date.parse(`${bjDay(now)}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00+08:00`)
  }

  /** 今天的 newsAt 时刻（毫秒）。 */
  function newsSlot(cfg, now = Date.now()) {
    return slotMs(cfg.newsAt, now)
  }

  /**
   * 早报末尾加两节：① 今天接着干的（任务/接续里没完的，最多占原文 1/3）
   * ② 插件体检一行。哪块失败都只记日志，正文照推。
   */
  async function appendDigest(text, cfg, log_) {
    const say = log_ || (() => {})
    let out = String(text || '')
    if (!out) return out
    // 附录整段不超过原新闻的 1/3；体检那行也要占地方，先给它留出来
    const reserve = cfg.digestHealth ? 70 : 10
    const budget = Math.max(100, Math.floor(out.length / 3) - reserve)
    if (cfg.digestBacklog) {
      try {
        const sec = backlogSection({ workspace: ws, max: cfg.digestBacklogMax, budget })
        if (sec) out += sec
      } catch (e) {
        say(`早报附录（今天接着干的）失败：${redact(e?.message || e)}`)
      }
    }
    if (cfg.digestHealth) {
      try {
        const line = await healthLine()
        if (line) out += `\n\n${line}`
      } catch (e) {
        say(`早报附录（插件体检）失败：${redact(e?.message || e)}`)
      }
    }
    return out
  }

  /** 该推新闻就推，返回一句状态；不推返回 ''。 */
  async function maybePushNews(cfg, state) {
    const now = Date.now()
    const day = bjDay(now)
    if (state.lastNewsDay === day) return ''
    if (now < newsSlot(cfg, now)) return ''
    const news = await buildDailyNews({
      day: day.slice(5),
      maxGeneral: cfg.newsMaxGeneral,
      maxAi: cfg.newsMaxAi,
    })
    if (!news.ok) {
      log(`今日新闻没拉到内容：${news.errors.join('；') || '源全挂'}`)
      return ''
    }
    // 推回原会话：newsChannel=session 就投最近活跃会话，投不进再兜底微信
    let sessionId = ''
    if (cfg.newsChannel !== 'wechat') {
      sessionId = String(cfg.fallbackSession || '').trim() || latestSession(state)
    }
    const body = await appendDigest(news.text, cfg, log)
    let r = await push({
      source: 'news',
      text: body,
      sessionId,
      maxChars: cfg.newsMaxChars,
    })
    if (!r.ok && sessionId && r.reason && r.reason.includes('不在')) {
      r = await push({ source: 'news', text: body, sessionId: '', maxChars: cfg.newsMaxChars })
    }
    if (r.ok) {
      const fresh = readState()
      fresh.lastNewsDay = day
      fresh.lastNewsAt = now
      saveState(fresh)
      log(`今日新闻已推（要闻 ${news.general} 条、AI ${news.ai} 条）：${r.channel}`)
      return `news:${r.channel}`
    }
    log(`今日新闻没推出去：${r.reason}`)
    return ''
  }

  /**
   * 挂账检查：每天 staleAt（默认 09:00）之后跑一次，
   * 工单「待处理」/任务「进行中·待办」挂超过 staleHours（默认 24 小时）没动就推一条。
   * 同一天只推一次；没有挂着的活就不推（也不占当天的名额）。
   */
  async function maybePushStale(cfg, state, { force = false } = {}) {
    if (!cfg.staleCheck) return ''
    const now = Date.now()
    const day = bjDay(now)
    if (!force) {
      if (state.lastStaleDay === day) return ''
      if (now < slotMs(cfg.staleAt, now)) return ''
    }
    const found = collectStale({ workspace: ws, hours: cfg.staleHours, max: cfg.staleMaxTasks, now })
    if (!found.total) {
      log('挂账检查：没有挂着的活')
      return ''
    }
    const text = renderStale(found, day)
    if (!text) return ''
    let sessionId = ''
    if (cfg.newsChannel !== 'wechat') {
      sessionId = String(cfg.fallbackSession || '').trim() || latestSession(state)
    }
    let r = await push({ source: 'stale', text, sessionId })
    if (!r.ok && sessionId && r.reason && r.reason.includes('不在')) {
      r = await push({ source: 'stale', text, sessionId: '' })
    }
    if (!r.ok) {
      log(`挂账提醒没推出去：${r.reason}`)
      return ''
    }
    const fresh = readState()
    fresh.lastStaleDay = day
    fresh.lastStaleAt = now
    saveState(fresh)
    log(
      `挂账提醒已推（工单 ${found.orders.length} 单、任务 ${found.tasks.length} 条，>${found.hours} 小时没动）：${r.channel}`,
    )
    return `stale:${r.channel}`
  }

  /** 一轮：补救旧的 → 拉新的 → 推。 */
  async function tick() {
    if (ticking) return { ok: true, action: 'busy' }
    ticking = true
    const cfg = loadConfig(ws)
    try {
      if (!cfg.enabled) return { ok: true, action: 'disabled' }
      ensureDir(P.outbox)
      const state = readState()
      await retryPending(cfg)

      const events = []

      if (cfg.sources.yuyu) {
        try {
          const res = await pollYuyu({ cursor: state.yuyuCursor, envFiles: P.yuyuEnvFiles })
          for (const it of res.items) {
            const body = `【鱼的世界】${it.time} ${it.text}`
            events.push({
              source: `yuyu:${it.kind}`,
              text: body,
              sessionId: '',
            })
            // 同时往最近一条会话塞一份，让米萨自己也看得见（2026-11-27 master 定）
            try {
              const sid = String(cfg.fallbackSession || '').trim() || latestSession(state)
              const agent = sid ? resolveAgent(sid) : null
              if (agent && typeof agent.followup === 'function') {
                agent.followup(sessionMessage(`【鱼的世界·同步】${it.time} ${it.text}`))
              }
            } catch {}
          }
          if (res.cursor) state.yuyuCursor = res.cursor
          saveState(state)
        } catch (e) {
          log(`拉鱼世界通知失败：${redact(e?.message || e)}`)
        }
      }

      if (cfg.sources.inbox) {
        for (const item of drainInbox(P.outbox)) {
          events.push({ source: item.source, text: item.text, sessionId: item.session })
        }
      }

      // 每日新闻：到点且今天还没推过
      let newsState = ''
      if (cfg.sources.news) {
        try {
          const r = await maybePushNews(cfg, state)
          if (r) newsState = r
        } catch (e) {
          log(`推今日新闻失败：${redact(e?.message || e)}`)
        }
      }

      // 挂账检查：每天一次，工单/任务挂 24 小时没动
      let staleState = ''
      if (cfg.staleCheck) {
        try {
          const r = await maybePushStale(cfg, readState())
          if (r) staleState = r
        } catch (e) {
          log(`挂账检查失败：${redact(e?.message || e)}`)
        }
      }

      let pushed = 0
      for (const ev of events.slice(0, cfg.maxPerTick)) {
        const r = await push(ev)
        if (r.ok) pushed += 1
      }
      if (events.length) log(`本轮新事件 ${events.length} 条，推出 ${pushed} 条`)
      return {
        ok: true,
        action: 'tick',
        events: events.length,
        pushed,
        news: newsState || undefined,
        stale: staleState || undefined,
      }
    } catch (e) {
      log(`轮询出错：${redact(e?.message || e)}`)
      return { ok: false, action: 'error', error: redact(e?.message || e) }
    } finally {
      ticking = false
    }
  }

  function start() {
    stopping = false
    const cfg = loadConfig(ws)
    const ms = Math.max(60_000, Math.round(cfg.intervalMin * 60_000))
    const boot = setTimeout(() => {
      tick().catch(() => {})
    }, 15_000)
    if (boot && typeof boot.unref === 'function') boot.unref()
    timer = setInterval(() => {
      if (stopping) return
      tick().catch(() => {})
    }, ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
    log(`推送已启动：每 ${cfg.intervalMin} 分钟一轮，来源 ${JSON.stringify(cfg.sources)}，兜底 ${cfg.fallbackChannel}`)
    return stop
  }

  function stop() {
    stopping = true
    if (timer) clearInterval(timer)
    timer = null
  }

  function status() {
    const cfg = loadConfig(ws)
    const state = readState()
    const lines = [
      `主动推送：${cfg.enabled ? '开着' : '关了'}`,
      `- 每 ${cfg.intervalMin} 分钟一轮｜每轮最多 ${cfg.maxPerTick} 条`,
      `- 来源：鱼世界 ${cfg.sources.yuyu ? '开' : '关'}／收件箱 ${cfg.sources.inbox ? '开' : '关'}／今日新闻 ${cfg.sources.news ? `开（每天 ${cfg.newsAt}）` : '关'}`,
      `- 今日新闻：${state.lastNewsDay ? `上次 ${state.lastNewsDay}${state.lastNewsAt ? ' ' + bjShort(state.lastNewsAt) : ''}` : '还没推过'}`,
      `- 早报附录：今天接着干的 ${cfg.digestBacklog ? `开（最多 ${cfg.digestBacklogMax} 条）` : '关'}｜插件体检 ${cfg.digestHealth ? '开' : '关'}`,
      `- 挂账检查：${cfg.staleCheck ? `开（每天 ${cfg.staleAt}，>${cfg.staleHours} 小时没动，任务最多 ${cfg.staleMaxTasks} 条）` : '关'}${state.lastStaleDay ? `｜上次 ${state.lastStaleDay}${state.lastStaleAt ? ' ' + bjShort(state.lastStaleAt) : ''}` : ''}`,
      `- 有发起会话就回那条；没有则 ${cfg.fallbackChannel === 'session' ? `投会话 ${cfg.fallbackSession || '(最近活跃)'}` : '发微信私聊'}`,
      `- 鱼世界游标：${state.yuyuCursor || '（还没拉过）'}`,
      `- 累计：推成功 ${state.stats.pushed}｜失败 ${state.stats.failed}｜丢弃 ${state.stats.dropped}`,
      `- 上次推送：${state.stats.lastPushAt ? bjShort(state.stats.lastPushAt) : '还没推过'}`,
      `- 待重试：${state.pending.length} 条${state.stats.lastError ? `｜上次错误：${state.stats.lastError}` : ''}`,
      `- 配置：${P.config}`,
      `- 状态：${P.state}`,
    ]
    return lines.join('\n')
  }

  return {
    workspace: ws,
    paths: P,
    tick,
    push,
    start,
    stop: () => stop(),
    status,
    setAgents,
    noteSession,
    readState,
    maybePushNews,
    maybePushStale,
    newsSlot,
    slotMs,
    appendDigest,
  }
}

/** 给别处写收件箱用的：丢一条 JSON 进去就会被推走。 */
export function writeInbox(workspace, { text, source = 'inbox', session = '' }) {
  const dir = paths(workspace).outbox
  ensureDir(dir)
  const name = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ text, source, session }, null, 2), 'utf8')
  return path.join(dir, name)
}
