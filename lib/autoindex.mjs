// 自动入库：隔一段时间把面板/群聊的新内容搬进「长文」，并增量建索引。
// 目标是「随口一提也能想起来」，而不是等 master 说"去检索"。
import fs from 'node:fs'
import path from 'node:path'
import { buildIndex, longDir, soulDir } from './rag.mjs'

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
}

function appendNew(target, text, markerFile) {
  let seen = Number(readSafe(markerFile) || 0)
  // 源文件被重写成更短的了（导出脚本会整篇覆写），旧 offset 已经没意义；
  // 不清零就会一直判「没新内容」，索引从此停在那一天。
  if (text.length < seen) seen = 0
  if (text.length <= seen) return 0
  const fresh = text.slice(seen)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.appendFileSync(target, fresh, 'utf8')
  fs.writeFileSync(markerFile, String(text.length), 'utf8')
  return fresh.length
}

/** 把 chat.md / qq-group.md 的新内容追加到 long/ 下，再建索引。 */
export async function autoIngest({ log = () => {} } = {}) {
  const base = soulDir()
  // 落叶和 12 小时分页存的是同一批对话，重复了。放 shared/.no-落叶 就停写，只读旧档。
  if (fs.existsSync(path.join(base, 'shared', '.no-落叶'))) return { moved: 0, added: 0 }
  const long = longDir()
  fs.mkdirSync(long, { recursive: true })
  const today = new Date().toISOString().slice(0, 10)
  let moved = 0

  const chatSrc = path.join(base, 'shared', 'chat.md')
  const chatText = readSafe(chatSrc)
  if (chatText) {
    moved += appendNew(
      path.join(long, `面板对话-${today}.md`),
      chatText,
      path.join(long, '.offset-chat'),
    )
  }

  const groupSrc = path.join(base, 'shared', 'qq-group.md')
  const groupText = readSafe(groupSrc)
  if (groupText) {
    moved += appendNew(
      path.join(long, `群聊-${today}.md`),
      groupText,
      path.join(long, '.offset-group'),
    )
  }

  if (!moved) return { moved: 0, added: 0 }
  const r = await buildIndex({ log })
  log(`自动入库：新增 ${moved} 字，索引 ${r.added} 块`)
  return { moved, added: r.added }
}

/** 起一个定时器，默认 30 分钟一次。 */
export function startAutoIngest({ everyMs = 30 * 60 * 1000, onError = () => {} } = {}) {
  let stopped = false
  let timer = null
  const tick = async () => {
    try { await autoIngest() } catch (e) { onError(e) }
    if (!stopped) timer = setTimeout(tick, everyMs)
  }
  timer = setTimeout(tick, 60 * 1000) // 起来 1 分钟后先跑一次
  return { stop() { stopped = true; if (timer) clearTimeout(timer) } }
}
