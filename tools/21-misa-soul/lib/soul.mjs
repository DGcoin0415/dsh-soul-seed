// 人工灵魂的存储层：根页、枝、历史、按人账本、情绪衰减。
// 全部是纯文件操作，不依赖 DSH 内部 API，方便单独测试。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const ROOT_FILE = 'SHARED-STATE.md'
const HISTORY_DIR = '历史'

/** 记忆目录：优先 DSH_SOUL_DIR，其次 ~/.dsh/im */
export function soulDir() {
  const custom = process.env.DSH_SOUL_DIR
  if (custom && custom.trim()) return path.resolve(custom.trim())
  return path.join(os.homedir(), '.dsh', 'im')
}

export function sharedDir() {
  return path.join(soulDir(), 'shared')
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 根页全文；没配置时返回 null。 */
export function readRoot() {
  return readText(path.join(soulDir(), ROOT_FILE))
}

/** 根页按字符数截断，给系统提示用。 */
export function renderRoot(maxChars = 6000) {
  const text = readRoot()
  if (!text) return ''
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}\n\n…（根页过长已截断，完整内容在 ${path.join(soulDir(), ROOT_FILE)}）`
}

/** 列出 shared/ 下的文件树（相对路径 + 字节数 + 修改时间）。 */
export function listTree(dir = sharedDir(), depth = 2) {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(soulDir(), full).split(path.sep).join('/')
    if (entry.isDirectory()) {
      out.push({ path: `${rel}/`, dir: true })
      if (depth > 1) out.push(...listTree(full, depth - 1))
      continue
    }
    try {
      const stat = fs.statSync(full)
      out.push({ path: rel, dir: false, bytes: stat.size, mtime: stat.mtime.toISOString() })
    } catch {
      out.push({ path: rel, dir: false, bytes: 0, mtime: null })
    }
  }
  return out
}

/**
 * 把外部给的相对路径收敛到 shared/ 里面，防目录穿越。
 * 允许读 shared 下的任何文本文件；不允许绝对路径、不允许 ..
 */
export function resolveBranch(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) throw new Error('缺少文件路径')
  const cleaned = relPath.trim().replace(/\\/g, '/').replace(/^shared\//, '')
  if (cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) throw new Error('只接受 shared/ 下的相对路径')
  const base = sharedDir()
  const full = path.resolve(base, cleaned)
  const rel = path.relative(base, full)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径越界')
  return full
}

export function readBranch(relPath, maxChars = 20000) {
  const full = resolveBranch(relPath)
  const text = readText(full)
  if (text === null) return null
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（已截断）` : text
}

/** 往当月的历史文件追加一条结论。 */
export function appendHistory(text) {
  const clean = String(text || '').trim()
  if (!clean) throw new Error('内容为空')
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const dir = path.join(sharedDir(), HISTORY_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${ym}.md`)
  if (!fs.existsSync(file)) fs.writeFileSync(file, `# 历史 · ${ym}\n`, 'utf8')
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  fs.appendFileSync(file, `\n## ${stamp}\n\n- ${clean}\n`, 'utf8')
  return { file, stamp }
}

// ------------------------------------------------------------------ 账本

const PEOPLE_FILE = () => path.join(sharedDir(), 'people', 'people.json')

const EMPTY_LEDGER = {
  version: 1,
  global: { affinity: 50, mood: '平静' },
  people: {},
  updatedAt: null,
  links: [],
  habits: [],
  masterKeys: [],
  grudgeThreshold: 30,
  treasures: [],
}

export function loadLedger() {
  const file = PEOPLE_FILE()
  const raw = readText(file)
  if (!raw) return structuredClone(EMPTY_LEDGER)
  try {
    return { ...structuredClone(EMPTY_LEDGER), ...JSON.parse(raw) }
  } catch {
    return structuredClone(EMPTY_LEDGER)
  }
}

/** 保存带重试：Windows 上杀毒/同步进程会短暂占用文件。 */
export function saveLedger(ledger) {
  const file = PEOPLE_FILE()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  ledger.updatedAt = new Date().toISOString()
  const tmp = `${file}.tmp`
  const body = JSON.stringify(ledger, null, 2)
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.writeFileSync(tmp, body, 'utf8')
      fs.renameSync(tmp, file)
      return
    } catch (error) {
      if (i === 4) throw error
      const until = Date.now() + 80
      while (Date.now() < until) { /* tiny backoff */ }
    }
  }
}

export function ensurePerson(ledger, key, name) {
  if (!ledger.people[key]) {
    ledger.people[key] = {
      name: name || key,
      affinity: 50,
      mood: '平静',
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      encounters: 1,
      notes: [],
      moodScore: 50,
      moodAt: new Date().toISOString(),
    }
  }
  const person = ledger.people[key]
  if (name) person.name = name
  person.lastSeen = new Date().toISOString()
  person.encounters = (person.encounters || 0) + 1
  return person
}

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, Number(value) || 0))

/** 情绪半衰：负面 3 小时、正面 8 小时，回落到 50。 */
export function decayScore(score, atIso, now = Date.now()) {
  const base = Number(score)
  if (!Number.isFinite(base)) return 50
  const at = atIso ? Date.parse(atIso) : NaN
  if (!Number.isFinite(at)) return base
  const hours = Math.max(0, (now - at) / 3_600_000)
  const halfLife = base < 50 ? 3 : 8
  const toward = base < 50 ? 50 : 50
  const factor = Math.pow(0.5, hours / halfLife)
  return clamp(toward + (base - toward) * factor, 0, 100)
}

