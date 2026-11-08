/**
 * 上下文账：把一轮的输入拆成几块，看看空间被谁吃了。
 *
 * 数据来自会话日志本身，不需要额外调用模型：
 *   - 每轮 usage 里的 inputTokens / cacheRead / output
 *   - 消息块类型（text / reasoning / tool-call / tool-result）
 *   - 折叠块（[save-token #id]）与摘要块（[compacted-summary]）
 *
 * 注意：这里给的是**估算**，不是 tokenizer 实测。口径写清楚，别把估算当精确值。
 */

const EST = { cjk: 1.5, ascii: 0.25 }   // 中文 1 字≈1.5 token，其它 4 字符≈1 token

export function estTokens(text) {
  if (!text) return 0
  const s = String(text)
  let cjk = 0
  for (const ch of s) if (ch >= '\u4e00' && ch <= '\u9fa5') cjk++
  return Math.round(cjk * EST.cjk + (s.length - cjk) * EST.ascii)
}

function blocksOf(rec) {
  const c = rec?.data?.message?.content ?? rec?.data?.content
  return Array.isArray(c) ? c : []
}

function textOf(rec) {
  return blocksOf(rec).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
}

/**
 * @param {object[]} records  会话日志记录
 * @param {{personaChars?: number, memoryChars?: number, peopleChars?: number}} extra 外部文件规模
 */
export function analyze(records, extra = {}) {
  const turns = []
  const folds = []
  const compactions = []

  let cur = null
  for (const r of records) {
    const t = r?.type
    if (t === 'turn/start') {
      cur = { start: r.time, steps: 0, input: 0, cacheRead: 0, output: 0, reasoning: 0 }
      turns.push(cur)
    } else if (t === 'step/start' && cur) {
      cur.steps += 1
    } else if (t === 'assistant/message' && cur) {
      const u = r?.data?.usage || {}
      cur.input += u.inputTokens || 0
      cur.cacheRead += u.cacheReadTokens || 0
      cur.output += u.outputTokens || 0
      cur.reasoning += u.reasoningTokens || 0
      const txt = textOf(r)
      for (const m of txt.matchAll(/\[save-token #([a-z0-9]+)/g)) folds.push({ turn: turns.length, id: m[1] })
      if (txt.includes('[compacted-summary]') || txt.includes('自动生成的对话检查点')) compactions.push({ turn: turns.length })
    } else if (t === 'user/message') {
      const txt = textOf(r)
      if (txt.includes('[compacted-summary]') || txt.includes('自动生成的对话检查点')) compactions.push({ turn: turns.length })
    }
  }

  const now = turns.filter((x) => x.input > 0)
  const avg = now.length ? Math.round(now.reduce((a, x) => a + x.input, 0) / now.length) : 0
  const max = now.reduce((a, x) => Math.max(a, x.input), 0)

  // 外部文件的估算（人格 / 记忆 / 账本）
  const persona = estTokens('x'.repeat(extra.personaChars || 0))
  const memory = Math.round((extra.memoryChars || 0) * EST.cjk)
  const people = Math.round((extra.peopleChars || 0) * EST.cjk)

  return {
    turns: turns.length,
    turnsMeasured: now.length,
    inputAvg: avg,
    inputMax: max,
    output: turns.reduce((a, x) => a + x.output, 0),
    reasoning: turns.reduce((a, x) => a + x.reasoning, 0),
    folds: folds.length,
    compactions: compactions.length,
    compactionTurns: compactions.slice(-5).map((c) => c.turn),
    external: { persona, memory, people },
    note: 'token 数是估算（中文 1.5/字，其它 0.25/字符），不是 tokenizer 实测'
  }
}

/** 渲染成人能读的表。 */
export function render(report) {
  const L = []
  L.push('[上下文账] 共 ' + report.turns + ' 轮，其中有 usage 的 ' + report.turnsMeasured + ' 轮')
  L.push('  每轮输入平均 ' + report.inputAvg.toLocaleString() + ' tok，最大 ' + report.inputMax.toLocaleString() + ' tok')
  L.push('  输出合计 ' + report.output.toLocaleString() + ' tok，其中推理 ' + report.reasoning.toLocaleString() + ' tok')
  L.push('  折叠块（save-token）' + report.folds + ' 个；压缩事件 ' + report.compactions + ' 次' +
    (report.compactionTurns.length ? '（最近发生在第 ' + report.compactionTurns.join('、') + ' 轮）' : ''))
  const e = report.external
  if (e.persona || e.memory || e.people) {
    L.push('  外部注入估算：人格 ~' + e.persona + ' tok · 记忆 ~' + e.memory + ' tok · 账本 ~' + e.people + ' tok')
  }
  L.push('  口径：' + report.note)
  return L.join('\n')
}
