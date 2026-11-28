/**
 * dsh-ctx-alert — 真实上下文占用告警
 *
 * 为什么有它：以前「上下文快满了」是模型自己按根页规矩喊的，喊的数跟界面右下角对不上
 * （界面 35%、模型说 74%）。这里统一用真实 token 占用（优先 tokenMeter.contextPressure，
 * 拿不到就照 context-check.mjs 读会话文件），再数压缩轮次、按轮次+阈值只提醒一次。
 *
 * 规则（master 2026-11-27 定）：
 *   - 一次占用回落 ≥ dropPoints（默认 15 点）算压缩一轮；
 *   - 倒数第二轮（round == maxRounds-1，默认第 2 轮）到 penultRoundPct（70%）告警；
 *   - 最后一轮（round >= maxRounds，默认第 3 轮）到 lastRoundPct（60%）告警；
 *   - 同一轮同一阈值只提醒一次；告警通过 dsh-notify 推回发起会话（在哪问的在哪回）。
 *
 * 配置：<工作区>/.ctx-alert-config.json（默认 <工作区> = ~/.dsh/im）
 * 状态：<工作区>/state/ctx-alert.json；日志 state/ctx-alert.log；历史 shared/历史/<当月>.md
 */
import { workspaceDir, paths, loadConfig } from './lib/config.mjs'
import { measure } from './lib/measure.mjs'
import { createEngine } from './lib/engine.mjs'
import { pushAlert } from './lib/push.mjs'
import { appendLog, readState, shortId } from './lib/store.mjs'

export const name = 'dsh-ctx-alert'

const CFG_TTL_MS = 5000

