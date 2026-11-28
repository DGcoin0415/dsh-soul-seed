// 接续整理的推送口：把「刚整理完」这条短结论交给 dsh-notify。
//
// 2026-11-27 master 定：优先调 notify 提供的库/服务（同进程，不走子进程）；
// notify 不在、抛错、超时都只记日志，绝不影响接续整理本身。
//
// 两条路：
//   1. notify 服务（dsh-notify 用 ctx.provide('notify') 暴露的 push）→ 立刻投；
//      有最近活跃会话就投回那条会话，投不进就退回微信。
//   2. 服务不在（没装 notify / 还没重启生效）→ 往 notify 的收件箱
//      <工作区>/.notify-outbox/ 丢一个 JSON，插件下一轮轮询会把它推走（走微信兜底）。
import fs from 'node:fs'
import path from 'node:path'

const STATE_FILE = path.join('state', 'notify.json')
const OUTBOX = '.notify-outbox'
const RECENT_MS = 6 * 3600_000

/** 找「最近的活跃会话」：和 dsh-notify 自己那 6 小时窗口一致。 */
export function latestSessionId(home) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(home, STATE_FILE), 'utf8'))
    const now = Date.now()
    const rows = Object.entries(st?.sessions || {})
      .map(([id, v]) => ({ id, at: Number(v?.at) || 0 }))
      .filter((x) => x.at && now - x.at < RECENT_MS)
      .sort((a, b) => b.at - a.at)
    return rows[0]?.id || ''
  } catch {
    return ''
  }
}

/** 往 notify 收件箱丢一条；文件名带时间戳，drain 完会归档到 done/。 */
function writeInbox(home, text) {
  const dir = path.join(home, OUTBOX)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${Date.now()}-continuity-${process.pid}.json`)
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, JSON.stringify({ text, source: 'continuity' }, null, 2), 'utf8')
  fs.renameSync(temp, file)
  return file
}

/**
 * 造一个 push(text) 函数交给 continuity。
 * @param {{home:string, getService?:()=>any, log?:(s:string)=>void}} opts
 */
export function createContinuityPusher({ home, getService = () => null, log = () => {} } = {}) {
  return async function push(text) {
    const body = String(text || '').trim()
    if (!body) return { ok: false, reason: '空内容' }

    let service = null
    try {
      service = getService() || null
    } catch (e) {
      log(`取 notify 服务失败：${e?.message ?? e}`)
    }

    if (service && typeof service.push === 'function') {
      const sessionId = latestSessionId(home)
      let result = await service.push({ source: 'continuity', text: body, sessionId })
      if ((!result || result.ok !== true) && sessionId) {
        // 会话可能已经关了：退回微信兜底再试一次
        result = await service.push({ source: 'continuity', text: body, sessionId: '' })
      }
      if (result && result.ok === true) return result
      log(`notify 服务没推成（${result?.reason || '未知'}），改走收件箱`)
    }

    try {
      const file = writeInbox(home, body)
      log(`已丢进推送收件箱：${path.basename(file)}`)
      return { ok: true, channel: 'inbox' }
    } catch (e) {
      log(`写推送收件箱也失败：${e?.message ?? e}`)
      return { ok: false, reason: String(e?.message ?? e) }
    }
  }
}
