/**
 * dsh-ctx-alert · 状态与落账
 *
 * 状态：<工作区>/state/ctx-alert.json
 * 日志：<工作区>/state/ctx-alert.log（只记结论，不记 token/密钥）
 * 历史：<工作区>/shared/历史/<当月>.md（每次告警追加一条）
 *
 * 所有写都是原子写（tmp + rename），写失败不抛，绝不影响会话。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const STATE_VERSION = 1

export function beijingStamp(ms = Date.now()) {
  const d = new Date(ms + 8 * 3600_000)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    month: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}`,
    full: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
  }
}

export function emptyState() {
  return { version: STATE_VERSION, updatedAt: 0, sessions: {}, alerts: [] }
}

export function readState(stateFile) {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    raw = {}
  }
  const s = { ...emptyState(), ...(raw && typeof raw === 'object' ? raw : {}) }
  if (!s.sessions || typeof s.sessions !== 'object') s.sessions = {}
  if (!Array.isArray(s.alerts)) s.alerts = []
  return s
}

export function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function atomicWriteJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

export function appendLog(logFile, line) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.appendFileSync(logFile, `${beijingStamp().full} ${line}\n`, 'utf8')
  } catch {}
}

/** 追加一条到 shared/历史/<当月>.md（只追加，不改别的）。 */
export function appendHistory(historyDir, line, ms = Date.now()) {
  try {
    fs.mkdirSync(historyDir, { recursive: true })
    const file = path.join(historyDir, `${beijingStamp(ms).month}.md`)
    fs.appendFileSync(file, `- ${line}\n`, 'utf8')
    return file
  } catch {
    return ''
  }
}

export function sessionState(state, sid, cfg) {
  const key = String(sid || 'unknown')
  const cur = state.sessions[key]
  if (!cur || typeof cur !== 'object') {
    state.sessions[key] = {
      round: 0,
      peak: null,
      lastPct: null,
      samples: 0,
      seeded: false,
      firstSeenAt: Date.now(),
      updatedAt: Date.now(),
      alerts: {},
      recent: [],
    }
  }
  const rec = state.sessions[key]
  if (!rec.alerts || typeof rec.alerts !== 'object') rec.alerts = {}
  if (!Array.isArray(rec.recent)) rec.recent = []
  return rec
}

export function pushSample(rec, pct, round, cfg) {
  const at = Date.now()
  rec.recent = [...rec.recent, { at, pct, round }].slice(-Math.max(5, Number(cfg?.keepSamples) || 30))
  rec.samples = (Number(rec.samples) || 0) + 1
  rec.lastPct = pct
  rec.round = round
  rec.updatedAt = at
}

/** 只留最近几个会话，别让状态文件越长越大。 */
export function pruneSessions(state, cfg) {
  const keep = Math.max(5, Number(cfg?.keepSessions) || 40)
  const rows = Object.entries(state.sessions)
  if (rows.length <= keep) return
  rows.sort((a, b) => (Number(b[1]?.updatedAt) || 0) - (Number(a[1]?.updatedAt) || 0))
  for (const [id] of rows.slice(keep)) delete state.sessions[id]
}

export function recordAlert(state, entry, cfg) {
  state.alerts = [...state.alerts, entry].slice(-100)
  state.updatedAt = Date.now()
  pruneSessions(state, cfg)
}

/** 会话 id 太长，落账只用前 8 位。 */
export function shortId(sid) {
  const s = String(sid || '')
  return s.replace(/^session-/, '').slice(0, 8) || '(未知)'
}