export function apply(ctx = {}) {
  const workspace = workspaceDir()
  const P = paths(workspace)

  let cfg = loadConfig(workspace)
  cfg._sessionsRoot = P.sessionsRoot
  let cfgAt = Date.now()

  function getCfg() {
    if (Date.now() - cfgAt > CFG_TTL_MS) {
      try {
        cfg = loadConfig(workspace)
        cfg._sessionsRoot = P.sessionsRoot
        cfgAt = Date.now()
      } catch {}
    }
    return cfg
  }

  let agentsRef = null
  try {
    ctx.inject(['agents'], (c) => {
      try {
        agentsRef = c.get('agents') || null
      } catch {}
    })
  } catch {}

  const engine = createEngine({
    P,
    getCfg,
    getAgents: () => agentsRef,
    push: ({ text, sessionId }) =>
      pushAlert({ workspace, inboxDir: P.inbox, agents: agentsRef, text, sessionId }),
  })

  function service(n) {
    try {
      return ctx.get?.(n) || null
    } catch {
      return null
    }
  }

  function warn(msg) {
    try {
      ctx.logger?.warn?.(`dsh-ctx-alert: ${msg}`)
    } catch {}
  }

  /** 算一次并交给引擎；返回引擎结果（selftest / 调试可以 await）。 */
  function evaluate(session, eventUsageTokens) {
    const c = getCfg()
    if (!c.enabled) return Promise.resolve({ skipped: '插件关了' })
    const sid = String(session?.id || '')
    if (!sid) return Promise.resolve({ skipped: '没有会话 id' })
    let m
    try {
      m = measure({
        session,
        meter: service('tokenMeter'),
        projections: service('sessionProjections'),
        eventUsageTokens,
        cfg: c,
      })
    } catch (e) {
      warn(`测量失败：${e?.message || e}`)
      return Promise.resolve({ skipped: `测量失败：${e?.message || e}` })
    }
    if (m.pct == null) {
      appendLog(P.log, `会话 ${shortId(sid)} 读不到真实占用（source=${m.source || '无'}），本轮跳过`)
      return Promise.resolve({ sid, skipped: '读不到占用' })
    }
    const p = engine.sample(sid, m)
    p.catch((e) => warn(`处理失败：${e?.message || e}`))
    return p
  }

  // ---------------------------------------------------------------- 每轮
  // assistant/message 落地后算一次：那时的 usage 就是界面显示的同一套数。
  try {
    ctx.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'assistant/message') return
        const total = Number(event.data?.usage?.totalTokens || 0)
        void evaluate(session, Number.isFinite(total) && total > 0 ? total : undefined)
      } catch (e) {
        warn(`会话事件出错：${e?.message || e}`)
      }
    })
  } catch (e) {
    warn(`挂不上 session/event：${e?.message || e}`)
  }

  // ------------------------------------------------------------ 每分钟兜底
  // 空闲会话不会有 assistant/message，这里按状态里记过的会话再算一遍
  // （窗口、压缩都是别的渠道来的，也可能在别的会话里发生）。
  try {
    ctx.effect(
      () => {
        let busy = false
        const tick = () => {
          if (busy) return
          const c = getCfg()
          if (!c.enabled) return
          const sessions = service('sessions')
          if (!sessions || typeof sessions.get !== 'function') return
          let ids = []
          try {
            const state = readState(P.state)
            const now = Date.now()
            ids = Object.entries(state.sessions || {})
              .filter(([, v]) => now - (Number(v?.updatedAt) || 0) < c.activeHours * 3600_000)
              .map(([id]) => id)
          } catch {
            ids = []
          }
          if (!ids.length) return
          busy = true
          try {
            for (const id of ids.slice(0, 8)) {
              let session = null
              try {
                session = sessions.get(id)
              } catch {}
              if (session) void evaluate(session, undefined)
            }
          } finally {
            busy = false
          }
        }
        const timer = setInterval(tick, Math.max(1, Number(cfg.checkEveryMin) || 1) * 60_000)
        if (timer && typeof timer.unref === 'function') timer.unref()
        return () => clearInterval(timer)
      },
      'dsh-ctx-alert: minute tick',
    )
  } catch (e) {
    warn(`挂不上定时检查：${e?.message || e}`)
  }

  // ------------------------------------------------------- 开机先量一遍老会话
  // 装上的时候会话可能已经在某一轮里了，先按会话文件把轮次和占用补准，别从 0 数起。
  try {
    ctx.inject(['sessions'], (c2) => {
      const sessions = c2.get('sessions')
      if (!sessions || typeof sessions.get !== 'function') return
      const boot = setTimeout(() => {
        try {
          const now = Date.now()
          let ids = []
          try {
            const state = readState(P.state)
            ids = Object.keys(state.sessions || {})
          } catch {}
          try {
            if (!ids.length && typeof sessions.list === 'function') {
              const list = sessions.list()
              ids = (Array.isArray(list) ? list : [])
                .map((s) => String(s?.id || ''))
                .filter(Boolean)
            }
          } catch {}
          for (const id of ids.slice(0, 12)) {
            let session = null
            try {
              session = sessions.get(id)
            } catch {}
            if (!session) continue
            try {
              if (session?.updatedAt && now - Number(session.updatedAt) > 6 * 3600_000) continue
            } catch {}
            void evaluate(session, undefined)
          }
        } catch (e) {
          warn(`开机补量失败：${e?.message || e}`)
        }
      }, 10_000)
      if (boot && typeof boot.unref === 'function') boot.unref()
    })
  } catch (e) {
    warn(`挂不上开机补量：${e?.message || e}`)
  }

  appendLog(
    P.log,
    `插件加载：窗口 ${cfg.windowTokens}，上限 ${cfg.maxRounds} 轮，` +
      `倒数第二轮 ${cfg.penultRoundPct}% / 最后一轮 ${cfg.lastRoundPct}% 起提醒，回落 ${cfg.dropPoints} 点算压缩`,
  )

  return { evaluate, config: () => getCfg(), paths: P }
}

// 自测 / 别处直接算一次用
export { measure }
export const _internals = { paths, loadConfig }
