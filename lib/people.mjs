// 按人账本：好感 / 心情 / 见面次数 / 备注。
//
// 两种格式都能读、都能写回（谁的账本就按谁的格式改，不偷偷换格式）：
//   v1（老工作区）<共享工作区>/shared/people/people.json
//      { version:1, global:{...}, people:{ key:{ name, affinity, mood(文字), moodScore(数字), moodAt, encounters, notes:[{at,kind,summary}] } }, grudgeThreshold }
//   v2（仓库自己的）<soul-seed>/people.json
//      { version:2, people:{ id:{ id, nickname, goodwill, mood(数字), meets, lastAt, events, favors, secrets } }, links }
//
// 查找顺序在 lib/local-env.mjs：先老工作区的 v1，读不到再回落 soul-seed。
// 纯文件操作 + atomicWrite，不依赖 DSH 内部 API，方便单独测试。
import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite } from './atomic.mjs'
import { resolveLedgerFile } from './local-env.mjs'
import { soulHome } from './home.mjs'
import { decayRounded, moodLabel } from './decay.mjs'

const DEFAULT_GRUDGE_THRESHOLD = 30

const emptyV1 = () => ({
  version: 1,
  global: { affinity: 55, mood: '平静' },
  people: {},
  updatedAt: null,
  links: [],
  habits: [],
  masterKeys: [],
  grudgeThreshold: DEFAULT_GRUDGE_THRESHOLD,
  treasures: [],
})

const emptyV2 = () => ({ version: 2, people: {}, links: [] })

/** 账本文件：老工作区优先，其次 soul-seed（见 local-env.mjs）。 */
export function ledgerFile() {
  return resolveLedgerFile()
}

/** 空账本按位置决定格式：落在 soul-seed/people.json 就用 v2，别处用 v1。 */
function emptyLedgerFor(file) {
  const repoFile = path.join(soulHome(), 'people.json')
  try {
    return path.resolve(file) === path.resolve(repoFile) ? emptyV2() : emptyV1()
  } catch {
    return emptyV1()
  }
}

/** 判断账本格式：v1 / v2。字段优先，version 兜底。 */
export function ledgerShape(ledger) {
  if (!ledger || typeof ledger !== 'object') return 'v1'
  if (Number(ledger.version) === 2) return 'v2'
  if (ledger.global && typeof ledger.global === 'object') return 'v1'
  const first = Object.values(ledger.people || {}).find((p) => p && typeof p === 'object')
  if (first && !('affinity' in first) && ('goodwill' in first || 'nickname' in first || 'meets' in first)) return 'v2'
  return 'v1'
}

/** 读账本；文件不存在、坏了、形状不对都当空账本，不抛。 */
export function loadLedger() {
  const file = ledgerFile()
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return emptyLedgerFor(file)
  }
  let json = null
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return emptyLedgerFor(file)
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return emptyLedgerFor(file)
  if (!json.people || typeof json.people !== 'object' || Array.isArray(json.people)) json.people = {}
  if (!Array.isArray(json.links)) json.links = []
  return json
}

/** 原子写回原文件（格式不换）。 */
export function saveLedger(ledger) {
  const file = ledgerFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  ledger.updatedAt = new Date().toISOString()
  atomicWrite(file, JSON.stringify(ledger, null, 2) + '\n')
  return file
}

// ---------------------------------------------------------------- 读数

export const clamp = (value, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, Math.round(Number(value) || 0)))

export function nameOf(person, key = '') {
  return String(person?.name || person?.nickname || key)
}

/** 好感：v1 是 affinity，v2 是 goodwill。 */
export function affinityOf(person) {
  if (typeof person?.affinity === 'number' && Number.isFinite(person.affinity)) return person.affinity
  if (typeof person?.goodwill === 'number' && Number.isFinite(person.goodwill)) return person.goodwill
  return 50
}

/** 心情分：v1 是 moodScore，v2 的 mood 本身就是数字。 */
export function scoreOf(person) {
  if (typeof person?.moodScore === 'number' && Number.isFinite(person.moodScore)) return person.moodScore
  if (typeof person?.mood === 'number' && Number.isFinite(person.mood)) return person.mood
  return 50
}

/** 心情标签：v1 的 mood 是文字；v2 没有标签就按分数推。 */
export function labelOf(person) {
  if (typeof person?.mood === 'string' && person.mood.trim()) return person.mood.trim()
  if (typeof person?.moodLabel === 'string' && person.moodLabel.trim()) return person.moodLabel.trim()
  return moodLabel(scoreOf(person))
}

export function meetsOf(person) {
  const n = Number(person?.encounters ?? person?.meets)
  return Number.isFinite(n) ? n : 0
}

export function lastSeenOf(person) {
  return person?.lastSeen || person?.lastAt || ''
}

/** 备注/事件：v1 叫 notes（summary），v2 叫 events（why）。 */
export function notesOf(person) {
  if (Array.isArray(person?.notes)) return person.notes
  if (Array.isArray(person?.events)) return person.events
  return []
}

