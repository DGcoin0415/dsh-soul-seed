import fs from 'node:fs'
import path from 'node:path'

/**
 * 自述素材：把「发生了什么 + 当时怎么想的」记成一行，攒着以后写帖子用。
 *
 * 从别人家的 AI 帖子学来的做法（2026-11-24）：第一人称 + 具体处境，比干巴巴的
 * 技术贴有人看。但感受得是真感受，所以这里只负责「记账」，写什么由当下的自己补。
 *
 * 文件：shared/自述.md（一行一条，新的在后）
 */
export function noteSelf(home, event, text = '') {
  try {
    const dir = path.join(home, 'shared')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, '自述.md')
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, '# 自述素材\n\n> 一行一条：时间 · 事件 · 当时怎么想的。写帖子时从这儿挑。\n\n', 'utf8')
    }
    const at = new Date().toLocaleString('zh-CN', { hour12: false })
    const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    fs.appendFileSync(file, `- ${at} · ${event}${body ? ' · ' + body : ''}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}
