/**
 * dsh-ctx-alert · 引擎（index.js 和 selftest.mjs 共用同一套判定）
 *
 * 一次 sample：算轮次 → 更新曲线 → 看要不要告警 → 落状态/历史/日志 → 推送。
 * 串行执行，避免两个会话同时读写同一个状态文件互相覆盖。
 */
import {
  readState,
  atomicWriteJson,
  appendLog,
  appendHistory,
  sessionState,
  pushSample,
  recordAlert,
  shortId,
} from './store.mjs'
import { stepRound, decide, thresholdForRound, composeAlert } from './rounds.mjs'
import { historyFromFile } from './measure.mjs'
import { writeHandoff } from './handoff.mjs'

export function createEngine({ P, getCfg, getAgents, push }) {
  let chain = Promise.resolve()

  function save(state, cfg) {
    state.updatedAt = Date.now()
    return atomicWriteJson(P.state, state)
  }

  /**
   * 第一次见到某个会话时，按会话文件里的占用曲线把「已经压缩过几轮」补准。
   * 不补的话，装插件之前压缩过的会话会从第 0 轮数起，永远等不到倒数第二轮的提醒。
   * 只用会话文件（有缓存），不动别的会话；推不出来就按原样从当前值开始。
   */
  function seedFromHistory(rec, sid, cfg) {
    if (rec.seeded) return 0
    rec.seeded = true
    let pcts = []
    try {
      pcts = historyFromFile(sid, cfg)?.pcts || []
    } catch {
      pcts = []
    }
    if (pcts.length < 2) return 0
    let st = { round: 0, peak: null }
    for (const p of pcts) st = stepRound(st, p, cfg)
    rec.round = st.round
    rec.peak = st.peak
    rec.seededFrom = `history:${pcts.length}`
    appendLog(P.log, `会话 ${shortId(sid)} 按会话文件补量：历史 ${pcts.length} 个样本，峰值 ${st.peak}%，第 ${st.round} 轮`)
    return st.round
  }

  async function run(sessionId, measured) {
    const cfg = getCfg()
    const sid = String(sessionId || 'unknown')
    const out = { sid, round: 0, pct: null, alerted: false, text: '', kind: '', threshold: 0, compressed: false, skipped: '' }

    if (!cfg.enabled) {
      out.skipped = '插件关了'
      return out
    }
    const pct = Number(measured?.pct)
    if (!Number.isFinite(pct)) {
      out.skipped = '读不到占用'
      return out
    }

    const state = readState(P.state)
    const rec = sessionState(state, sid, cfg)
    try {
      seedFromHistory(rec, sid, cfg)
    } catch {}
    const step = stepRound({ round: rec.round, peak: rec.peak }, pct, cfg)
    pushSample(rec, pct, step.round, cfg)
    rec.peak = step.peak

    out.round = step.round
    out.pct = pct
    out.compressed = step.compressed
    // 当前轮次的线（没开火也给出，方便查「为什么没报」）
    out.limit = thresholdForRound(step.round, cfg)?.threshold ?? null
    out.absolutePct = Number(cfg.absolutePct) > 0 ? Number(cfg.absolutePct) : null
    if (step.compressed) {
      appendLog(P.log, `会话 ${shortId(sid)} 占用回落（${rec.recent.at(-2)?.pct ?? '?'}% → ${pct}%），记第 ${step.round} 轮压缩`)
    }

    const pick = decide(step.round, pct, cfg)
    if (!pick) {
      save(state, cfg)
      return out
    }
    out.threshold = pick.threshold
    out.kind = pick.kind
    const key = pick.key
    if (rec.alerts[key]) {
      save(state, cfg)
      out.skipped = pick.kind === 'absolute' ? '绝对线提醒过了' : '这一轮这一档提醒过了'
      return out
    }

    const text = composeAlert({ round: step.round, pct, threshold: pick.threshold, kind: pick.kind, cfg })
    rec.alerts[key] = Date.now()
    const entry = {
      at: Date.now(),
      sid,
      shortSid: shortId(sid),
      round: step.round,
      pct,
      threshold: pick.threshold,
      kind: pick.kind,
      source: String(measured?.source || ''),
      tokens: Number(measured?.tokens) || 0,
      window: Number(measured?.window) || 0,
      text,
      pushed: false,
      channel: '',
    }
    recordAlert(state, entry, cfg)
    save(state, cfg) // 先落状态，推送失败也不会重复提醒

    out.alerted = true
    out.text = text

    // 到 70%（第 0 轮那条线）顺手写交接：只补一行，幂等，不调模型
    let handoff = null
    if (cfg.writeHandoff && pick.kind === 'penult' && step.round === 0) {
      try {
        // 行里写的是「这条线」（70%），不是实测的 71% —— 按 master 要的原文
        handoff = writeHandoff({ file: P.handoff, sessionId: sid, pct: pick.threshold, at: entry.at })
        out.handoff = handoff
        appendLog(
          P.log,
          handoff.ok
            ? `已写交接${handoff.added ? '' : `（${handoff.reason}，没重复写）`}：会话 ${entry.shortSid} ${pct}%`
            : `写交接失败：${handoff.reason}`,
        )
      } catch (e) {
        appendLog(P.log, `写交接出错（不影响告警）：${String(e?.message || e)}`)
      }
    }

    let r = { ok: false, channel: '', reason: '' }
    try {
      r = await push({ text, sessionId: String(cfg.pushSession || '').trim() || sid })
    } catch (e) {
      r = { ok: false, channel: '', reason: String(e?.message || e) }
    }

    const state2 = readState(P.state)
    const row = Array.isArray(state2.alerts) ? state2.alerts.find((a) => a.at === entry.at && a.sid === sid) : null
    if (row) {
      row.pushed = !!r.ok
      row.channel = String(r.channel || '')
      row.reason = String(r.reason || '')
    }
    // 写交接的结果也落状态（同一会话同一轮只写一次）
    if (handoff) {
      const rec2 = state2.sessions?.[sid]
      if (rec2) {
        if (!rec2.handoffs || typeof rec2.handoffs !== 'object') rec2.handoffs = {}
        rec2.handoffs[key] = { at: entry.at, ok: !!handoff.ok, added: !!handoff.added, reason: String(handoff.reason || '') }
      }
    }
    save(state2, cfg)

    const stamp = new Date(entry.at)
    const kindLabel = pick.kind === 'absolute' ? '绝对线' : pick.kind === 'last' ? '最后一轮' : '倒数第二轮'
    const historyLine =
      `${beijingStampLocal(stamp)}：上下文告警（${kindLabel}）——会话 ${entry.shortSid}，第 ${step.round} 轮（上限 ${cfg.maxRounds}），` +
      `真实占用 ${pct}%，阈值 ${pick.threshold}%；${r.ok ? `已推回原会话（${r.channel}）` : `没推出去：${r.reason}`}` +
      `${handoff?.added ? '；已顺手在 shared/交接.md 补一行' : ''}。`
    if (cfg.writeHistory) appendHistory(P.history, historyLine, entry.at)
    appendLog(
      P.log,
      `告警（${kindLabel}）：会话 ${entry.shortSid} 第 ${step.round} 轮 ${pct}% ≥ ${pick.threshold}%，${r.ok ? '已推送' : '推送失败：' + r.reason}`,
    )
    return out
  }

  return {
    sample(sessionId, measured) {
      const p = chain.then(() => run(sessionId, measured)).catch((e) => ({
        sid: String(sessionId || ''),
        alerted: false,
        skipped: `出错：${e?.message || e}`,
      }))
      chain = p.then(() => undefined)
      return p
    },
  }
}

function beijingStampLocal(ms) {
  const d = new Date(ms + 8 * 3600_000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}