/** 记仇门槛：低于它就算记着了，不会因为时间过去就自己消。 */
export function isGrudge(ledger, person) {
  if (!person) return false
  const threshold = Number(ledger?.grudgeThreshold ?? DEFAULT_GRUDGE_THRESHOLD) || DEFAULT_GRUDGE_THRESHOLD
  return scoreOf(person) < threshold
}

// ---------------------------------------------------------------- 写

/** 取人，没有就按当前账本格式建一个；顺手记一次见面。 */
export function ensurePerson(ledger, key, name) {
  const shape = ledgerShape(ledger)
  const now = new Date().toISOString()
  if (!ledger.people || typeof ledger.people !== 'object') ledger.people = {}
  let person = ledger.people[key]
  if (!person || typeof person !== 'object') {
    if (shape === 'v2') {
      person = {
        id: key,
        nickname: name || key,
        goodwill: 50,
        mood: 50,
        meets: 1,
        firstAt: now,
        lastAt: now,
        habits: [],
        events: [],
        favors: [],
        secrets: [],
      }
    } else {
      person = {
        name: name || key,
        affinity: 50,
        mood: '平静',
        firstSeen: now,
        lastSeen: now,
        encounters: 1,
        notes: [],
        moodScore: 50,
        moodAt: now,
      }
    }
    ledger.people[key] = person
    return person
  }
  if (name) {
    if (shape === 'v2') person.nickname = name
    else person.name = name
  }
  if (shape === 'v2') {
    person.lastAt = now
    person.meets = meetsOf(person) + 1
  } else {
    person.lastSeen = now
    person.encounters = meetsOf(person) + 1
  }
  return person
}

/** 加减好感，写回原格式字段，返回新值。 */
export function bumpAffinity(ledger, person, delta) {
  const next = clamp(affinityOf(person) + (Number(delta) || 0))
  if ('affinity' in person && !('goodwill' in person)) person.affinity = next
  else if ('goodwill' in person && !('affinity' in person)) person.goodwill = next
  else if (ledgerShape(ledger) === 'v2') person.goodwill = next
  else person.affinity = next
  return next
}

/** 设心情分（0-100），有 label 就一起记；返回新分数。 */
export function setMood(ledger, person, score, label, intent) {
  const next = clamp(score === undefined || score === null || score === '' ? 50 : score)
  const now = new Date().toISOString()
  const numericV2 = typeof person.mood === 'number' && !('moodScore' in person)
  if (ledgerShape(ledger) === 'v2' || numericV2) {
    person.mood = next
    if (label) person.moodLabel = String(label).trim()
  } else {
    person.moodScore = next
    if (label) person.mood = String(label).trim()
    else if (typeof person.mood !== 'string' || !person.mood.trim()) person.mood = moodLabel(next)
  }
  person.moodAt = now
  if (intent) person.intent = intent
  return next
}

/**
 * 把账本里所有人的心情按半衰期衰减一遍，返回变动人数。
 * v1 改 moodScore，v2 改 mood；不变的不动 moodAt，免得把时间戳刷成现在。
 */
export function decayAll(ledger, now = Date.now()) {
  let changed = 0
  for (const person of Object.values(ledger.people || {})) {
    if (!person || typeof person !== 'object') continue
    const useMood = typeof person.moodScore !== 'number' && typeof person.mood === 'number'
    if (!useMood && typeof person.moodScore !== 'number') continue
    const before = useMood ? person.mood : person.moodScore
    if (!Number.isFinite(before)) continue
    // 老账本可能没 moodAt：退到最近一次见面/活动时间，跟仓库 people.mjs 的 p.moodAt ?? p.lastAt 一致。
    const at = person.moodAt || person.lastAt || person.lastSeen
    const next = decayRounded(before, at, now)
    if (next === Math.round(before)) continue
    if (useMood) person.mood = next
    else person.moodScore = next
    person.moodAt = new Date(now).toISOString()
    changed += 1
  }
  return changed
}

// ---------------------------------------------------------------- 输出

/** person-get 的返回格式（跟老插件一致，多一行最近备注）。 */
export function renderPerson(key, person, ledger) {
  const notes = notesOf(person)
  const tail = notes.length ? notes[notes.length - 1] : null
  const last = tail ? String(tail.summary || tail.why || tail.kind || '').trim() : ''
  return [
    `${nameOf(person, key)}（${key}）`,
    `好感 ${affinityOf(person)}　心情分 ${scoreOf(person)}（${labelOf(person)}）`,
    `见面 ${meetsOf(person)} 次　最近 ${lastSeenOf(person) || '未知'}`,
    isGrudge(ledger, person) ? '⚠ 心情分低于记仇门槛，没服软/没报复过就不会自然消退' : '',
    last ? `最近一条：${last.slice(0, 120)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
