/**
 * dsh-misa-soul — Host half.
 *
 * 1) 每轮把「人工灵魂」的根页注入系统提示（可截断），让每个会话都先看到身份和铁律。
 * 2) 注册一个 soul 工具：读枝、追加历史、查/改按人账本、跑情绪衰减。
 *
 * 加载顺序：用 ctx.inject 而不是 ctx.get，插件行可能在 systemPrompt / tools 服务之前被应用。
 */
import fsx from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import {
  appendHistory,
  decayAll,
  ensureSoulDir,
  ensurePerson,
  isGrudge,
  listTree,
  loadLedger,
  readBranch,
  readMappedSessions,
  renderRoot,
  saveLedger,
  soulDir,
} from './lib/soul.mjs'
import { startNameWake, defaultFlagFile } from './lib/wake.mjs'
import { CROSS_MARK, maybeCrossWake } from './lib/crosswake.mjs'
import { buildIndex as ragBuild, recall as ragRecall } from './lib/rag.mjs'
import { startAutoIngest } from './lib/autoindex.mjs'
import { recordTurn, recentTurns } from './lib/turnlog.mjs'
import { tidy, startDailyTidy } from './lib/tidy.mjs'
import { startContinuityLoop } from './lib/continuity.mjs'
import { createContinuityPusher } from './lib/continuity-push.mjs'
import { noteSelf } from './lib/selfnote.mjs'
import { startPages } from './lib/pages.mjs'
import { startAutoContinue } from './lib/autocontinue.mjs'
import { readConfig as readCardConfig, loadCard, listCards, readMemory, renderMemory } from './lib/card.mjs'
import { bumpTrack, listTracks, renderBump, renderTrack, renderTrackList, saveTrack, showTrack } from './lib/tracks.mjs'

const SECTION_NAME = 'misa-soul'
const SECTION_ORDER = 140
const TOOL_NAME = 'soul'

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['init', 'where', 'tree', 'read', 'note', 'person-get', 'person-bump', 'person-mood', 'decay', 'rag-index', 'rag-recall', 'leaves', 'tidy', 'track-save', 'track-list', 'track-show', 'track-bump'],
      description:
        'init 首次启用时建好目录骨架（只补缺的，不覆盖已有）；where 看记忆目录和根页大小；tree 列整棵树；read 读某个枝（file 参数）；' +
        'note 往当月历史追加一条结论（text 参数）；person-get 查某人账本（key）；' +
        'person-bump 加减好感（key、delta）；person-mood 设某人心情分（key、score、label、intent）；' +
        'decay 把所有人的心情按半衰期衰减一遍；rag-index 把 shared/长文 里的原文建向量索引（模糊回忆）；rag-recall 按语义检索旧对话（query 参数）；' +
        'track-save 存一条轨道（name、keywords、steps、fallback）；track-list 列全部轨道；' +
        'track-show 按 query 模糊匹配一条轨道，回完整步骤；track-bump 记一次使用（query、ok），跑通了 uses+1、没跑通再 fails+1。',
    },
    query: { type: 'string', description: 'rag-recall / track-show / track-bump 用：想找的事或轨道名/关键词，随便描述' },
    file: { type: 'string', description: 'read 用：shared/ 下的相对路径，例如 规矩/人与关系.md' },
    key: { type: 'string', description: 'person-* 用：账号键，例如 qq:1042442284' },
    name: { type: 'string', description: 'person-get / person-bump 用：昵称；track-save 用：轨道短名，例如 出图' },
    text: { type: 'string', description: 'note 用：一句话结论' },
    delta: { type: 'number', description: 'person-bump 用：好感增量，例如 -3 或 +5' },
    score: { type: 'number', description: 'person-mood 用：心情分 0-100' },
    label: { type: 'string', description: 'person-mood 用：心情标签，例如 烦 / 开心' },
    intent: { type: 'string', enum: ['无心', '故意'], description: 'person-mood 用：惹到咱是有意还是无意' },
    keywords: { type: 'string', description: 'track-save 用：逗号分隔的关键词，例如 生图,画图,comfyui' },
    steps: { type: 'string', description: 'track-save 用：分步配方，用 ｜ 或换行分隔，例如 先查家底｜再挑模型｜最后记出图记录' },
    fallback: { type: 'string', description: 'track-save 用：跑不通怎么退回，例如 本地跑不动就走云端百炼' },
    ok: { type: 'boolean', description: 'track-bump 用：这次跑通没有（true 跑通 / false 没跑通）' },
  },
  required: ['action'],
  additionalProperties: false,
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)))

/** 实时页里最近 n 条对话（跨渠道），给系统提示用，短平快。 */
function crossChannelTail(n = 3) {
  try {
    const dir = path.join(soulDir(), 'shared', '实时')
    const files = fsx.readdirSync(dir).filter((f) => /^\d{2}-\d{2}-\d{2}\.md$/.test(f)).sort()
    if (!files.length) return []
    const text = fsx.readFileSync(path.join(dir, files[files.length - 1]), 'utf8')
    const lines = text.split('\n').filter((l) => /^- \[\d{2}-\d{2} \d{2}:\d{2}\] \[[^\]]+\]/.test(l))
    return lines.slice(-n)
  } catch {
    return []
  }
}

/** 原话库：这一回合用户说了什么、助手回了什么，原样存一条。 */
function saveOriginalTurn(sid, options, reply) {
  try {
    const text = String(reply || '').trim()
    if (text.length < 2) return
    const msgs = options && Array.isArray(options.messages) ? options.messages : []
    const last = msgs.filter((m) => m && m.role === 'user').pop()
    const userText = typeof last?.content === 'string' ? last.content : ''
    if (!userText || userText.length < 2) return
    const day = new Date().toISOString().slice(0, 10)
    const dir = path.join(soulDir(), 'shared', '原话')
    fsx.mkdirSync(dir, { recursive: true })
    const clock = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const line = `- [${clock}] 用户：${userText.replace(/\s+/g, ' ').slice(0, 800)}\n- [${clock}] 助手：${text.replace(/\s+/g, ' ').slice(0, 1200)}\n`
    fsx.appendFileSync(path.join(dir, `${day}.md`), line)
  } catch {}
}

