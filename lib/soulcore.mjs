// 人工灵魂核心：根页 / 枝 / 历史 / 落叶检索。
// 纯文件操作，不依赖 DSH 内部 API，方便单独测试。
// 数据目录一律走 home.mjs：默认 ~/.dsh/soul-seed，可用 DSH_SOUL_DIR 改。
// 这里刻意不沿用 lib/shared.mjs 的默认值（那是 ~/.dsh/im）——
// 仓库版不能读、也不能写老工作区；显式设了 DSH_SHARED_DIR / SOUL_HOME 才听它的。
import fs from 'node:fs'
import path from 'node:path'
import { soulHome } from './home.mjs'

export const ROOT_FILE = 'SHARED-STATE.md'
const HISTORY_DIR = '历史'
const SKIP_DIRS = new Set(['向量', 'node_modules'])

/** 共享工作区的根（根页所在的那一层）。 */
export function sharedBase() {
  const env = (process.env.DSH_SHARED_DIR || process.env.SOUL_HOME || '').trim()
  if (env) return path.resolve(env)
  return soulHome()
}

/** 枝所在的那一层，例如 共享工作区/shared。 */
export function sharedRoot() {
  return path.join(sharedBase(), 'shared')
}

export function rootPagePath() {
  return path.join(sharedBase(), ROOT_FILE)
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 根页全文；没有就返回 null（调用方自己决定跳不跳）。 */
export function readRoot() {
  return readText(rootPagePath())
}

/** 根页按字符数截断，给系统提示用；文件不存在返回空串。 */
export function renderRoot(maxChars = 6000) {
  const text = readRoot()
  if (!text) return ''
  const trimmed = text.trim()
  if (!trimmed) return ''
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}\n\n…（根页过长已截断，完整内容在 ${rootPagePath()}）`
}

/** 列出共享工作区里的文件树（相对路径 + 字节数 + 修改时间）。 */
export function listTree(dir = sharedRoot(), depth = 2) {
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
    const rel = path.relative(sharedBase(), full).split(path.sep).join('/')
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
  const base = sharedRoot()
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

/** 往当月的历史文件追加一条结论；文件不存在就先写标题。 */
export function appendHistory(text) {
  const clean = String(text || '').trim()
  if (!clean) throw new Error('内容为空')
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const dir = path.join(sharedRoot(), HISTORY_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${ym}.md`)
  if (!fs.existsSync(file)) fs.writeFileSync(file, `# 历史 · ${ym}\n`, 'utf8')
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  fs.appendFileSync(file, `\n## ${stamp}\n\n- ${clean}\n`, 'utf8')
  return { file, stamp }
}

// ------------------------------------------------------------------ 落叶检索

/** 中英混排的粗切词：英文/数字整词，中文按 2 字滑窗（够用，不引入依赖）。 */
export function queryTokens(query) {
  const text = String(query ?? '').toLowerCase()
  const out = new Set()
  for (const m of text.match(/[a-z0-9_]{2,}/g) || []) out.add(m)
  for (const run of text.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (run.length <= 2) out.add(run)
    else for (let i = 0; i < run.length - 1; i += 1) out.add(run.slice(i, i + 2))
  }
  return [...out]
}

function walkFiles(dir, depth, out) {
  if (depth < 0) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkFiles(full, depth - 1, out)
      continue
    }
    if (/\.(md|txt|markdown|log)$/i.test(entry.name)) out.push(full)
  }
}

/**
 * 轻量本地检索：在共享工作区的文本枝里按关键词打分，回文件 + 片段。
 * 不走向量、不联网、不花钱，够 soul 工具 rag-recall 的「想不起在哪提过」。
 */
export function recallLocal(query, topK = 5) {
  const tokens = queryTokens(query)
  if (!tokens.length) return []
  const files = []
  walkFiles(sharedRoot(), 5, files)
  const hits = []
  for (const file of files) {
    let text
    try {
      const stat = fs.statSync(file)
      if (stat.size > 2 * 1024 * 1024) continue
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lower = text.toLowerCase()
    let score = 0
    let first = -1
    for (const token of tokens) {
      let at = lower.indexOf(token)
      if (at < 0) continue
      if (first < 0 || at < first) first = at
      let count = 0
      while (at >= 0 && count < 50) {
        count += 1
        at = lower.indexOf(token, at + token.length)
      }
      score += count * (token.length >= 2 ? 2 : 1)
    }
    if (!score || first < 0) continue
    const start = Math.max(0, first - 60)
    const end = Math.min(text.length, first + 160)
    const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim()
    hits.push({
      file: path.relative(sharedBase(), file).split(path.sep).join('/'),
      score,
      text: `${start > 0 ? '…' : ''}${snippet}${end < text.length ? '…' : ''}`,
    })
  }
  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
  return hits.slice(0, topK)
}
