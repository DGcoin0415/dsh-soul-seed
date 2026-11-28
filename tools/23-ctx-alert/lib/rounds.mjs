/**
 * dsh-ctx-alert · 轮次与阈值（纯函数，好测）
 *
 * 规则（master 2026-11-27 按历史数据改，见 bench/ctx-rounds/report.md）：
 *   - 占用一次回落 ≥ dropPoints（默认 15 点）算压缩了一轮，round +1，peak 重置为当前值；
 *   - 绝对线（不看轮次）：占用 ≥ absolutePct（默认 72%）就告警 —— 补「压不动、直接撞死」那个洞
 *     （70% 以上压缩 0% 成功，12 条撞墙会话死在第 0 轮，轮次根本不动）；
 *   - 最后一轮（round >= maxRounds，默认 1）到 lastRoundPct（默认 60%）告警：换新会话；
 *   - 倒数第二轮（round == maxRounds-1，默认第 0 轮）到 penultRoundPct（默认 70%）告警：别再扛重活；
 *   - 同一轮同一阈值（同一个 key）只告警一次。
 */

/** 当前轮次对应的告警阈值；不该告警的轮次返回 null。 */
export function thresholdForRound(round, cfg) {
  const r = Number(round) || 0
  const maxRounds = Math.max(1, Number(cfg?.maxRounds) || 1)
  if (r >= maxRounds) return { threshold: Number(cfg?.lastRoundPct ?? 60), kind: 'last' }
  if (r === maxRounds - 1) return { threshold: Number(cfg?.penultRoundPct ?? 70), kind: 'penult' }
  return null
}

/** 去重键：同一轮同一阈值只提醒一次；绝对线单独一个键。 */
export function alertKey(round, threshold, kind = '') {
  if (kind === 'absolute') return `abs:${Math.round(Number(threshold) || 0)}`
  return `${Math.round(Number(round) || 0)}:${Math.round(Number(threshold) || 0)}`
}

/**
 * 这一条样本要不要告警：先看绝对线，再看轮次线。
 * @returns {{kind:'absolute'|'penult'|'last', threshold:number, key:string}|null}
 */
export function decide(round, pct, cfg) {
  const p = Number(pct)
  if (!Number.isFinite(p)) return null
  const absolutePct = Number(cfg?.absolutePct)
  if (Number.isFinite(absolutePct) && absolutePct > 0 && p >= absolutePct) {
    return { kind: 'absolute', threshold: absolutePct, key: alertKey(0, absolutePct, 'absolute') }
  }
  const th = thresholdForRound(round, cfg)
  if (!th) return null
  if (p < th.threshold) return null
  return { kind: th.kind, threshold: th.threshold, key: alertKey(round, th.threshold) }
}

/**
 * 推进一个会话的占用曲线。
 * @param {{round:number, peak:number|null}} prev
 * @param {number} pct 真实百分比
 * @param {object} cfg
 * @returns {{round:number, peak:number, compressed:boolean}}
 */
export function stepRound(prev, pct, cfg) {
  const p = Number(pct)
  if (!Number.isFinite(p)) {
    return { round: Number(prev?.round) || 0, peak: Number(prev?.peak) || 0, compressed: false }
  }
  const dropPoints = Math.max(1, Number(cfg?.dropPoints) || 15)
  const prevPeak = prev?.peak == null ? null : Number(prev.peak)
  const prevRound = Math.max(0, Math.round(Number(prev?.round) || 0))
  if (prevPeak == null || !Number.isFinite(prevPeak)) {
    return { round: prevRound, peak: p, compressed: false }
  }
  if (p <= prevPeak - dropPoints) {
    return { round: prevRound + 1, peak: p, compressed: true }
  }
  return { round: prevRound, peak: Math.max(prevPeak, p), compressed: false }
}

/** 告警文案（简短，带第几轮 / 百分比 / 该干什么）。 */
export function composeAlert({ round, pct, threshold, kind, cfg }) {
  const p = Math.round((Number(pct) || 0) * 10) / 10
  const r = Math.max(0, Math.round(Number(round) || 0))
  if (kind === 'absolute') {
    return `⚠ 上下文 ${p}%（第${r}轮）：过了 ${Math.round(threshold)}% 就压不动了，停手——写完交接马上换会话。`
  }
  if (kind === 'last') {
    return `⚠ 上下文 ${p}%（第${r}轮，已压过 ${r} 次）：换条新会话接着干，这条之后只记东西、不接新活。`
  }
  return `⚠ 上下文 ${p}%（第${r}轮，还没压过）：别再扛重活，能派的派出去、长活丢后台。`
}