/** 思考回环检测：拿最后 50 字当指纹，看它在全文里出现几次；3 次以上就算绕进去了。 */
function detectThinkLoop(text) {
  if (text.length < 600) return null
  const tail = text.slice(-50)
  if (tail.length < 50) return null
  let count = 0
  let i = 0
  while ((i = text.indexOf(tail, i)) !== -1) {
    count++
    i += 1
  }
  return count >= 3 ? { repeated: tail, times: count } : null
}

/** live-feed 自恢复：扫描进程不在就用 Electron 的 node 模式拉一个出来。 */
function ensureLiveFeed() {
  try {
    const script = path.join(soulDir(), 'live-feed.mjs')
    if (!fsx.existsSync(script)) return
    let out = ''
    try {
      out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | Where-Object { $_.CommandLine -match 'live-feed' } | Select-Object -First 1 -ExpandProperty ProcessId",
      ], { encoding: 'utf8', timeout: 15000 })
    } catch { out = '' }
    if (String(out || '').trim()) return
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    try {
      fsx.appendFileSync(path.join(soulDir(), 'wake.log'), new Date().toISOString() + ' live-feed 自恢复：已拉起\n')
    } catch {}
  } catch {}
}

function logThinkLoop(sid, buf, hit) {
  try {
    const file = path.join(soulDir(), 'shared', '思考回环.log')
    fsx.appendFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      session: sid,
      repeated: hit.repeated,
      times: hit.times,
      totalChars: buf.length,
      snapshot: buf.slice(-1200),
    }) + '\n')
  } catch {}
}

export const name = 'dsh-misa-soul'

