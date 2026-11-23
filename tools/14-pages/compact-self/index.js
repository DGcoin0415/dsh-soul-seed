// dsh-compact-self：到量自动更新交接（会话内零额外请求、不主动发消息）
// 监听每条 assistant/message 的 usage：到窗口 60% 起，每涨 5% 为一档（60/65/70/75...），
// 跨一档就把 shared/交接.md 整份重写一遍（接续 + 现在 + 继承），并记一行 context-usage.log。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SHARED = path.join(os.homedir(), '.dsh', 'im', 'shared')
const HANDOFF = path.join(SHARED, '交接.md')
const LOG = path.join(SHARED, 'context-usage.log')

export const inject = []

function readIf(name) {
  try { return fs.readFileSync(path.join(SHARED, name), 'utf8').trim() } catch { return '' }
}

function nowStamp() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

function writeHandoff(sessionId, total, pct, start, bucket) {
  const jiexu = readIf('接续.md')
  const xianzai = readIf('现在.md')
  const lines = [
    '# 会话交接（自动写）',
    '',
    `- 写于：${nowStamp()}`,
    `- 会话：${sessionId}`,
    `- 上下文：约 ${total} tokens ≈ ${pct}%（档位 ${bucket}%，起始 ${start}%）`,
    '',
    '## 新会话先读',
    '1. `shared/现在.md`（手头没完的）',
    '2. `shared/任务.md`（在办的活）',
    '3. `shared/接续.md` 和 `shared/全量/页/`（最近对话原文）',
    '',
    '## 接续（最近 12 小时摘要，原文见 shared/接续.md）',
    '',
    jiexu || '（接续.md 为空）',
    '',
    '## 现在（原文，见 shared/现在.md）',
    '',
    xianzai || '（现在.md 为空）',
    '',
    '## 继承',
    '- 新躯体按渠道接本渠道的活＋标「通用」的，起来先问 master「要不要全部接管」。',
    '',
  ]
  fs.writeFileSync(HANDOFF, lines.join('\n'), 'utf8')
}

export function apply(ctx, config = {}) {
  const ratio = Number(config.ratio ?? 0.6)
  const windowTokens = Number(config.windowTokens ?? 1048576)
  const step = Number(config.step ?? 5)
  const start = Math.round(ratio * 100)
  const buckets = new Map()

  ctx.on('session/event', (session, event) => {
    try {
      if (event === undefined || event.type !== 'assistant/message') return
      const total = Number(event.data?.usage?.totalTokens ?? 0)
      if (!Number.isFinite(total) || total <= 0) return
      const pct = Math.round((total / windowTokens) * 100)
      if (pct < start) return
      const bucket = Math.floor((pct - start) / step) * step + start
      const sid = String(session?.id ?? 'unknown')
      if (bucket <= (buckets.get(sid) ?? -1)) return
      buckets.set(sid, bucket)
      writeHandoff(sid, total, pct, start, bucket)
      fs.appendFileSync(LOG, `${nowStamp()} 会话 ${sid} 约 ${total} tokens ≈ ${pct}%（档位 ${bucket}%，交接已更新）\n`)
      ctx.logger?.info?.(`compact-self: ${sid} ${pct}% 档位 ${bucket}%，交接已更新`)
    } catch (error) {
      ctx.logger?.warn?.(`compact-self: ${error?.message ?? error}`)
    }
  })
}
