/**
 * 自带的人设卡（不依赖外头 dsh-companion 的注入）。
 *
 * 配置：~/.dsh/im/shared/人设卡配置.json
 *   { "card": "card-mvqnzinf" }     ← 载入哪张
 *   { "card": null }                ← 不载入
 *   文件不存在 = 第一次装，需要问 master 载入哪张
 *
 * 卡本体：~/.dsh/persona-cards/<id>.json
 *   { id, name, systemPrompt, trigger, assets }
 */
import fsx from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const CARD_DIR = path.join(os.homedir(), '.dsh', 'persona-cards')

export function configPath(soulDir) {
  return path.join(soulDir, '人设卡配置.json')
}

/** 读出配置；文件不存在返回 null（= 还没选过）。 */
export function readConfig(soulDir) {
  const p = configPath(soulDir)
  try {
    const raw = JSON.parse(fsx.readFileSync(p, 'utf8'))
    return { card: typeof raw?.card === 'string' && raw.card.trim() ? raw.card.trim() : null }
  } catch {
    return null
  }
}

export function writeConfig(soulDir, cardId) {
  const p = configPath(soulDir)
  const body = JSON.stringify({ card: cardId ?? null }, null, 2) + '\n'
  fsx.writeFileSync(p, body, 'utf8')
}

/** 列出可载入的卡（跳过 .bak 之类）。 */
export function listCards() {
  let names = []
  try {
    names = fsx.readdirSync(CARD_DIR).filter((n) => n.endsWith('.json') && !n.includes('.bak'))
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    try {
      const c = JSON.parse(fsx.readFileSync(path.join(CARD_DIR, n), 'utf8'))
      if (!c || typeof c !== 'object') continue
      if (typeof c.systemPrompt !== 'string' || !c.systemPrompt.trim()) continue
      out.push({
        id: String(c.id || n.replace(/\.json$/, '')),
        name: String(c.name || c.id || n),
        promptChars: typeof c.systemPrompt === 'string' ? c.systemPrompt.length : 0,
      })
    } catch {}
  }
  return out
}

/** 读某张卡的正文；找不到返回 null。 */
export function loadCard(cardId) {
  if (!cardId) return null
  const file = path.join(CARD_DIR, cardId + '.json')
  try {
    const c = JSON.parse(fsx.readFileSync(file, 'utf8'))
    if (!c || typeof c.systemPrompt !== 'string' || !c.systemPrompt.trim()) return null
    return {
      id: String(c.id || cardId),
      name: String(c.name || cardId),
      systemPrompt: c.systemPrompt.trim(),
      trigger: typeof c.trigger === 'string' ? c.trigger.trim() : '',
    }
  } catch {
    return null
  }
}

/** 人设卡的情感记忆：~/.dsh/persona-cards/memories/<cardId>.json */
export function readMemory(cardId) {
  if (!cardId) return null
  const file = path.join(CARD_DIR, 'memories', cardId + '.json')
  try {
    const m = JSON.parse(fsx.readFileSync(file, 'utf8'))
    if (!m || typeof m !== 'object') return null
    return {
      affinity: Number.isFinite(m.affinity) ? m.affinity : null,
      mood: typeof m.mood === 'string' ? m.mood.trim() : '',
      chapters: Array.isArray(m.chapters) ? m.chapters : [],
    }
  } catch {
    return null
  }
}

export function renderMemory(mem) {
  if (!mem) return ''
  const lines = []
  if (mem.affinity !== null) lines.push(`- 好感度（角色内部刻度，不是对真实关系的度量）：${mem.affinity}/100`)
  if (mem.mood) lines.push(`- 最近的心情：${mem.mood}`)
  const ch = mem.chapters.slice(-10)
  if (ch.length) {
    lines.push('')
    lines.push('### 记得的事（从旧到新）')
    for (const c of ch) {
      const at = String(c.at || '').slice(0, 10)
      const kind = c.kind ? `【${c.kind}】` : ''
      const s = String(c.summary || '').slice(0, 200)
      if (!s) continue
      const when = String(c.when || '').slice(0, 120)
      lines.push(`- ${at}${kind}${s}${when ? `（当时：${when}）` : ''}`)
    }
  }
  if (!lines.length) return ''
  return ['## 人与人的记忆', '', ...lines].join('\n')
}