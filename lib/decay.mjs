// 情绪半衰期：一个心情分会随时间往 50（平静）回落，负面跌得快、正面散得慢。
// 规则跟老插件一致：低于 50 用 3 小时半衰期，高于 50 用 8 小时。
// 纯算术，不读文件，方便单独测。

export const HALF_LIFE_HOURS = { negative: 3, positive: 8 }

const HOUR_MS = 3_600_000
const MID = 50

/** 这个分数走多久的半衰期（小时）。 */
export function halfLifeHours(score) {
  return Number(score) < MID ? HALF_LIFE_HOURS.negative : HALF_LIFE_HOURS.positive
}

/** 按半衰期把 score 从 atIso 衰减到 now；时间读不出来就原样返回。 */
export function decayScore(score, atIso, now = Date.now()) {
  const base = Number(score)
  if (!Number.isFinite(base)) return MID
  const at = atIso ? Date.parse(atIso) : NaN
  if (!Number.isFinite(at)) return base
  const hours = Math.max(0, (now - at) / HOUR_MS)
  const factor = Math.pow(0.5, hours / halfLifeHours(base))
  return Math.min(100, Math.max(0, MID + (base - MID) * factor))
}

/** 取整版：账本里存的是 0-100 的整数分。 */
export function decayRounded(score, atIso, now = Date.now()) {
  return Math.round(decayScore(score, atIso, now))
}

/** 心情分 → 文字标签（跟老账本、工具页的标签对齐）。 */
export function moodLabel(score) {
  const n = Number(score)
  if (!Number.isFinite(n)) return '平静'
  if (n < 20) return '火大 / 难过'
  if (n < 35) return '烦 / 累'
  if (n < 45) return '有点不爽'
  if (n < 55) return '平静'
  if (n < 70) return '不错'
  if (n < 85) return '很高兴'
  return '特别高兴'
}
