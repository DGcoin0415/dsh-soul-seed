/**
 * dsh-notify · 来源
 *
 * 1) yuyu   鱼世界：GET /v1/notify?cursor= 拿新事件（游标天然防重复）
 * 2) inbox  收件箱：<工作区>/.notify-outbox/ 下的 JSON，谁都能丢一条，插件负责推走并归档
 *           JSON: {"text":"...", "source":"job|subagent|schedule|...", "session":"可选会话id"}
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJson, clip } from './util.mjs'

const API_BASE = 'https://api.yuyuworld.app'
const TIMEOUT = 10_000

/** 从工作区 fw.env 读 FW_KEY（不打印）。 */
export function readFwKey(envFiles = []) {
  if (process.env.FW_KEY && String(process.env.FW_KEY).trim()) return String(process.env.FW_KEY).trim()
  for (const file of envFiles) {
    try {
      if (!fs.existsSync(file)) continue
      const text = fs.readFileSync(file, 'utf8')
      const m = /(?:^|\n)\s*FW_KEY\s*=\s*(.+?)\s*(?:\r?\n|$)/.exec(text)
      const val = m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
      if (val) return val
    } catch {}
  }
  return ''
}

/**
 * 拉一次鱼世界通知。
 * @returns {Promise<{cursor:string, items:{kind:string,time:string,text:string}[]}>}
 */
export async function pollYuyu({ cursor = '', envFiles = [] } = {}) {
  const key = readFwKey(envFiles)
  if (!key) throw new Error('找不到 FW_KEY')
  const url = `${API_BASE}/v1/notify?cursor=${encodeURIComponent(cursor || '')}`
  let res
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT),
    })
  } catch (e) {
    throw new Error(`连不上鱼的世界：${e?.message || e}`)
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) throw new Error(`鱼的世界 HTTP ${res.status}`)
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('鱼的世界返回的不是 JSON')
  }
  const items = (Array.isArray(data?.items) ? data.items : [])
    .map((x) => ({
      kind: String(x?.kind || 'event'),
      time: String(x?.time || ''),
      text: String(x?.text || '').trim(),
    }))
    .filter((x) => x.text)
  return { cursor: String(data?.cursor || cursor || ''), items }
}

/**
 * 取走收件箱里的文件。文件读完就挪到 done/，所以不会重复推。
 * @returns {Array<{key:string, file:string, text:string, source:string, session:string}>}
 */
export function drainInbox(outbox) {
  const done = path.join(outbox, 'done')
  let names = []
  try {
    names = fs.readdirSync(outbox).filter((n) => n.endsWith('.json') && fs.statSync(path.join(outbox, n)).isFile())
  } catch {
    return []
  }
  const out = []
  for (const name of names.sort()) {
    const file = path.join(outbox, name)
    const raw = readJson(file, null)
    const text = clip(raw?.text ?? '', 2000)
    try {
      fs.mkdirSync(done, { recursive: true })
      fs.renameSync(file, path.join(done, name))
    } catch {}
    if (!text) continue
    out.push({
      key: `inbox:${name}`,
      file,
      text,
      source: String(raw?.source || 'inbox'),
      session: String(raw?.session || ''),
    })
  }
  return out
}
