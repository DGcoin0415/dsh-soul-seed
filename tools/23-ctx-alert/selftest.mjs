/**
 * dsh-ctx-alert · 自测（不需要 DSH 跑着）
 *
 *   node selftest.mjs [--sessions <目录>]
 *
 * 三部分：
 *   1. 真实占用：照 context-check.mjs 的逻辑读会话文件，打印当前会话（DSH_SESSION_ID）真实百分比；
 *   2. 判定逻辑：轮次 / 阈值 / 去重，纯函数 + 引擎（临时工作区，假推送）；
 *   3. 落账：状态文件和 shared/历史/<当月>.md 真的写出来了。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { paths as cfgPaths, normalize, DEFAULTS } from './lib/config.mjs'
import { measure, findSessionFile, scanSessionFile } from './lib/measure.mjs'
import { createEngine } from './lib/engine.mjs'
import { readState } from './lib/store.mjs'
import { thresholdForRound, stepRound, decide, alertKey } from './lib/rounds.mjs'
import { writeHandoff, findSection } from './lib/handoff.mjs'

let fails = 0
let passes = 0
function check(name, cond, extra = '') {
  if (cond) {
    passes++
    console.log(`  ok   ${name}${extra ? ` — ${extra}` : ''}`)
  } else {
    fails++
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

// ---------------------------------------------------------------- 1. 真实占用
console.log('【1】真实占用（会话文件，同 context-check.mjs）')
const sessionsRoot = (() => {
  const i = process.argv.indexOf('--sessions')
  if (i > 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1])
  return path.join(os.homedir(), '.dsh', 'sessions')
})()
const cfg = normalize({ ...DEFAULTS, windowTokens: 1048576 })
cfg._sessionsRoot = sessionsRoot

function pctOfSession(sid) {
  const fake = { id: sid }
  return measure({ session: fake, meter: null, projections: null, cfg })
}

const currentId = String(process.env.DSH_SESSION_ID || '').trim()
const targets = []
if (currentId) targets.push({ id: currentId, label: '当前会话（DSH_SESSION_ID）' })
// 再挑最近动过的 3 个会话做个对照
try {
  const rows = []
  for (const d of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const sub = path.join(sessionsRoot, d.name)
    for (const s of fs.readdirSync(sub, { withFileTypes: true })) {
      if (!s.isDirectory()) continue
      const f = path.join(sub, s.name, 'session.v4.jsonl.zstd')
      try {
        const st = fs.statSync(f)
        rows.push({ id: s.name.replace(/^session-/, ''), file: f, m: st.mtimeMs })
      } catch {}
    }
  }
  rows.sort((a, b) => b.m - a.m)
  for (const r of rows.slice(0, 3)) {
    if (!targets.some((t) => t.id === r.id)) targets.push({ id: r.id, label: '最近会话' })
  }
} catch {}

if (!targets.length) {
  check('当前会话可读', false, '没拿到 DSH_SESSION_ID，也没扫到会话文件')
} else {
  for (const t of targets) {
    const file = findSessionFile(sessionsRoot, t.id)
    if (!file) {
      check(`${t.label} ${t.id.slice(0, 8)} 文件`, false, '找不到 session.v4.jsonl.zstd')
      continue
    }
    const m = pctOfSession(t.id)
    const raw = scanSessionFile(file)
    check(
      `${t.label} ${t.id.slice(0, 8)} 读到真实占用`,
      m.pct != null,
      m.pct == null
        ? '读不到 usage.totalTokens'
        : `${m.pct}%（${m.tokens} / ${m.window} tokens，source=${m.source}，文件里 window=${raw.window || '-'}）`,
    )
  }
}

// ------------------------------------------------------------ 2. 判定逻辑
console.log('\n【2】轮次 / 阈值 / 绝对线 / 去重')
const CD = normalize({}) // 线上默认：maxRounds=1, penult=70, last=60, absolute=72
check('默认 maxRounds=1', CD.maxRounds === 1)
check('默认 penult=70 / last=60 / absolute=72', CD.penultRoundPct === 70 && CD.lastRoundPct === 60 && CD.absolutePct === 72)
check('默认：第0轮=倒数第二轮（70）', thresholdForRound(0, CD)?.threshold === 70 && thresholdForRound(0, CD)?.kind === 'penult')
check('默认：第1轮=最后一轮（60）', thresholdForRound(1, CD)?.threshold === 60 && thresholdForRound(1, CD)?.kind === 'last')
check('默认：第5轮还按最后一轮算', thresholdForRound(5, CD)?.threshold === 60)

const C3 = normalize({ maxRounds: 3 })
check('maxRounds=3 第0轮不告警（老配置也能跑）', thresholdForRound(0, C3) === null)
check('maxRounds=3 第1轮不告警', thresholdForRound(1, C3) === null)
check('maxRounds=3 第2轮=倒数第二轮（70）', thresholdForRound(2, C3)?.threshold === 70 && thresholdForRound(2, C3)?.kind === 'penult')
check('maxRounds=3 第3轮=最后一轮（60）', thresholdForRound(3, C3)?.threshold === 60)
const C5 = normalize({ maxRounds: 5 })
check('maxRounds=5 第4轮是倒数第二轮（70）', thresholdForRound(4, C5)?.threshold === 70)
check('maxRounds=5 第5轮是最后一轮（60）', thresholdForRound(5, C5)?.threshold === 60)

// 绝对线：不看轮次
check('绝对线：71.9% 还是轮次线（penult 70）', decide(0, 71.9, CD)?.kind === 'penult')
check('绝对线：72% 就升级成绝对线', decide(0, 72, CD)?.kind === 'absolute' && decide(0, 72, CD)?.threshold === 72)
check('绝对线：第3轮 73% 也报（不看轮次）', decide(3, 73, CD)?.kind === 'absolute')
check('绝对线：第9轮 75.6% 还报', decide(9, 75.6, CD)?.kind === 'absolute')
check('绝对线绝对键跟轮次键不冲突', alertKey(0, 72, 'absolute') === 'abs:72' && alertKey(0, 70) === '0:70')
// 轮次线不管的轮次（maxRounds=3 的第 0/1 轮），绝对线照样兜住 —— 这就是它的用处
check(
  'maxRounds=3 时第0轮本来不告警，但 72% 靠绝对线兜住',
  decide(0, 71, C3) === null && decide(0, 72, C3)?.kind === 'absolute',
  `71%=${JSON.stringify(decide(0, 71, C3))} 72%=${JSON.stringify(decide(0, 72, C3))}`,
)
check('绝对线可以关（absolutePct=0）', decide(0, 90, normalize({ absolutePct: 0 }))?.kind === 'penult')
check('关掉绝对线后 60% 不报', decide(0, 60, normalize({ absolutePct: 0 })) === null)

// 轮次线
check('第0轮 69.9% 不报', decide(0, 69.9, CD) === null)
check('第0轮 70% 报倒数第二轮', decide(0, 70, CD)?.kind === 'penult')
check('第1轮 59% 不报', decide(1, 59, CD) === null)
check('第1轮 60% 报换会话', decide(1, 60, CD)?.kind === 'last')

let st = stepRound({ round: 0, peak: 71 }, 20, CD)
check('回落 51 点算压缩 +1 轮', st.compressed && st.round === 1 && st.peak === 20)
st = stepRound({ round: 1, peak: 60 }, 48, CD)
check('回落 12 点（< 15）不算压缩', !st.compressed && st.round === 1 && st.peak === 60)
st = stepRound({ round: 1, peak: 60 }, 44, CD)
check('回落 16 点（≥ 15）算压缩', st.compressed && st.round === 2 && st.peak === 44)
st = stepRound({ round: 0, peak: 40 }, 55, CD)
check('往上涨只更新峰值', !st.compressed && st.round === 0 && st.peak === 55)
check('去重键区分轮次和阈值', alertKey(1, 60) !== alertKey(2, 60) && alertKey(1, 60) === alertKey(1, 60))

// -------------------------------------------------------------- 2b. 引擎
console.log('\n【2b】引擎跑一条占用曲线（假推送，临时工作区）')
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-alert-selftest-'))
const P = cfgPaths(tmpWs)
fs.mkdirSync(path.join(tmpWs, 'shared', '历史'), { recursive: true })
const pushed = []
const engine = createEngine({
  P,
  getCfg: () => CD,
  getAgents: () => null,
  push: async ({ text, sessionId }) => {
    pushed.push({ text, sessionId })
    return { ok: true, channel: '会话（自测假推）', reason: '' }
  },
})

const curve = [
  [10, 0],
  [30, 0],
  [50, 0],
  [69.5, 0],
  [70.2, 0],
  [72.5, 0],
  [75, 0],
  [22, 1],
  [50, 1],
  [61, 1],
  [63, 1],
]
const results = []
for (const [pct, expectRound] of curve) {
  const r = await engine.sample('11111111-2222-3333-4444-555555555555', {
    pct,
    tokens: Math.round((pct / 100) * 1048576),
    window: 1048576,
    source: 'selftest',
  })
  results.push({ pct, expectRound, round: r.round, alerted: !!r.alerted, kind: r.kind, skipped: r.skipped })
}
for (const r of results) {
  check(`曲线 ${String(r.pct).padStart(5)}% 记第 ${r.expectRound} 轮`, r.round === r.expectRound, `实际第 ${r.round} 轮${r.skipped ? `（${r.skipped}）` : ''}`)
}
const alerts = pushed.map((p) => p.text)
check(
  '一共只提醒 3 次（70% 轮次线、72% 绝对线、61% 换会话）',
  alerts.length === 3,
  `实际 ${alerts.length} 次：${alerts.map((t) => t.slice(0, 24)).join(' | ')}`,
)
check('第一次是「还没压过，别再扛重活」', /还没压过/.test(alerts[0] || '') && /别再扛重活/.test(alerts[0] || ''), alerts[0])
check('第二次是绝对线「压不动了」', /压不动/.test(alerts[1] || '') && /停手/.test(alerts[1] || ''), alerts[1])
check('第三次是「已压过，换新会话」', /已压过/.test(alerts[2] || '') && /换条新会话/.test(alerts[2] || ''), alerts[2])
check('72.5% 之后 75% 没有重复报绝对线', results.filter((r) => r.pct === 75).every((r) => !r.alerted))
check('63% 那次没有重复提醒', results.filter((r) => r.pct === 63).every((r) => !r.alerted))

// ---------------------------------------------------------------- 3. 落账
console.log('\n【3】状态 / 历史是否真落盘')
const state = readState(P.state)
const rec = state.sessions['11111111-2222-3333-4444-555555555555']
check('状态文件写了', fs.existsSync(P.state))
check('会话记了 1 轮压缩', rec?.round === 1, `round=${rec?.round}`)
check('状态里有 3 条告警记录', (state.alerts || []).length === 3, `${(state.alerts || []).length} 条`)
check('三种告警类型都记下了', new Set((state.alerts || []).map((a) => a.kind)).size === 3, (state.alerts || []).map((a) => a.kind).join(','))
const histDir = path.join(tmpWs, 'shared', '历史')
const histFiles = fs.existsSync(histDir) ? fs.readdirSync(histDir) : []
const histText = histFiles.length ? fs.readFileSync(path.join(histDir, histFiles[0]), 'utf8') : ''
check('历史页追加了告警', /上下文告警/.test(histText), `${histFiles.join(',') || '没文件'}`)
check('历史页标了告警类型', /绝对线|最后一轮|倒数第二轮/.test(histText), '')
check('日志写了', fs.existsSync(P.log) && fs.statSync(P.log).size > 0)
check('回落日志记了压缩', fs.existsSync(P.log) && fs.readFileSync(P.log, 'utf8').includes('记第'), '')
check('告警文案带轮次/百分比/该干什么', (state.alerts || []).every((a) => /第\d+轮/.test(a.text) && /%/.test(a.text)), '')

// ------------------------------------------- 2c. 首次见到会话时按历史补量轮次
console.log('\n【2c】按会话文件补量（装之前压缩过的会话也能数对）')
{
  const tmpSessions = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-alert-sessions-'))
  const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-alert-seed-'))
  const P2 = cfgPaths(ws2)
  fs.mkdirSync(path.join(ws2, 'shared', '历史'), { recursive: true })
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const slug = '--C-Users-Administrator-.dsh-im--'
  const dir = path.join(tmpSessions, slug, sid)
  fs.mkdirSync(dir, { recursive: true })
  const WINDOW = 1048576
  // 曲线：涨到 70% → 掉到 23%（压缩 1）→ 涨到 69% → 掉到 31%（压缩 2）→ 现在 72%
  const pctsCurve = [10, 30, 50, 68, 70, 23, 45, 60, 69, 31, 50, 65, 72]
  const lines = [JSON.stringify({ type: 'request/context', data: { provider: 'x', model: 'y', contextWindow: WINDOW } })]
  for (const p of pctsCurve) {
    lines.push(
      JSON.stringify({
        type: 'assistant/message',
        data: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: Math.round((p / 100) * WINDOW) } },
      }),
    )
  }
  const z = zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), z)

  const cfg2 = normalize({ ...DEFAULTS })
  cfg2._sessionsRoot = tmpSessions
  const m2 = measure({ session: { id: sid }, meter: null, projections: null, cfg: cfg2 })
  check('合成会话文件能读出来', m2.pct === 72, `${m2.pct}%（source=${m2.source}）`)

  const pushed2 = []
  const engine2 = createEngine({
    P: P2,
    getCfg: () => cfg2,
    getAgents: () => null,
    push: async ({ text }) => {
      pushed2.push(text)
      return { ok: true, channel: '会话（自测假推）', reason: '' }
    },
  })
  const r2 = await engine2.sample(sid, m2)
  check('补量后记到第 2 轮（不是从 0 数起）', r2.round === 2, `第 ${r2.round} 轮`)
  check('第 2 轮 72% 命中绝对线', r2.alerted && r2.kind === 'absolute' && pushed2.length === 1, pushed2[0] || '没告警')
  const r3 = await engine2.sample(sid, m2)
  check('绝对线同一档不重复告警', !r3.alerted && pushed2.length === 1, r3.skipped || '')
  try {
    fs.rmSync(tmpSessions, { recursive: true, force: true })
    fs.rmSync(ws2, { recursive: true, force: true })
  } catch {}
}

// -------------------------------------- 3b. 到 70% 自动写交接（不调模型）
console.log('\n【3b】到 70% 自动写交接（只补一行、幂等、可关）')
{
  const wsH = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-handoff-'))
  fs.mkdirSync(path.join(wsH, 'shared'), { recursive: true })
  const handoffFile = path.join(wsH, 'shared', '交接.md')
  fs.writeFileSync(handoffFile, '# 会话交接（自动写）\n\n## 在干什么\n\n- 干活\n', 'utf8')

  const h1 = writeHandoff({ file: handoffFile, sessionId: 'session-hit00001', pct: 70 })
  check('没有「刚完成」段就补一个', h1.ok && h1.added, h1.reason)
  const h2 = writeHandoff({ file: handoffFile, sessionId: 'session-hit00001', pct: 70 })
  check('同一会话写第二遍不重复', h2.ok && !h2.added, h2.reason)
  const txt = fs.readFileSync(handoffFile, 'utf8')
  check('文件里只有一条自动行', (txt.match(/插件自动/g) || []).length === 1)
  check('行里带 70% 和会话 id', /上下文 70%/.test(txt) && txt.includes('session-hit00001'))

  // 已有「刚完成」段：插在段内，别动别的段
  const f2 = path.join(wsH, 'shared', '交接2.md')
  fs.writeFileSync(
    f2,
    ['# 交接', '', '## 在干什么', '', '- 干活', '', '## 刚完成（未满 2 小时）', '', '- [11:00] 旧的一条', '', '## 手头没完的', '', '- 活一', ''].join('\n'),
    'utf8',
  )
  const h3 = writeHandoff({ file: f2, sessionId: 'session-hit00002', pct: 70 })
  const linesH = fs.readFileSync(f2, 'utf8').split('\n')
  const sec = findSection(linesH)
  const iAuto = linesH.findIndex((l) => l.includes('插件自动'))
  const iOld = linesH.findIndex((l) => l.includes('旧的一条'))
  const iNext = linesH.findIndex((l) => /^##\s*手头没完的/.test(l))
  check('插到「刚完成」段尾', h3.ok && h3.added && !!sec, h3.reason)
  check('插在旧条之后、下个标题之前', iOld < iAuto && iAuto < iNext)

  // 引擎全链路：第 0 轮 71% → 告警 + 写交接；同一轮再来不重复
  const PH = {
    workspace: wsH,
    state: path.join(wsH, 'state', 'ctx-alert.json'),
    log: path.join(wsH, 'state', 'ctx-alert.log'),
    history: path.join(wsH, 'shared', '历史'),
    handoff: handoffFile,
    sessionsRoot: path.join(wsH, 'none'),
  }
  const cfgH = normalize({ absolutePct: 0, maxRounds: 1, penultRoundPct: 70, writeHandoff: true })
  cfgH._sessionsRoot = PH.sessionsRoot
  const pushedH = []
  const engineH = createEngine({
    P: PH,
    getCfg: () => cfgH,
    getAgents: () => null,
    push: async ({ text }) => {
      pushedH.push(text)
      return { ok: true, channel: '自测假推', reason: '' }
    },
  })
  const o1 = await engineH.sample('session-hit00003', { pct: 71, source: 'selftest' })
  check('第 0 轮 71% 命中 70% 那条线', o1.alerted && o1.kind === 'penult', `kind=${o1.kind} 线=${o1.threshold}`)
  check('同一次顺手写了交接', Boolean(o1.handoff?.ok && o1.handoff?.added), o1.handoff?.reason || '')
  check('推送照旧发出去', pushedH.length === 1)
  const o2 = await engineH.sample('session-hit00003', { pct: 73, source: 'selftest' })
  const txt2 = fs.readFileSync(handoffFile, 'utf8')
  check('同一轮不再重复告警', !o2.alerted, o2.skipped || '')
  check('交接也没写第二遍', (txt2.match(/插件自动/g) || []).length === 2, `共 ${(txt2.match(/插件自动/g) || []).length} 条（hit00001 + hit00003）`)
  const stH = readState(PH.state)
  check('状态里记了 handoffs', Boolean(stH.sessions?.['session-hit00003']?.handoffs), JSON.stringify(stH.sessions?.['session-hit00003']?.handoffs || {}))

  // 开关关掉：告警照发、交接不写
  const wsOff = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-handoff-off-'))
  fs.mkdirSync(path.join(wsOff, 'shared'), { recursive: true })
  const POff = {
    workspace: wsOff,
    state: path.join(wsOff, 'state', 'ctx-alert.json'),
    log: path.join(wsOff, 'state', 'x.log'),
    history: path.join(wsOff, 'shared', '历史'),
    handoff: path.join(wsOff, 'shared', '交接.md'),
    sessionsRoot: path.join(wsOff, 'none'),
  }
  const cfgOff = normalize({ absolutePct: 0, maxRounds: 1, penultRoundPct: 70, writeHandoff: false })
  cfgOff._sessionsRoot = POff.sessionsRoot
  const engineOff = createEngine({
    P: POff,
    getCfg: () => cfgOff,
    getAgents: () => null,
    push: async () => ({ ok: true, channel: 't', reason: '' }),
  })
  const oOff = await engineOff.sample('session-off00001', { pct: 71 })
  check('writeHandoff=false：告警照发、交接不写', oOff.alerted && !fs.existsSync(POff.handoff), `alerted=${oOff.alerted}`)

  try {
    fs.rmSync(wsH, { recursive: true, force: true })
    fs.rmSync(wsOff, { recursive: true, force: true })
  } catch {}
}

// ------------------------------------------------- 4. 插件本体能不能加载
console.log('\n【4】插件本体加载（假 ctx，真会话）')
process.env.DSH_CTX_ALERT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-alert-load-'))
try {
  const mod = await import('./index.js')
  check('index.js 能 import 出 apply', typeof mod.apply === 'function' && mod.name === 'dsh-ctx-alert')
  const handlers = []
  const fakeCtx = {
    on(name, fn) {
      handlers.push({ name, fn })
      return () => {}
    },
    inject(names, cb) {
      const get = (n) => (n === 'sessions' ? null : null)
      cb({ get })
    },
    effect(fn) {
      try {
        fn()
      } catch {}
    },
    get() {
      return null
    },
    logger: { info() {}, warn() {} },
  }
  let api = null
  try {
    api = mod.apply(fakeCtx)
  } catch (e) {
    check('apply 不抛', false, String(e?.message || e))
  }
  check('apply 返回 evaluate', typeof api?.evaluate === 'function')
  check('挂上了 session/event', handlers.some((h) => h.name === 'session/event'))
  if (typeof api?.evaluate === 'function' && currentId) {
    const r = await api.evaluate({ id: currentId }, undefined)
    check(
      '拿真会话算一次（走会话文件兜底）',
      Number.isFinite(Number(r?.pct)),
      `第 ${r?.round} 轮，${r?.pct}%，告警=${!!r?.alerted}${r?.skipped ? `，${r.skipped}` : ''}`,
    )
    const st = readState(cfgPaths(process.env.DSH_CTX_ALERT_HOME).state)
    const row = st.sessions[currentId]
    check('状态文件记下这个会话', !!row, row ? `round=${row.round} lastPct=${row.lastPct}` : '没记')
    check('13% 上下不该告警', !r?.alerted)
  }
} catch (e) {
  check('加载插件', false, String(e?.message || e))
}
try {
  fs.rmSync(process.env.DSH_CTX_ALERT_HOME, { recursive: true, force: true })
} catch {}
delete process.env.DSH_CTX_ALERT_HOME

// 清理临时工作区
try {
  fs.rmSync(tmpWs, { recursive: true, force: true })
} catch {}

console.log(`\n合计：通过 ${passes}，失败 ${fails}`)
if (fails) {
  console.log('自测没过，别装。')
  process.exit(1)
}
console.log('自测全过。')
process.exit(0)
