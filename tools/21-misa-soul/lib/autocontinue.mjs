/**
 * 自动续跑（从 dsh-auto-continue 0.4.7 搬过来，按咱自己的规矩收紧）。
 *
 * 原理跟上家一样：听 `session/event`，看 `turn/end` 的 reason，
 * 撞上可恢复的失败就隔一两秒用 `agent.followup()` 补一条 continue。
 *
 * 跟上家的区别（2026-11-24 master 让搬的，理由：欠费那晚它自己续了二十轮）：
 *   1. 只续「临时性」失败：限流、空回复、被输出上限截断。
 *   2. 欠费/配额/凭证/上下文超限一律不续 —— 越续越贵，续了也不会好。
 *   3. 上限 2 次（上家默认 20）。
 *   4. 用户自己说一句话就清零。
 *
 * 配置：~/.dsh/misa-auto-continue.json
 *   { "enabled": true, "maxRetries": 2 }
 */
import fsx from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SOURCE_KIND = 'plugin:misa-soul'
const CONFIG_PATH = path.join(os.homedir(), '.dsh', 'misa-auto-continue.json')
const LOG_PATH = path.join(os.homedir(), '.dsh', 'im', 'shared', 'auto-continue.log')

const DEFAULTS = { enabled: true, maxRetries: 2 }

// 可以续：限流（等一下就好）、空回复（模型抽风）
const RETRYABLE_CODES = new Set(['RATE_LIMIT', 'EMPTY_RESPONSE'])
// 被输出上限截断：接着写是合理的
const RETRYABLE_TURN_REASONS = new Set(['max-tokens'])
// 明确不续：欠费/配额/凭证/窗口超限，续一百次也一样
const HARD_STOP_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA', 'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED'])

export function readAutoContinueConfig() {
  try {
    const raw = JSON.parse(fsx.readFileSync(CONFIG_PATH, 'utf8'))
    const n = Number(raw?.maxRetries)
    return {
      enabled: raw?.enabled !== false,
      maxRetries: Number.isInteger(n) && n > 0 ? Math.min(n, 5) : DEFAULTS.maxRetries,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function log(line) {
  try {
    fsx.appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + line + '\n')
  } catch {}
}

function continueMessage(text) {
  return Object.freeze({
    role: 'user',
    id: globalThis.crypto.randomUUID(),
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND },
  })
}

export function startAutoContinue(ctx) {
  ctx.inject(['agents'], (c) => {
    const agents = c.get('agents')
    const state = new Map() // sessionId -> { count, timer }

    const dispose = c.on('session/event', (session, event) => {
      const sessionId = session?.id
      if (!sessionId) return
      const type = event?.type

      // 用户自己开口：清零（咱自己补的那条带 source.kind，认出来跳过）
      if (type === 'user/message') {
        const src = event?.data?.source
        if (src?.kind === SOURCE_KIND) return
        const s = state.get(sessionId)
        if (s?.timer) clearTimeout(s.timer)
        state.delete(sessionId)
        return
      }

      if (type !== 'turn/end') return
      const reason = event?.data?.reason
      if (!reason) {
        state.delete(sessionId)
        return
      }

      const code = reason?.error?.code
      const kind = reason?.kind
      const retryable = RETRYABLE_TURN_REASONS.has(kind) || (kind === 'error' && RETRYABLE_CODES.has(code))
      if (!retryable) {
        if (kind === 'error' && HARD_STOP_CODES.has(code)) {
          const s = state.get(sessionId)
          const n = s?.count ?? 0
          log('stop ' + String(code) + ' after ' + n + ' (session ' + sessionId + ')')
        }
        state.delete(sessionId)
        return
      }

      const settings = readAutoContinueConfig()
      if (!settings.enabled) return

      const s = state.get(sessionId) ?? { count: 0, timer: null }
      state.set(sessionId, s)
      if (s.count >= settings.maxRetries) {
        log('give up after ' + s.count + ' (' + String(code ?? kind) + ', session ' + sessionId + ')')
        return
      }
      s.count += 1
      const delay = 1500 + Math.random() * 1500
      log('continue ' + s.count + '/' + settings.maxRetries + ' in ' + Math.round(delay) + 'ms (' + String(code ?? kind) + ', session ' + sessionId + ')')
      s.timer = setTimeout(() => {
        s.timer = null
        try {
          const agent = agents?.get?.(sessionId)
          if (!agent || typeof agent.followup !== 'function') return
          agent.followup(continueMessage('continue'))
        } catch (e) {
          log('send failed: ' + (e?.message ?? String(e)))
        }
      }, delay)
      if (typeof s.timer?.unref === 'function') s.timer.unref()
    })

    c.effect(() => () => {
      try {
        dispose?.()
      } catch {}
      for (const s of state.values()) if (s?.timer) clearTimeout(s.timer)
      state.clear()
    }, 'dsh-misa-soul: auto continue')
  })
}
