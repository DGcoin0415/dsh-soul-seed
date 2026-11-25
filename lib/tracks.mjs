// 轨道：常做的活记成一条可复用配方，下次照着跑；跑不通按 fallback 退回。
// 纯文件操作，不依赖 DSH 内部 API，方便单独测试。
// 数据落仓库自己的共享区：<soul home>/shared/轨道.json（可用 DSH_SHARED_DIR / DSH_SOUL_DIR 改）。
import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite } from './atomic.mjs'
import { sharedRoot } from './soulcore.mjs'

export const TRACKS_FILE = '轨道.json'
export const VERSION = 1

/** 轨道文件：默认 shared/轨道.json；测试时可以传 file 指到临时文件。 */
export function tracksPath(file) {
  if (typeof file === 'string' && file.trim()) return path.resolve(file.trim())
  return path.join(sharedRoot(), TRACKS_FILE)
}

/** 本地时区带偏移的 ISO 时间，例如 2026-11-25T18:00:00+08:00。 */
export function nowStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const off = -date.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
}

function emptyDb() {
  return { version: VERSION, tracks: [] }
}

function toList(value, seps) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v ?? '').trim()).filter(Boolean)
  }
  if (typeof value !== 'string') return []
  const re = new RegExp(`[${seps}]`)
  return value.split(re).map((v) => v.trim()).filter(Boolean)
}

/** keywords：逗号分隔（中英文逗号、顿号、分号都认）。 */
export function parseKeywords(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v ?? '').trim()).filter(Boolean)
  }
  if (typeof value !== 'string') return []
  return value.split(/[,，、;；]/).map((v) => v.trim()).filter(Boolean)
}

/** steps：｜（或半角 |）或换行分隔，都认。 */
export function parseSteps(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v ?? '').trim()).filter(Boolean)
  }
  if (typeof value !== 'string') return []
  return value.split(/[｜|\r\n]+/).map((v) => v.trim()).filter(Boolean)
}

/** 洗一条轨道，缺字段给默认值；name 为空返回 null。 */
function normalizeTrack(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = String(raw.name ?? '').trim()
  if (!name) return null
  return {
    name,
    keywords: toList(raw.keywords, ',，、;；'),
    steps: toList(raw.steps, '｜|\\r\\n'),
    fallback: String(raw.fallback ?? '').trim(),
    uses: Number(raw.uses) || 0,
    fails: Number(raw.fails) || 0,
    updated: typeof raw.updated === 'string' && raw.updated.trim() ? raw.updated.trim() : nowStamp(),
  }
}

/** 读轨道库；文件不存在或坏了都当空库。 */
export function loadTracks(file) {
  let raw = null
  try {
    raw = fs.readFileSync(tracksPath(file), 'utf8')
  } catch {
    return emptyDb()
  }
  if (!raw || !raw.trim()) return emptyDb()
  let json
  try {
    json = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    return emptyDb()
  }
  const list = Array.isArray(json) ? json : Array.isArray(json?.tracks) ? json.tracks : []
  const tracks = []
  const seen = new Set()
  for (const item of list) {
    const track = normalizeTrack(item)
    if (!track) continue
    const key = track.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tracks.push(track)
  }
  return { version: Number(json?.version) || VERSION, tracks }
}

/** 原子写轨道库；先建目录，再交给 atomicWrite（rename 才是原子落盘）。 */
export function saveTracks(db, file) {
  const target = tracksPath(file)
  const body = {
    version: VERSION,
    tracks: (Array.isArray(db?.tracks) ? db.tracks : []).map(normalizeTrack).filter(Boolean),
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  atomicWrite(target, JSON.stringify(body, null, 2))
  return target
}

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()

const squash = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '')

