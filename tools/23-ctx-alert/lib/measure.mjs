/**
 * dsh-ctx-alert · 真实占用
 *
 * 目标：拿到「界面右下角那个百分比」同一套数，而不是模型自己估的。
 * 取值优先级（前面拿得到就不往后走）：
 *   1. tokenMeter.contextPressure(session)  → projectedTokens / pressureTokens + contextWindow
 *   2. sessionProjections.snapshot(session, ['contextPressure'])  → 同上
 *   3. 本轮事件带的 usage.totalTokens（assistant/message，最省）
 *   4. session.snapshotEvents() 里最后一条 assistant/message 的 usage.totalTokens
 *   5. 会话文件 <sessions>/<slug>/<id>/session.v4.jsonl.zstd（同 context-check.mjs 的逻辑，带缓存）
 *
 * 窗口：先看 contextPressure.contextWindow，再看会话里 request/context 的 contextWindow，
 *       最后才用配置里的 windowTokens（默认 1048576）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const USAGE_RE =
  /"usage":\{"inputTokens":(\d+),"outputTokens":(\d+),"cacheReadTokens":(\d+),"cacheWriteTokens":(\d+),"totalTokens":(\d+)\}/

const fileCache = new Map() // sid -> { at, tokens, window }
const windowCache = new Map() // sid -> { at, window }

function decodeZstdFrames(buf) {
  const idxs = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      idxs.push(i)
    }
  }
  const outs = []
  for (let k = 0; k < idxs.length; k++) {
    const start = idxs[k]
    const end = k + 1 < idxs.length ? idxs[k + 1] : buf.length
    try {
      outs.push(zlib.zstdDecompressSync(buf.subarray(start, end)))
    } catch {
      // 正在写的半帧跳过
    }
  }
  return Buffer.concat(outs).toString('utf8')
}

export function findSessionFile(sessionsRoot, sessionId) {
  const id = String(sessionId || '').trim()
  if (!id) return ''
  const names = [id, `session-${id}`]
  let dirs = []
  try {
    dirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return ''
  }
  for (const d of dirs) {
    for (const name of names) {
      const f = path.join(sessionsRoot, d.name, name, 'session.v4.jsonl.zstd')
      try {
        if (fs.statSync(f).isFile()) return f
      } catch {
        // 下一个
      }
    }
  }
  return ''
}

/** 读会话文件：最后一条 assistant/message 的 totalTokens + 最后一次 request/context 的 contextWindow。 */
export function scanSessionFile(file) {
  const text = decodeZstdFrames(fs.readFileSync(file))
  let tokens = null
  let window = 0
  const curve = []
  for (const line of text.split('\n')) {
    if (!line) continue
    if (line.startsWith('{"type":"request/context"')) {
      try {
        const o = JSON.parse(line)
        const w = Number(o?.data?.contextWindow || 0)
        if (Number.isFinite(w) && w > 0) window = w
      } catch {}
      continue
    }
    if (!line.includes('"type":"assistant/message"')) continue
    try {
      const o = JSON.parse(line)
      const usage = o?.data?.usage
      const total = Number(usage?.totalTokens || 0)
      if (Number.isFinite(total) && total > 0) {
        tokens = total
        curve.push(total)
      }
    } catch {
      const m = line.match(USAGE_RE)
      if (m) {
        tokens = Number(m[5])
        curve.push(tokens)
      }
    }
  }
  return { tokens, window, curve }
}

function fromFile(sessionId, cfg, ttlMs = 20_000) {
  const id = String(sessionId || '')
  const hit = fileCache.get(id)
  if (hit && Date.now() - hit.at < ttlMs) return hit
  const file = findSessionFile(cfg._sessionsRoot, id)
  if (!file) {
    const miss = { at: Date.now(), tokens: null, window: 0, file: '' }
    fileCache.set(id, miss)
    return miss
  }
  try {
    const r = scanSessionFile(file)
    const rec = { at: Date.now(), tokens: r.tokens, window: r.window, file }
    fileCache.set(id, rec)
    return rec
  } catch {
    return { at: Date.now(), tokens: null, window: 0, file }
  }
}

/** 从会话事件里找 request/context 的 contextWindow（缓存，免得每轮都扫）。 */
function windowFromContext(session, cfg) {
  const sid = String(session?.id || '')
  const hit = windowCache.get(sid)
  if (hit && Date.now() - hit.at < 60_000) return hit.window
  let window = 0
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
    for (let i = events.length - 1; i >= 0; i--) {
      const row = events[i]
      if (row?.type === 'request/context') {
        const w = Number(row?.data?.contextWindow || 0)
        if (Number.isFinite(w) && w > 0) {
          window = w
          break
        }
      }
    }
  } catch {}
  if (!window) {
    const f = fromFile(sid, cfg)
    window = Number(f?.window || 0)
  }
  windowCache.set(sid, { at: Date.now(), window })
  return window
}