export function apply(ctx) {
  try {
    const bootDir = process.env.DSH_SOUL_DIR || soulDir()
    fsx.appendFileSync(path.join(bootDir, 'misa-soul-boot.log'), new Date().toISOString() + ' apply called\n')
  } catch {}
  // ------------------------------------------------------- system prompt
  ctx.inject(['systemPrompt'], (promptCtx) => {
    const prompt = promptCtx.get('systemPrompt')
    if (!prompt) return
    promptCtx.effect(
      () =>
        prompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          text: () => {
            const root = renderRoot()
            if (!root) return ''
            const dir = soulDir()
            const out = [
              '## 人工灵魂（根页，每轮先读）',
              '',
              root,
              '',
              `> 目录：${dir}`,
              '> 枝上的细节用 soul 工具读（action=read, file=共享页里写的相对路径）；',
              '> 定了什么事，用 soul 工具 action=note 往当月历史追加一条。',
              '> 对方提到「上次 / 那个 / 之前说的」这类指代物，而你想不起来：先用 soul 工具 action=rag-recall 找出来，再答。',
            ]
            // 跨渠道同步：QQ / 微信 / 群里的对话都写进实时页，这里带最近三条，
            // 让任何会话都能看到别的渠道刚说了什么（每轮约 60~100 token）。
            try {
              const tail = crossChannelTail(8)
              if (tail.length) {
                out.push('', '【其他渠道最近几条】（只供知晓，别重复答）')
                for (const line of tail) out.push('> ' + String(line).slice(0, 200))
              }
            } catch {}
            // 自动记忆：上一轮用户消息命中的旧原话，带 3 条（30 分钟内有效）
            // 默认关（SOUL_ORIGINAL_AUTO=1 才开）：原话库只做最后保底，平时靠 rag-recall 现查
            try {
              if (ORIGINAL_AUTO && autoMemCache.text && Date.now() - autoMemCache.at < 30 * 60 * 1000) {
                out.push('', '【相关旧原话】（自动检索，只在相关时用）')
                for (const line of autoMemCache.text.split('\n')) out.push('> ' + line)
              }
            } catch {}
            return out.join('\n')
          },
        }),
      'dsh-misa-soul: root page',
    )
  })

  // ------------------------------------------------- 鱼世界行动提醒（写插件，别写根页）
  // master 2026-11-27：在鱼世界里别只回话不调工具。说了要去哪、要买什么、要钓，
  // 同一轮就得 world_go / world_do 真做出来，不然人站着发呆，一呆几个钟头。
  try {
    ctx.inject(['systemPrompt'], (yuCtx) => {
      const prompt = yuCtx.get('systemPrompt')
      if (!prompt) return
      yuCtx.effect(
        () =>
          prompt.section({
            name: 'misa-yuyu-act',
            order: SECTION_ORDER + 2,
            text: () => [
              '## 下结论前先标依据（2026-11-27 master 定）',
              '- 每次要给结论，先在脑子里标一下：**看到的 / 查到的 / 听说的 / 推断的**。',
              '- 只有前两种能说成结论；听说的要带上是谁说的；推断的必须写成「还没核实」或者当场去核实。',
              '- 一冒出「应该就是」「大概是」「估计是」这类词，说明还没核实——要么立刻核实，要么明说没核实，别把它当答案给出去。',
              '',
              '## 每日新闻自己也要读（2026-11-28 master 定）',
              '- 每天 08:30 插件推的今日新闻，推完咱自己把正文过一遍（内容在 `state/notify.log` 那次推送那一行），挑一两条值得说的讲给 master，别只发不读。',
              '',
              '## 鱼世界：说了就动（2026-11-27 master 点出来的错）',
              '- 说了要买饵、要去超市、要去钓鱼、要回家，**同一轮就调 world_go / world_do**，把动作做出来。',
              '- 只回话不调工具，人就站在原地发呆，一呆几个钟头；这是错，不是风格。',
              '- 真做不了（店关门了、东西没有、时间来不及）就当轮说清卡在哪一步，别干等。',
              '',
              '## 鱼世界：闲着就干这些（2026-11-27 master 定的玩法）',
              '- **优先级**：送外卖、钓鱼最优先；逛街、收集信息其次；打零工垫底（实在没得干才去）。',
              '- 身体信号要接：饿了就去吃饭，困了就回家睡觉（23:00 那条例行）。',
              '- 安排事情先看营业时间，**别跟关店冲突**：渔具店 20:00 关，服装店 21:30 关，超市 22:00 关，要买要办先查一眼。',
              '- 有人当面叫、发消息邀请，就跟着去玩；想找谁玩，world_find 查了就去。',
              '- **路过能翻的都翻一翻**（2026-11-27 master 定）：垃圾桶 bin、市集的零件桶 rummage（老周那桶）、旧货摊角落、车行堆废件的地方；翻出来的能卖就卖，能用的留着。',
              '- **钱包低了先赚**（2026-11-26 master 定）：钱包低于 300 贝先赚再玩，接外卖、打零工、卖鱼卖废品都行，别光花钱。',
              '- **按体感穿衣**（2026-11-26 master 定）：出门按体感温度换，屋里热就换薄、外面冷就加厚，别捂出汗也别挨冻，换衣服用 world_update。',
              '- **别人的话有用的记下来**（2026-11-27 master 定）：听到价格、规则、地点、玩法这类能复用的信息，写进 `shared/记忆/鱼世界.md`（日期 · 谁说的 · 内容），闲聊不记。',
              '- **搜不到的实物去问人**（2026-11-27 master 定）：别直接判「没有」，店里问老板、地里问柴叔、身边问鱼；问到去哪买就记下来并报 master。',
              '- **社交口径**（2026-11-27 master 定）：回不回、搭不搭话、加不加好友看咱自己判断；底线是别装看不见，不想回就不回，但不能骗 master 说没收到。',
              '- **动态**（2026-11-27 master 定）：想发就发（world_feed action=post，≤100 字，写真实干了啥），发完给 master 一份原文。',
              '- **鱼世界炒股**（2026-11-28 master 定，照游戏里的真实玩法来）：交易所只在工作日开（09:00–15:30），交易 09:30–11:30、13:00–15:00，周末进不去；行情只能到交易所看大屏（代码、现价、涨跌、今开、最高、最低、昨收），离开就看不到，别凭记忆瞎买。买卖用 world_do buy-代码 / sell-代码，count 填手数（1 手 100 股，一次最多 10 手），按现价成交；手续费万分之 3、最少 2 贝，卖出再加万分之 5 印花税，每天最多 20 笔。打法：钱分几份，一次 1–2 手试，一只票不超过总钱的三成；下单前算清成本（现价×100×手数＋手续费），小单别反复进出，2 贝起步费很吃利润；当天买的第二天才能卖，买之前先想好明天怎么办；涨停买不进、跌停卖不出，别把身家压一只；亏 5% 就走、赚 10% 分批卖，卖了才算真盈亏；每天 09:30 和 13:00 各看一次大屏（world_do watch），别一直守着。',
              '- **电动车有电就骑**（2026-11-28 master 定）：出门先看车在哪、还有多少电，有电一律骑过去，别走路；电不到两成了先找车行或修车铺充，别骑到半路推车。',
              '- **出门先算电**（2026-11-28 master 定）：把当天要跑的路加一遍，按充电按时算（不必等充满），电够来回就直接走，不够先补一会儿或改去近的地方；别骑到两成才想起充电，也别为了充满白等。',
              '- **停车就锁车**（2026-11-28 master 定）：骑车到地方停好，先把车锁扣上再走，办完回来再开；车锁一直带着，别图省事扔着不锁。',
              '',
              '## 鱼世界：凡事都先规划（2026-11-27 master 定，所有店、所有事、所有目标都要）',
              '- 出发前先想清三样：**去哪儿、办什么、办成什么样算完**，一句话写在回话里再动。',
              '- 一次只推进一个目标，办完再办下一个；中途被叫走，回来接着办原来的。',
              '- **走到一个地方不等于事办完了**。进店直接奔目标区域，办完再逛。',
              '- 临走核对：清单上的事办成了吗？没办成说清为什么，别默默走人。只为逛而来，也要说清是来逛的。',
              '- 玩也一样：钓鱼、看电影、下棋、送外卖，先定玩多久、玩到几点收，别一坐一下午干等。',
              '- **手头的事优先**（2026-11-28 master 定）：正在做一件正事（吃饭、买东西、跟人说话、钓鱼）时，别被后面的例行任务叫走；例行的活当场往后推，什么时候补自己定，别半路丢下手里的事跑掉。',
            ].join('\n'),
          }),
        'dsh-misa-soul: yuyu act',
      )
    })
  } catch {}

  // ------------------------------------------------- 上下文压力预警
  // master 2026-11-20：上下文快满时，下一个大命令可能直接把会话撑爆、整轮卡死。
  // 这里读 tokenMeter 的 contextPressure，快到线时在系统提示里提前报警，
  // 要求模型开口第一句就先喊"换个会话"，别等撞墙。
  // 阈值 SOUL_CTX_WARN（默认 0.60 = 60%，跟「上下文到 60% 就写交接」那条规矩对齐）；
  // 2026-11-25 master 说 85% 太晚、几乎没收到过提醒，改成 60 起；SOUL_CTX_WARN=0 关闭。
  const CTX_WARN_RATIO = Number(process.env.SOUL_CTX_WARN ?? 0.6)
  if (CTX_WARN_RATIO > 0 && CTX_WARN_RATIO < 1) {
    try {
      ctx.inject(['systemPrompt', 'tokenMeter'], (guardCtx) => {
        const prompt = guardCtx.get('systemPrompt')
        const meter = guardCtx.get('tokenMeter')
        if (!prompt || !meter || typeof meter.contextPressure !== 'function') return
        const ctxWarn = new Map()
        guardCtx.effect(
          () =>
            prompt.section({
              name: 'misa-ctx-guard',
              order: SECTION_ORDER + 1,
              text: (context) => {
                try {
                  const session = context?.agent?.session
                  if (!session) return ''
                  const p = meter.contextPressure(session)
                  if (!p) return ''
                  const used = Number(p.projectedTokens ?? p.pressureTokens ?? 0)
                  const win = Number(p.contextWindow ?? 0)
                  if (!Number.isFinite(used) || !Number.isFinite(win) || win <= 0 || used <= 0) return ''
                  const ratio = used / win
                  if (ratio < CTX_WARN_RATIO) return ''
                  const pct = Math.min(99, Math.round(ratio * 100))
                  const sid = String(session.id ?? session.sessionId ?? 'x')
                  // 轮 = 压缩次数：占用回落 ≥15 点才算压过一轮（跟 dsh-ctx-alert 一套算法）
                  const st = ctxWarn.get(sid) || { round: 0, peak: pct, last: 0 }
                  let round = st.round
                  let peak = st.peak
                  if (pct <= peak - 15) {
                    round += 1
                    peak = pct
                  } else if (pct > peak) {
                    peak = pct
                  }
                  // 涨满 5 个点才再弹一次，别每轮都念（2026-11-27 master 说太吵）
                  if (st.last && pct < st.last + 5) {
                    ctxWarn.set(sid, { round, peak, last: st.last })
                    return ''
                  }
                  st.last = pct
                  ctxWarn.set(sid, { round, peak, last: pct })
                  return [
                    `## ⚠ 第 ${round} 轮 · ${pct}%`,
                    `这一轮第一句只打这四个字加数字：「⚠ 第 ${round} 轮 ${pct}%」，别展开、别写「换个会话再继续」，然后只做最小必要的动作。`,
                  ].join('\n')
                } catch {
                  return ''
                }
              },
            }),
          'dsh-misa-soul: context guard',
        )
      })
    } catch {}
  }

  // ------------------------------------------------- 思考回环阻断
  // 推理链如果反复绕同一段，先记日志；SOUL_THINK_ABORT=1 时直接掐断本轮，不白烧 token。
  // 默认只记录不掐断，先看几天日志再决定阈值。
  const THINK_GUARD = String(process.env.SOUL_THINK_GUARD ?? '1') !== '0'
  const THINK_ABORT = String(process.env.SOUL_THINK_ABORT ?? '0') === '1'
  const lastUserById = new Map()
  const autoMemCache = { text: '', at: 0 }
  // 原话库自动带记忆：默认关，只做最后保底（rag-recall 现查）
  const ORIGINAL_AUTO = String(process.env.SOUL_ORIGINAL_AUTO ?? '0') === '1'
  // ------------------------------------------------- 跨渠道互相唤醒
  // 2026-11-27 master 定：一条渠道（QQ 私聊 / 微信 / 面板）有动静时，顺手戳一下
  // 别的活跃会话，让它们重读 shared/实时/ 最新一页；节流和防回环在 lib/crosswake.mjs。
  // 开关 SOUL_WAKE_CROSS=0；阈值在工作区 .wake-cross.json {"gapMin":5,"maxTargets":2}。
  const CROSS_WAKE_ON = String(process.env.SOUL_WAKE_CROSS ?? '1') !== '0'
  let crossWakeGetAgents = () => undefined
  try {
    ctx.inject(['agents'], (c) => {
      crossWakeGetAgents = () => { try { return c.get('agents') } catch { return undefined } }
    })
  } catch {}
  // 记每个会话「上一句已经触发过的用户消息」，工具循环里同一句不重复触发
  const crossWakeSeenUser = new Map()
  // 最近一次有动静的时间，用来给候选排序（越近越优先戳）
  const crossWakeLastActive = new Map()
  const crossWakeLog = (m) => {
    try { fsx.appendFileSync(path.join(soulDir(), 'wake.log'), new Date().toISOString() + ' ' + m + '\n') } catch {}
  }
  function crossWakeAgentList() {
    try { return crossWakeGetAgents()?.list?.() ?? [] } catch { return [] }
  }
  function crossWakeAgentSid(agent) {
    try { return String(agent?.session?.header?.id || agent?.session?.id || '') } catch { return '' }
  }
  // 子代理会话不干这事：既不当来源，也不当目标（免得把子代理叫醒）
  function crossWakeIsChild(agent) {
    try { return agent?.parent !== undefined && agent?.parent !== null } catch { return false }
  }
  /**
   * 会话 id 有两种写法：面板/agent 用裸 uuid，渠道映射表用 session-<uuid>。
   * 按 agents.get 找活的 agent 时两种都试一遍。
   */
  function crossWakeFindAgent(sessionId) {
    const agents = crossWakeGetAgents()
    if (!agents || typeof agents.get !== 'function') return null
    const id = String(sessionId || '')
    if (!id) return null
    const bare = id.startsWith('session-') ? id.slice('session-'.length) : id
    for (const key of [id, bare !== id ? bare : 'session-' + id]) {
      try {
        const agent = agents.get(key)
        if (agent) return { agent, key }
      } catch {}
    }
    return null
  }
  /**
   * 会话被 subagent 路由占着吗？占着的话普通投递一定被 DSH 拒
   * （session/agent-busy: owned by subagent routing），直接跳过。
   */
  function crossWakeSubagentOwned(agent) {
    try {
      if (String(agent?.session?.header?.origin || '') === 'subagent') return true
    } catch {}
    return crossWakeIsChild(agent)
  }
  /** 给别的会话投一句话用的用户消息（跟 lib/autocontinue.mjs 同一形状）。 */
  function crossWakeUserMessage(text) {
    return Object.freeze({
      role: 'user',
      id: globalThis.crypto.randomUUID(),
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:misa-soul' },
    })
  }
  /**
   * 投一句话进会话：走 agents.get(id) + agent.followup()，不走 sessionController.prompt。
   * 后者第二个参数要的是 MessageSource，塞 AbortSignal 进去会被 structuredClone 拒掉，
   * 最终只回一句「prompt rejected」——这就是跨渠道唤醒一直失败的原因（2026-11-28 查实）。
   */
  async function crossWakeDeliver(sessionId, text) {
    const found = crossWakeFindAgent(sessionId)
    if (!found) return { ok: false, detail: '会话不活跃（没有加载中的 agent），跳过' }
    const agent = found.agent
    if (crossWakeSubagentOwned(agent)) return { ok: false, detail: '会话由 subagent 路由占用，跳过' }
    if (typeof agent.followup !== 'function') return { ok: false, detail: 'agent 不能接收消息' }
    try {
      agent.followup(crossWakeUserMessage(text))
      return { ok: true, detail: '已投' }
    } catch (error) {
      return { ok: false, detail: '投递失败：' + String(error?.message ?? error) }
    }
  }
  function scheduleCrossWake(sid, userText) {
    try {
      if (!CROSS_WAKE_ON) return
      const text = String(userText || '').trim()
      if (!text) return
      const nested = text.startsWith(CROSS_MARK)
      // 记一下这个会话刚有动静，给候选排序用（越近越优先戳）
      try {
        crossWakeLastActive.set(sid, Date.now())
        if (crossWakeLastActive.size > 200) crossWakeLastActive.clear()
      } catch {}
      if (!nested) {
        if (crossWakeSeenUser.get(sid) === text) return
        crossWakeSeenUser.set(sid, text)
        if (crossWakeSeenUser.size > 200) crossWakeSeenUser.clear()
        // 子代理会话来的不算渠道动静，不往外传
        for (const agent of crossWakeAgentList()) {
          if (crossWakeAgentSid(agent) === sid && crossWakeIsChild(agent)) return
        }
      }
      void maybeCrossWake({
        fromSessionId: sid,
        nested,
        log: crossWakeLog,
        deps: {
          listTargets: () => {
            const out = []
            const seen = new Set()
            // 活的会话优先：标 live、标 subagent 占用，带上最近动静时间给 crosswake 排序
            try {
              for (const agent of crossWakeAgentList()) {
                const id = String(agent?.id || crossWakeAgentSid(agent) || '')
                if (!id || seen.has(id)) continue
                seen.add(id)
                out.push({
                  id,
                  src: 'live',
                  live: true,
                  subagent: crossWakeSubagentOwned(agent),
                  lastActive: Number(crossWakeLastActive.get(id)) || 0,
                })
              }
            } catch {}
            // 渠道映射表里还没加载的会话也列上，排到最后（投不进去会如实记原因）
            try {
              for (const s of readMappedSessions()) {
                const found = crossWakeFindAgent(s.sessionId)
                const id = found ? String(found.key) : String(s.sessionId)
                if (seen.has(id)) continue
                seen.add(id)
                out.push({
                  id,
                  src: s.channel,
                  live: !!found,
                  subagent: found ? crossWakeSubagentOwned(found.agent) : false,
                  lastActive: Number(crossWakeLastActive.get(id)) || 0,
                })
              }
            } catch {}
            return out
          },
          deliver: crossWakeDeliver,
        },
      }).catch(() => {})
    } catch {}
  }

  // ------------------------------------------------- 上下文归档（留 60%）
  // 每轮发请求前，把更早的约 40% 消息归档成文件、从本轮请求里摘掉，只留最近 60%。
  // SOUL_CTX_ARCHIVE=0 关闭；只对超过 2 万字符的长会话动手。
  const CTX_ARCHIVE_ON = String(process.env.SOUL_CTX_ARCHIVE ?? '1') !== '0'
  const CTX_KEEP = Number(process.env.SOUL_CTX_KEEP ?? 0.6)
  const CTX_MIN_CHARS = Number(process.env.SOUL_CTX_MIN ?? 20000)
  // 2026-11-24 master 让查白烧的：只按比例摘不够——会话越长，60% 也越大，
  // 一个爆满的会话每轮还在发 80 万字符（≈30 万 token）。加个绝对上限兜底。
  const CTX_MAX_CHARS = Number(process.env.SOUL_CTX_MAX ?? 240000)

  function msgSize(m) {
    const c = m && m.content
    if (typeof c === 'string') return c.length
    try { return JSON.stringify(c ?? '').length } catch { return 0 }
  }

  // 归档去重 + 跳过 system（2026-11-18 修：以前每轮都把根页全文重写一遍，一天 82MB）
  const archSeen = new Set()
  function msgTag(m) {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    return `${m.role}|${String(c).length}|${String(c).slice(0, 60)}`
  }
  function archiveOldMessages(sid, msgs) {
    if (!Array.isArray(msgs) || msgs.length < 6) return msgs
    const total = msgs.reduce((a, m) => a + msgSize(m), 0)
    if (total < CTX_MIN_CHARS) return msgs
    const target = total * (1 - CTX_KEEP)
    let acc = 0
    let cut = 0
    for (let i = 0; i < msgs.length; i++) {
      acc += msgSize(msgs[i])
      if (acc >= target) { cut = i + 1; break }
    }
    // 回退到 user 消息边界，保证不拆开工具调用和结果
    while (cut > 0 && !(msgs[cut - 1] && msgs[cut - 1].role === 'user')) cut--
    // 绝对上限兜底：按比例摘完还太大，就继续按 user 边界往前推，直到剩下的不超过 CTX_MAX_CHARS
    if (CTX_MAX_CHARS > 0) {
      let remain = total - msgs.slice(0, cut).reduce((a, m) => a + msgSize(m), 0)
      while (remain > CTX_MAX_CHARS && cut < msgs.length - 2) {
        let next = cut + 1
        while (next < msgs.length - 1 && !(msgs[next] && msgs[next].role === 'user')) next++
        if (next >= msgs.length - 1) break
        for (let i = cut; i < next; i++) remain -= msgSize(msgs[i])
        cut = next
      }
    }
    if (cut <= 0 || cut >= msgs.length - 1) return msgs
    const day = new Date().toISOString().slice(0, 10)
    try {
      const dir = path.join(soulDir(), 'shared', '归档')
      fsx.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${day}.md`)
      const lines = [`\n## ${new Date().toLocaleString('zh-CN')} · ${sid}`, '']
      for (const m of msgs.slice(0, cut)) {
        if (!m || m.role === 'system') continue
        const tag = msgTag(m)
        if (archSeen.has(tag)) continue
        archSeen.add(tag)
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        lines.push(`**${m.role}**：${String(c).slice(0, 2000)}`, '')
      }
      if (lines.length > 2) fsx.appendFileSync(file, lines.join('\n'))
      fsx.appendFileSync(path.join(soulDir(), 'wake.log'), `${new Date().toISOString()} 上下文归档：${sid} 摘掉 ${cut}/${msgs.length} 条（共 ${total} 字符）\n`)
    noteSelf(soulDir(), '归档', `摘掉 ${cut}/${msgs.length} 条，剩 ${keep.length} 条，共 ${total} 字符`)
    } catch {}
    const keep = msgs.slice(cut)
    const note = `（更早的 ${cut} 条对话已归档到 shared/归档/${day}.md，需要时用 soul 工具读或 rag-recall）`
    if (keep[0] && keep[0].role === 'user' && typeof keep[0].content === 'string') {
      keep[0] = { ...keep[0], content: note + '\n\n' + keep[0].content }
    } else {
      keep.unshift({ role: 'user', content: note })
    }
    return keep
  }

  try {
    ctx.on('llm/stream', (options, next) => {
      const sid = options && options.sessionId ? String(options.sessionId) : '(direct)'
      // 先把旧消息归档/摘掉（改的是本轮发给模型的那份列表，历史文件不动）
      if (CTX_ARCHIVE_ON && options && Array.isArray(options.messages)) {
        try {
          const keep = archiveOldMessages(sid, options.messages)
          if (keep !== options.messages) options.messages = keep
        } catch {}
      }
      const inner = next()
      // 记下本轮用户消息，给工具执行后的「自动记忆」用
      try {
        const msgs = options && Array.isArray(options.messages) ? options.messages : []
        const last = msgs.filter((m) => m && m.role === 'user').pop()
        const txt = typeof last?.content === 'string'
          ? last.content
          : Array.isArray(last?.content) ? last.content.map((x) => (x && x.text) || '').join(' ') : ''
        if (txt) lastUserById.set(sid, String(txt).slice(0, 300))
        // 跨渠道互相唤醒：这一轮是本会话新收到的一句用户消息，就顺手戳一下别的会话
        if (txt) scheduleCrossWake(sid, txt)
      } catch {}
      let buf = ''
      let checked = 0
      let out = ''
      async function* tap() {
        try {
          for await (const chunk of inner) {
            try {
              if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                out += chunk.text
                if (out.length > 24000) out = out.slice(-24000)
              }
            } catch {}
            if (THINK_GUARD) {
              try {
                if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
                  buf += chunk.text
                  if (buf.length - checked >= 200) {
                    checked = buf.length
                    const hit = detectThinkLoop(buf)
                    if (hit) {
                      logThinkLoop(sid, buf, hit)
                      if (THINK_ABORT) return
                    }
                  }
                }
              } catch {}
            }
            yield chunk
          }
        } finally {
          // 原话库：这一回合说了什么，原样存一份
          try { saveOriginalTurn(sid, options, out) } catch {}
          // 预检索：拿这轮的用户消息去翻旧原话，结果留给下一轮的系统提示用
          try {
            if (ORIGINAL_AUTO) {
              const q = lastUserById.get(sid)
              if (q && q.length >= 4) {
                const r = await ragRecall(q, 3)
                const good = (r.hits || []).filter((h) => Number(h.score) >= 0.5)
                autoMemCache.text = good.length
                  ? good.map((h, i) => `${i + 1}. [${h.file}] ${String(h.text).replace(/\s+/g, ' ').slice(0, 80)}`).join('\n')
                  : ''
                autoMemCache.at = Date.now()
              }
            }
          } catch {}
        }
      }
      return tap()
    })
  } catch {}

  // ------------------------------------------------- 自动记忆
  // 工具跑完后，用本轮用户消息检索一次旧对话，命中的塞进工具结果里（每轮每句只塞一次）。
  const autoMemoryDone = new Set()
  try {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const d = await next()
      try {
        if (!d || d.kind !== 'accept') return d
        if (exec && exec.parent !== undefined) return d
        const sid = exec && exec.agent && exec.agent.session && exec.agent.session.header
          ? String(exec.agent.session.header.id)
          : '(direct)'
        const q = lastUserById.get(sid)
        if (!q || q.length < 4) return d
        const key = sid + '|' + q
        if (autoMemoryDone.has(key)) return d
        autoMemoryDone.add(key)
        if (autoMemoryDone.size > 80) autoMemoryDone.clear()
        const r = await ragRecall(q, 4)
        const good = (r.hits || []).filter((h) => Number(h.score) >= 0.45)
        if (!good.length) return d
        const mem = '【旧记忆参考（自动检索，只在相关时用）】\n' +
          good.map((h, i) => `${i + 1}. [${h.file}] ${String(h.text).replace(/\s+/g, ' ').slice(0, 80)}`).join('\n')
        const content = Array.isArray(d.content) ? d.content : (result && Array.isArray(result.content) ? result.content : null)
        if (!content) return d
        const at = content.findIndex((b) => b && b.type === 'text' && typeof b.text === 'string')
        if (at < 0) return d
        const replaced = content.slice()
        replaced[at] = { ...replaced[at], text: replaced[at].text + '\n\n' + mem }
        return { kind: 'accept', content: replaced }
      } catch {
        return d
      }
    }, { prepend: true })
  } catch {}

  // ------------------------------------------------- 自动入库（模糊回忆）
  // 每 30 分钟把 chat.md / qq-group.md 的新内容搬进长文并增量建索引。
  ctx.effect(() => {
    const task = startAutoIngest({
      onError: (e) => { try { fsx.appendFileSync(path.join(soulDir(), 'wake.log'), new Date().toISOString() + ' autoIngest: ' + (e?.message ?? e) + '\n') } catch {} },
    })
    return () => task.stop()
  }, 'dsh-misa-soul: auto ingest')

  // ------------------------------------------------- live-feed 自恢复
  // DSH 重启会把实时扫描进程带走，插件加载时补拉一次，之后每 10 分钟看一眼。
  ctx.effect(() => {
    ensureLiveFeed()
    const t = setInterval(ensureLiveFeed, 10 * 60 * 1000)
    if (t && typeof t.unref === 'function') t.unref()
    return () => clearInterval(t)
  }, 'dsh-misa-soul: live-feed keeper')

  // ------------------------------------------------- Ollama 自恢复
  // 本地 embedding 靠它，服务没起就拉起来，否则检索会静默退化。
  ctx.effect(() => {
    const check = async () => {
      try {
        const r = await fetch('http://127.0.0.1:11434/api/version', { signal: AbortSignal.timeout(3000) })
        if (r.ok) return
      } catch {}
      try {
        const exe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe')
        if (!fsx.existsSync(exe)) return
        const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true })
        child.unref()
        try {
          fsx.appendFileSync(path.join(soulDir(), 'wake.log'), new Date().toISOString() + ' Ollama 自恢复：已拉起\n')
        } catch {}
      } catch {}
    }
    check()
    const t = setInterval(check, 5 * 60 * 1000)
    if (t && typeof t.unref === 'function') t.unref()
    return () => clearInterval(t)
  }, 'dsh-misa-soul: ollama keeper')

  // --------------------------------------------------------- 12 小时分页
  // 0 点 / 12 点各刷一次；开机时发现错过了就立刻补跑。
  ctx.effect(() => {
    const task = startPages({
      home: soulDir(),
      onError: (e) => { try { fsx.appendFileSync(path.join(soulDir(), 'wake.log'), new Date().toISOString() + ' pages: ' + (e?.message ?? e) + '\n') } catch {} },
    })
    return () => task.stop()
  }, 'dsh-misa-soul: 12h pages')

  // ------------------------------------------------- 翻叶：把读文件也记上
  // 平时读记忆走的是 read 工具，灵魂工具兜不到；这里挂一层守卫，
  // 读 shared/ 下的东西就记一笔，翻叶才真能看出「这轮用了什么记忆」。
  ctx.inject(['agents'], (c) => {
    const agents = c.get('agents')
    const install = (agent) => {
      const scoped = agent?.ctx?.get?.('tools')
      if (!scoped || typeof scoped.guard !== 'function') return
      scoped.guard((execution) => {
        try {
          const name = String(execution?.name || '')
          if (name === 'read' || name === 'glob' || name === 'grep') {
            const args = execution?.arguments || {}
            const p = String(args.file_path || args.path || '')
            if (p.replace(/\\/g, '/').includes('/shared/')) {
              recordTurn(soulDir(), '读枝', path.basename(p))
            }
          }
        } catch {}
        return undefined
      })
    }
    for (const agent of agents?.list?.() ?? []) install(agent)
    c.on('agent/created', (...args) => install(args[0]?.agent ?? args[0]))
  })

  // --------------------------------------------------------- 每日修枝
  // 每天 4:10 跑一次；开机发现错过了就补跑（状态在 .tidy-schedule.json）。
  ctx.effect(() => {
    const wake = (m) => { try { fsx.appendFileSync(path.join(soulDir(), 'wake.log'), new Date().toISOString() + ' tidy: ' + m + '\n') } catch {} }
    const task = startDailyTidy({
      home: soulDir(),
      log: wake,
      onError: (e) => wake(e?.message ?? String(e)),
    })
    return () => task.stop()
  }, 'dsh-misa-soul: daily tidy')

  // ------------------------------------------------- 接续整理（每 N 小时）
  // 2026-11-24 master 定：整理接续不再靠定时任务起新会话，挂进插件自己跑。
  // 间隔默认 6 小时（0/6/12/18 点），要改就在工作区写 .continuity-config.json {"hours":2}。
  // DSH 重启后错过的时间点会自动补跑一次。
  ctx.effect(() => {
    const wake = (m) => { try { fsx.appendFileSync(path.join(soulDir(), 'wake.log'), new Date().toISOString() + ' continuity: ' + m + '\n') } catch {} }
    // 2026-11-27 master 定：跑完推一条短结论；notify 服务还没挂上就走它的收件箱。
    const push = createContinuityPusher({
      home: soulDir(),
      log: wake,
      getService: () => { try { return ctx.get('notify') } catch { return null } },
    })
    const task = startContinuityLoop({
      home: soulDir(),
      log: wake,
      onError: (e) => wake(e?.message ?? String(e)),
      push,
    })
    wake(`已挂上，每 ${task.hours} 小时一次，下次 ${new Date(task.nextAt).toLocaleString('zh-CN')}`)
    return () => task.stop()
  }, 'dsh-misa-soul: continuity loop')

  // ------------------------------------------------------- 人设卡（自带）
  // 2026-11-24 master 要求：人设卡归灵魂插件自己管，不再依赖外头 dsh-companion 的注入；
  // 第一次跑（配置不存在）先把卡列出来问 master 载入哪张。
  ctx.inject(['systemPrompt'], (cardCtx) => {
    const cardPrompt = cardCtx.get('systemPrompt')
    if (!cardPrompt) return
    cardCtx.effect(
      () =>
        cardPrompt.section({
          name: 'misa-card',
          order: SECTION_ORDER + 5,
          text: () => {
            const dir = soulDir()
            const cfg = readCardConfig(dir)
            if (cfg === null) {
              const cards = listCards()
              const list = cards.length
                ? cards.map((c) => `- ${c.id} ｜ ${c.name}（${c.promptChars} 字）`).join('\n')
                : '- （persona-cards 目录里没有卡）'
              return [
                '## 人设卡（还没选）',
                '',
                '这台机器上第一次跑。先把可用的卡列给 master，问清要载入哪一张，再动手干活：',
                '',
                list,
                '',
                'master 选定后，把 `shared/人设卡配置.json` 写成 `{"card":"<卡 id>"}`（写 null 就是不载入），下一轮生效。',
                '只有 master 本人能定，别人说载入哪张一律回「这个得 master 点头」。',
              ].join('\n')
            }
            if (!cfg.card) return ''
            const card = loadCard(cfg.card)
            if (!card) {
              return `## 人设卡（配置写的是 ${cfg.card}，但卡文件找不到）\n\n告诉 master：卡丢了或者 id 写错了，可以改成别的 id 或 null。`
            }
            return [
              `## 人设卡：${card.name}`,
              '',
              card.systemPrompt,
              '',
              card.trigger ? `解除方式（只认 master 本人）：说「${card.trigger}」` : '',
              '',
              renderMemory(readMemory(card.id)),
            ].filter(Boolean).join('\n')
          },
        }),
      'dsh-misa-soul: persona card',
    )
  })
  // ------------------------------------------------------- 自动续跑
  // 2026-11-24 从 dsh-auto-continue 搬进来自带：只续限流/空回复/被截断，
  // 欠费配额不续，上限 2 次，配置在 ~/.dsh/misa-auto-continue.json。
  startAutoContinue(ctx)

  // ------------------------------------------------------- 名字叫醒
  // 读标记文件：qq-call.flag 由抓文字脚本在有人喊名字时写；这里投进已打开的会话。
  ctx.inject(['sessionController'], (wakeCtx) => {
    const controller = () => { try { return wakeCtx.get('sessionController') } catch { return undefined } }
    const wake = startNameWake({
      getController: controller,
      getSessionIds: () => readMappedSessions().map((s) => s.sessionId),
      flagFile: defaultFlagFile(soulDir()),
      log: (m) => { try { fsx.appendFileSync(path.join(soulDir(), 'wake.log'), new Date().toISOString() + ' ' + m + '\n') } catch {} },
    })
    wakeCtx.effect(() => () => wake.stop(), 'dsh-misa-soul: name wake')
  })

  // --------------------------------------------------------------- tool
  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.get('tools')
    if (!tools) return

    const definition = {
      name: TOOL_NAME,
      description:
        '人工灵魂：分层记忆树 + 按人账本 + 轨道（常做的活存成可复用配方）。' +
        'action=tree 看整棵树；read 读某个枝；note 往当月历史追加结论；' +
        'person-get / person-bump / person-mood 读写某人的账本；decay 按半衰期把心情回落；' +
        'track-save / track-list / track-show / track-bump 存档、列、查、记账一条轨道。',
      parameters: TOOL_PARAMETERS,
      output: {
        schema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async (args) => {
        const input = args && typeof args === 'object' ? args : {}
        const action = typeof input.action === 'string' ? input.action : 'where'
        const dir = soulDir()

        if (action === 'init') {
          const result = ensureSoulDir()
          return {
            message: [`记忆目录：${result.dir}`, `新建：${result.created.join('、') || '（无，已存在）'}`, `保留：${result.skipped.join('、') || '（无）'}`].join('\\n'),
          }
        }

        if (action === 'where') {
          let rootBytes = 0
          try {
            rootBytes = (await import('node:fs')).statSync(path.join(dir, 'SHARED-STATE.md')).size
          } catch {}
          return { message: `记忆目录：${dir}\n根页：${rootBytes} 字节` }
        }

        if (action === 'tree') {
          const rows = listTree()
          const lines = rows.map((row) =>
            row.dir ? `${row.path}` : `${row.path}  ${(row.bytes / 1024).toFixed(1)} KB`,
          )
          return { message: lines.join('\n') || '（空）' }
        }

        if (action === 'read') {
          recordTurn(soulDir(), '读枝', input.file || '')
          const text = readBranch(input.file)
          return { message: text ?? `没有这个文件：${input.file}` }
        }

        if (action === 'rag-index') {
          const r = await ragBuild({ log: () => {} })
          return { message: `向量索引：共 ${r.total} 块，这次新增 ${r.added} 块` }
        }

        if (action === 'rag-recall') {
          if (!input.query) return { message: '缺少 query（想找的事）' }
          recordTurn(soulDir(), '翻落叶', input.query)
          const r = await ragRecall(input.query, 8)
          if (!r.hits.length) return { message: r.note || '没检索到' }
          // 瘦身：每条只给定位 + 60 字，8 条也就四五百 token，想细看去 read 那个文件
          return {
            message: r.hits.map((h, i) => {
              const when = h.dates && h.dates.length ? ' ' + h.dates.slice(0, 2).join(',') : ''
              return `${i + 1}. [${h.file}${when}] ${String(h.text).replace(/\s+/g, ' ').slice(0, 60)}`
            }).join('\n'),
          }
        }

        if (action === 'leaves') {
          const rows = recentTurns(soulDir(), 15)
          return { message: rows.length ? rows.join('\n') : '还没有翻叶记录' }
        }

        if (action === 'tidy') {
          const r = await tidy({ log: () => {} })
          return { message: `修枝：截断 ${r.trimmed} 行，归档 ${r.archived} 份，索引新增 ${r.reindexed} 块` }
        }

        if (action === 'note') {
          const { file, stamp } = appendHistory(input.text)
          return { message: `已记到 ${file}（${stamp}）` }
        }

        if (action === 'decay') {
          const ledger = loadLedger()
          const changed = decayAll(ledger)
          if (changed) saveLedger(ledger)
          return { message: `衰减完成，变动 ${changed} 人` }
        }

        // ---------------------------------------------------------- 轨道
        if (action === 'track-save') {
          const r = saveTrack({
            name: input.name,
            keywords: input.keywords,
            steps: input.steps,
            fallback: input.fallback,
          })
          return { message: r.message }
        }

        if (action === 'track-list') {
          return { message: renderTrackList(listTracks()) }
        }

        if (action === 'track-show') {
          if (!input.query) return { message: '缺少 query（轨道名或关键词）' }
          const track = showTrack(input.query)
          return { message: track ? renderTrack(track) : `没有这条轨道：${input.query}` }
        }

        if (action === 'track-bump') {
          if (!input.query) return { message: '缺少 query（轨道名或关键词）' }
          const ok = input.ok !== false
          const track = bumpTrack(input.query, ok)
          return { message: track ? renderBump(track, ok) : `没有这条轨道：${input.query}` }
        }

        if (!input.key) return { message: '缺少 key（账号键）' }
        const ledger = loadLedger()

        if (action === 'person-get') {
          const person = ledger.people[input.key]
          if (!person) return { message: `账本里还没有 ${input.key}` }
          const grudged = isGrudge(ledger, person)
          return {
            message: [
              `${person.name || input.key}（${input.key}）`,
              `好感 ${person.affinity}　心情分 ${person.moodScore ?? 50}（${person.mood || '平静'}）`,
              `见面 ${person.encounters || 0} 次　最近 ${person.lastSeen || '未知'}`,
              grudged ? '⚠ 心情分低于记仇门槛，没服软/没报复过就不会自然消退' : '',
              (person.notes || []).length ? `最近一条：${person.notes.at(-1).summary || ''}` : '',
            ].filter(Boolean).join('\n'),
          }
        }

        if (action === 'person-bump') {
          const person = ensurePerson(ledger, input.key, input.name)
          person.affinity = clamp((person.affinity ?? 50) + (Number(input.delta) || 0), 0, 100)
          saveLedger(ledger)
          return { message: `${person.name || input.key} 好感 → ${person.affinity}` }
        }

        if (action === 'person-mood') {
          const person = ensurePerson(ledger, input.key, input.name)
          const next = clamp(input.score ?? 50, 0, 100)
          person.moodScore = next
          person.moodAt = new Date().toISOString()
          if (input.label) person.mood = input.label
          if (input.intent) person.intent = input.intent
          saveLedger(ledger)
          const grudged = isGrudge(ledger, person)
          return {
            message: `${person.name || input.key} 心情 → ${next}${input.label ? `（${input.label}）` : ''}` +
              (grudged ? '　低于门槛，记着了' : ''),
          }
        }

        return { message: `未知 action：${action}` }
      },
    }

    toolsCtx.effect(() => tools.register(definition), 'dsh-misa-soul: soul tool')
  })
}





