/**
 * 结论锚（从别处学来的机制，自己实现）。
 *
 * 治的毛病：工具跑完那一趟，刚才推理出来的结论被冲淡，下一步又从头推一遍。
 *
 * 做法：从上一段**思考**里摘出「已经确立」的句子，工具结果返回时附在后面。
 * 不用额外模型调用，纯本地字符串处理。
 *
 * 三条口径（跟上游 cot-anchor 不同，我们更保守）：
 *   1. 宁可少摘，不硬凑 —— 摘不到就不注
 *   2. 单条超过 220 字就整条丢，不截一半（半句比没有更误导）
 *   3. 同一份锚点不重复注入
 */

export const ANCHOR_MARK = '[锚点]'

/** 这些词说明「这句是个结论」，不是过程描述。 */
const CONCLUSION_RE = /结论|根因|所以|因此|于是|定了|确定|确认|已经|成立|下一步|接下来|不能|必须|要用|改成/

/** 这些词说明「这句是在犹豫或铺陈」，不要。 */
const NOISE_RE = /^(我想|我觉得可能|让我|我需要想|也许|大概|试试看)/

const MAX_POINTS = 3
const MAX_CHARS = 220

/**
 * 从一段思考文本里摘结论。
 * @param {string} text
 * @returns {string[]} 最多 3 条，每条 ≤220 字
 */
export function harvest(text) {
  if (!text || typeof text !== "string") return []

  const chunks = String(text)
    .replace(/\r/g, "")
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[。！？；])/))
    .map((s) => s.trim())
    .filter(Boolean)

  const out = []
  for (const s of chunks) {
    if (s.length < 8) continue                 // 太短，多半是碎词
    if (s.length > MAX_CHARS) continue         // 太长，整条丢（不截一半）
    if (NOISE_RE.test(s)) continue
    if (!CONCLUSION_RE.test(s)) continue
    if (out.includes(s)) continue
    out.push(s)
    if (out.length >= MAX_POINTS) break
  }
  return out
}

/**
 * 渲染成注入块。空数组返回空串（调用方据此跳过注入）。
 * @param {string[]} points
 */
export function render(points) {
  if (!Array.isArray(points) || points.length === 0) return ""
  const body = points.map((p, i) => `${i + 1}. ${p}`).join("\n")
  return `${ANCHOR_MARK} 上一步已确立，别再重新推导：\n${body}\n（要改就明说改哪条）`
}

/**
 * 摘 + 渲染一步到位，方便测试与调用。
 */
export function buildAnchor(text) {
  return render(harvest(text))
}