/** 把账本里所有人的 moodScore 按时间衰减一遍。 */
export function decayAll(ledger, now = Date.now()) {
  let changed = 0
  for (const person of Object.values(ledger.people || {})) {
    if (typeof person.moodScore !== 'number') continue
    const next = Math.round(decayScore(person.moodScore, person.moodAt, now))
    if (next !== person.moodScore) {
      person.moodScore = next
      person.moodAt = new Date(now).toISOString()
      changed += 1
    }
  }
  return changed
}

/** 记仇门槛：低于阈值且原因是故意的，就不自然消退。 */
export function isGrudge(ledger, person) {
  if (!person) return false
  const threshold = ledger.grudgeThreshold ?? 30
  return typeof person.moodScore === 'number' && person.moodScore < threshold
}

// ------------------------------------------------------------ 首次启动

const ROOT_TEMPLATE = `# 人工灵魂 · 总目录

> 这套分层记忆统一叫「人工灵魂」：根是这一页，枝在 \`shared/\` 下，索引是 \`shared/索引.md\`。

## 我是谁

- 名字：
- 自称：
- 称呼对方：

## 现在的渠道

| 渠道 | 怎么接的 | 状态 |
| --- | --- | --- |
|  |  |  |

## 铁律

- 不报余额、账户、路径、聊天记录、行踪。
- 不替对方表态；不站队、不骂人、不编事。
- 只有本人能改设定。

## 什么算「记忆」

- 写：闲聊玩笑、明显的情绪、反复出现的偏好、有分量的节点。
- 不写：任务过程、一句话能问清的技术细节、记过的换句话。
- 按人的另算：进 \`shared/people/people.json\`。

## 怎么记

- 定下来的事：往 \`shared/历史/YYYY-MM.md\` 尾巴加一条「日期 + 一句结论」。

## 索引（要用再读）

| 文件 | 里面是什么 | 什么时候读 |
| --- | --- | --- |
| \`shared/索引.md\` | 按「要查什么」分类的总索引 | 每次查东西前 |
| \`shared/people/people.json\` | 按人账本 | 回某个人前 |
`

const INDEX_TEMPLATE = `# 人工灵魂索引（要查什么，去读哪个）

## 一、规则和约定

| 想知道 | 读 |
| --- | --- |
| 总纲 | \`SHARED-STATE.md\`（根页，每轮注入） |
| 具体规矩 | \`shared/规矩/\` 下按主题分 |

## 二、人和关系

| 想知道 | 读 |
| --- | --- |
| 某人的好感、心情、人情、私藏 | \`shared/people/people.json\` |

## 三、历史

| 想知道 | 读 |
| --- | --- |
| 当初怎么定的 | \`shared/历史/YYYY-MM.md\`，按月分 |
`

/**
 * 首次启用时把目录骨架建好（只补缺的，不覆盖已有文件）。
 * 返回 { created: [...], skipped: [...] }。
 */
export function ensureSoulDir({ force = false } = {}) {
  const dir = soulDir()
  const created = []
  const skipped = []
  const writeIfMissing = (file, body) => {
    if (!force && fs.existsSync(file)) {
      skipped.push(path.relative(dir, file).split(path.sep).join('/'))
      return
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body, 'utf8')
    created.push(path.relative(dir, file).split(path.sep).join('/'))
  }

  writeIfMissing(path.join(dir, ROOT_FILE), ROOT_TEMPLATE)
  writeIfMissing(path.join(sharedDir(), '索引.md'), INDEX_TEMPLATE)
  fs.mkdirSync(path.join(sharedDir(), HISTORY_DIR), { recursive: true })

  const peopleFile = PEOPLE_FILE()
  if (!fs.existsSync(peopleFile)) {
    fs.mkdirSync(path.dirname(peopleFile), { recursive: true })
    fs.writeFileSync(peopleFile, JSON.stringify(EMPTY_LEDGER, null, 2), 'utf8')
    created.push(path.relative(dir, peopleFile).split(path.sep).join('/'))
  } else {
    skipped.push(path.relative(dir, peopleFile).split(path.sep).join('/'))
  }

  return { dir, created, skipped }
}

/**
 * 从各渠道插件的 state.json 里读出「会话映射」：谁在哪个 DSH 会话里。
 * 顺序：私聊优先，其次是群。只读，不改任何文件。
 */
export function readMappedSessions() {
  const base = path.join(os.homedir(), '.dsh', 'integrations')
  const out = []
  let channels = []
  try {
    channels = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return out
  }
  for (const channel of channels) {
    const botsDir = path.join(base, channel.name, 'bots')
    let bots = []
    try {
      bots = fs.readdirSync(botsDir, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      continue
    }
    for (const bot of bots) {
      const file = path.join(botsDir, bot.name, 'state.json')
      const raw = readText(file)
      if (!raw) continue
      try {
        const json = JSON.parse(raw)
        for (const [key, sessionId] of Object.entries(json.sessions || {})) {
          if (typeof sessionId !== 'string' || !sessionId.startsWith('session-')) continue
          out.push({ channel: channel.name, key, sessionId, direct: key.startsWith('c2c:') })
        }
      } catch {}
    }
  }
  out.sort((a, b) => Number(b.direct) - Number(a.direct))
  return out
}