/** 模糊匹配：先精确 name，其次 name 互相包含，再比 keywords；返回 { track, score } 或 null。 */
export function matchTrack(tracks, query) {
  const q = squash(query)
  if (!q) return null
  let best = null
  for (const track of tracks || []) {
    const name = squash(track.name)
    let score = 0
    if (name === q) score = 100
    else if (name.includes(q) || q.includes(name)) score = 80
    else {
      for (const kw of track.keywords || []) {
        const k = squash(kw)
        if (!k) continue
        if (k === q) { score = Math.max(score, 70); continue }
        if (k.includes(q) || q.includes(k)) score = Math.max(score, 60)
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { track, score }
  }
  return best
}

/**
 * 存一条轨道：同 name（不分大小写）已存在就覆盖内容并更新 updated，
 * 保留原来的 uses / fails。
 */
export function saveTrack(input, file) {
  const name = String(input?.name ?? '').trim()
  if (!name) return { ok: false, message: '缺少 name（轨道短名）' }
  const steps = parseSteps(input?.steps)
  if (!steps.length) return { ok: false, message: '缺少 steps（分步，用 ｜ 或换行分隔）' }
  const db = loadTracks(file)
  const track = {
    name,
    keywords: parseKeywords(input?.keywords),
    steps,
    fallback: String(input?.fallback ?? '').trim(),
    uses: 0,
    fails: 0,
    updated: nowStamp(),
  }
  const at = db.tracks.findIndex((t) => sameName(t.name, name))
  const existed = at >= 0
  if (existed) {
    track.uses = Number(db.tracks[at].uses) || 0
    track.fails = Number(db.tracks[at].fails) || 0
    db.tracks[at] = track
  } else {
    db.tracks.push(track)
  }
  saveTracks(db, file)
  return {
    ok: true,
    track,
    existed,
    total: db.tracks.length,
    message: `${existed ? '已更新' : '已存'}轨道「${track.name}」：${track.steps.length} 步，关键词 ${track.keywords.join('、') || '（无）'}`,
  }
}

/** 列全部轨道：只回 name / keywords / 用过几次。 */
export function listTracks(file) {
  const db = loadTracks(file)
  return db.tracks.slice().sort((a, b) => (b.uses - a.uses) || a.name.localeCompare(b.name))
}

export function renderTrackList(rows) {
  if (!rows.length) return '还没有轨道'
  return rows.map((t) =>
    `- ${t.name}｜关键词：${t.keywords.join('、') || '（无）'}｜用过 ${t.uses} 次${t.fails ? `（失败 ${t.fails}）` : ''}`,
  ).join('\n')
}

/** 按 query 模糊匹配一条轨道，命中回完整 steps + fallback；没命中回 null。 */
export function showTrack(query, file) {
  if (!String(query ?? '').trim()) return null
  const hit = matchTrack(loadTracks(file).tracks, query)
  return hit ? hit.track : null
}

export function renderTrack(track) {
  if (!track) return '没有这条轨道'
  const lines = [
    `轨道：${track.name}`,
    `关键词：${track.keywords.join('、') || '（无）'}`,
    `用过 ${track.uses} 次${track.fails ? `，失败 ${track.fails} 次` : ''}　更新于 ${track.updated}`,
    '',
    '步骤：',
    ...track.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    `跑不通：${track.fallback || '（没写退路，自己看着办）'}`,
  ]
  return lines.join('\n')
}

/** 跑完一条轨道记一次账：uses+1，失败再 fails+1。没命中返回 null。 */
export function bumpTrack(query, ok, file) {
  if (!String(query ?? '').trim()) return null
  const db = loadTracks(file)
  const hit = matchTrack(db.tracks, query)
  if (!hit) return null
  hit.track.uses = (Number(hit.track.uses) || 0) + 1
  if (ok === false) hit.track.fails = (Number(hit.track.fails) || 0) + 1
  hit.track.updated = nowStamp()
  saveTracks(db, file)
  return hit.track
}

export function renderBump(track, ok) {
  if (!track) return '没有这条轨道'
  return `${track.name}：这次${ok === false ? '没跑通' : '跑通'}，累计用过 ${track.uses} 次、失败 ${track.fails} 次`
}