/** 从会话记录里取最后一条 assistant/message 的 usage.totalTokens。 */
function usageFromSession(session) {
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
    for (let i = events.length - 1; i >= 0; i--) {
      const row = events[i]
      if (row?.type !== 'assistant/message') continue
      const total = Number(row?.data?.usage?.totalTokens || 0)
      if (Number.isFinite(total) && total > 0) return total
    }
  } catch {}
  return null
}

function clampPct(tokens, window) {
  if (!Number.isFinite(tokens) || tokens <= 0) return null
  if (!Number.isFinite(window) || window <= 0) return null
  return Math.min(100, Math.round((tokens / window) * 1000) / 10)
}

/**
 * 算真实占用。
 * @param {object} opts
 * @param {object} opts.session   会话对象（可能是 undefined）
 * @param {object} opts.meter     tokenMeter 服务（可能为 null）
 * @param {object} opts.projections sessionProjections 服务（可能为 null）
 * @param {number} [opts.eventUsageTokens] 本轮 assistant/message 的 usage.totalTokens
 * @param {object} opts.cfg
 * @returns {{pct:number|null, tokens:number|null, window:number, source:string}}
 */
export function measure(opts = {}) {
  const { session, meter, projections, eventUsageTokens, cfg } = opts
  const sid = String(session?.id || '')
  let window = 0
  let tokens = null
  let source = ''

  // 1. tokenMeter.contextPressure
  if (meter && typeof meter.contextPressure === 'function' && session) {
    try {
      const p = meter.contextPressure(session)
      if (p) {
        const used = Number(p.projectedTokens ?? p.pressureTokens ?? 0)
        const win = Number(p.contextWindow ?? 0)
        if (Number.isFinite(win) && win > 0) window = win
        if (Number.isFinite(used) && used > 0) {
          tokens = used
          source = 'tokenMeter.contextPressure'
        }
      }
    } catch {}
  }

  // 2. sessionProjections
  if (!tokens && projections && typeof projections.snapshot === 'function' && session) {
    try {
      const snap = projections.snapshot(session, ['contextPressure', 'contextTimeline'])
      const vals = snap?.values ?? {}
      const p = vals.contextPressure
      const used = Number(p?.projectedTokens ?? p?.pressureTokens ?? 0)
      const win = Number(p?.contextWindow ?? 0)
      if (!window && Number.isFinite(win) && win > 0) window = win
      if (!tokens && Number.isFinite(used) && used > 0) {
        tokens = used
        source = 'sessionProjections.contextPressure'
      }
    } catch {}
  }

  // 3. 本轮事件的 usage
  if (!tokens) {
    const n = Number(eventUsageTokens || 0)
    if (Number.isFinite(n) && n > 0) {
      tokens = n
      source = 'session/event usage'
    }
  }

  // 4. 会话里最后一条 assistant/message
  if (!tokens && session) {
    const n = usageFromSession(session)
    if (n) {
      tokens = n
      source = 'session.snapshotEvents usage'
    }
  }

  // 5. 会话文件
  if (!tokens && sid) {
    const f = fromFile(sid, cfg)
    if (f?.tokens) {
      tokens = f.tokens
      source = 'session file usage'
    }
    if (!window && f?.window) window = f.window
  }

  if (!window) {
    window = (session && windowFromContext(session, cfg)) || Number(cfg?.windowTokens || 0) || 1048576
  }

  return { pct: clampPct(tokens, window), tokens, window, source }
}

// 首个样本之外不需要，但第一次见到某个会话时要靠它把「已经压缩过几轮」补准。
const historyCache = new Map() // sid -> { at, pcts, window, file }

/**
 * 从会话文件读整条占用曲线（百分比，1 位小数）。
 * @returns {{pcts:number[], window:number, file:string}}
 */
export function historyFromFile(sessionId, cfg, ttlMs = 60_000) {
  const id = String(sessionId || '')
  const hit = historyCache.get(id)
  if (hit && Date.now() - hit.at < ttlMs) return hit
  const empty = { at: Date.now(), pcts: [], window: 0, file: '' }
  const file = findSessionFile(cfg?._sessionsRoot, id)
  if (!file) {
    historyCache.set(id, empty)
    return empty
  }
  try {
    const raw = scanSessionFile(file)
    const win = Number(raw.window || 0) || Number(cfg?.windowTokens || 0) || 1048576
    const pcts = []
    for (const t of raw.curve || []) {
      const p = clampPct(t, win)
      if (p != null) pcts.push(p)
    }
    const rec = { at: Date.now(), pcts, window: win, file }
    historyCache.set(id, rec)
    return rec
  } catch {
    historyCache.set(id, empty)
    return empty
  }
}

export const _internals = { decodeZstdFrames, clampPct, fileCache, windowCache, historyCache }