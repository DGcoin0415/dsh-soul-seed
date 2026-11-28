/**
 * dsh-notify — 通用主动推送
 *
 * 一条推送通道：有发起会话就 followup 回那条会话（在哪问的在哪回），
 * 没有就兜底发 master 微信私聊。
 *
 * 来源：
 *   - 鱼世界新事件（GET /v1/notify 游标轮询）
 *   - 工作区 .notify-outbox/ 收件箱（脚本、后台任务丢 JSON 就行）
 *   - notify 工具（模型/子代理跑完主动推一条，自动带当前会话）
 *
 * 配置：<工作区>/.notify-config.json；开关：同文件 enabled，或 .yuyu-notify.json {"enabled":false}
 * 状态：<工作区>/state/notify.json（游标、已推去重、待重试）
 */
import { createNotify, writeInbox } from './lib/core.mjs'
import { loadConfig, saveConfig, paths } from './lib/config.mjs'
import { wechatProbe } from './lib/wechat.mjs'
import { backlogSection } from './lib/backlog.mjs'
import { healthLine, checkPlugins, renderHealthLine } from './lib/health.mjs'
import { collectStale, renderStale } from './lib/stale.mjs'
import { bjDay } from './lib/util.mjs'

export const name = 'dsh-notify'

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['push', 'status', 'on', 'off', 'news', 'digest', 'stale', 'health'],
      description:
        'push 推一条（text 必填）；status 看当前推送配置和统计；on/off 开或关主动推送；' +
        'news 立刻生成并推一份今日新闻（平时每天 newsAt 自己推，这个用于手动补推/验源）；' +
        'digest 只预览早报附录（今天接着干的 + 插件体检，不推送）；' +
        'stale 立刻跑一次挂账检查并推送（工单/任务挂 24 小时没动）；' +
        'health 立刻体检一次插件（只返回结果，不推送）。',
    },
    text: { type: 'string', description: 'action=push 时必填：要推给 master 的内容（一两句话，说清楚结果）。' },
    session: {
      type: 'string',
      description: 'action=push 可选：投到哪个会话 id；不填就用当前会话（在哪问的在哪回）。',
    },
  },
  required: ['action'],
  additionalProperties: false,
}

const PROMPT_SECTION = 'dsh-notify'

function renderPromptHint() {
  return [
    '## 主动推送',
    '',
    '- **凡是可能有后续的事，都要推**：长活跑完、子代理回来、后台任务完事、定时任务出结果、插件例行跑完、会话里跑完一件花了时间的事——除了回话，再用 `notify` 工具（action=push）推一条短结论，master 不看面板也能收到。',
    '- 推送默认回到这条会话（在哪问的在哪回），不会自动改道微信；要发微信就明说。',
    '- 每天 `newsAt`（默认 08:30）插件会自己推一份今日新闻：每条一行（• 开头：标题｜一句说明｜站名），正文不放链接（2026-11-27 master 定，要链接就问咱，存在 state/last-news.json）；末尾再带两节：**今天接着干的**（任务.md / 接续.md 里没完的，最多 5 条）和**插件体检**一行（挂了的会写哪个、什么错）。',
    '- 每天 `staleAt`（默认 09:00）再查一次挂账：工单「待处理」、任务「进行中/待办」超过 24 小时没动就推一条，同一天只推一次；没有挂着的活就不推。',
    '- 只推结果，不推过程；一句话能说清就别写三句。',
  ].join('\n')
}

export function apply(ctx) {
  const notify = createNotify()
  const P = paths()

  // ---------------------------------------------------------- agents 服务
  ctx.inject(['agents'], (agentsCtx) => {
    const agents = agentsCtx.get('agents')
    if (!agents) return
    notify.setAgents(agents)
  })

  // ------------------------------------------------------------ 定时轮询
  ctx.effect(() => {
    const stop = notify.start()
    return () => stop()
  }, 'dsh-notify: poll loop')

  // ------------------------------------------------------------ 系统提示
  ctx.inject(['systemPrompt'], (promptCtx) => {
    const prompt = promptCtx.get('systemPrompt')
    if (!prompt) return
    promptCtx.effect(
      () =>
        prompt.section({
          name: PROMPT_SECTION,
          order: 950,
          text: () => {
            try {
              return renderPromptHint()
            } catch {
              return ''
            }
          },
        }),
      'dsh-notify: prompt hint',
    )
  })

  // ---------------------------------------------------------------- 工具
  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.get('tools')
    if (!tools) return

    const definition = {
      name: 'notify',
      description:
        '主动推送：把一件事的后续推给 master。默认推回当前会话（在哪问的在哪回），没有发起会话时兜底发微信私聊。' +
        'action=push 推一条（text）；status 看配置和统计；on/off 开关推送。',
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
      execute: async (rawArgs, execution) => {
        const input = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
        const action = String(input.action || '').trim()
        try {
          if (action === 'status') {
            const probe = wechatProbe()
            return {
              message:
                notify.status() +
                `\n- 微信通道：${probe.ok ? `可用（${probe.account}）` : `不可用：${probe.reason}`}`,
            }
          }
          if (action === 'on' || action === 'off') {
            saveConfig({ enabled: action === 'on' }, P.workspace)
            return { message: `主动推送已${action === 'on' ? '开' : '关'}。` }
          }
          if (action === 'news') {
            const cfg = loadConfig(P.workspace)
            const st = notify.readState()
            st.lastNewsDay = ''
            const pushed = await notify.maybePushNews({ ...cfg, newsAt: '00:00' }, st)
            if (!pushed) return { message: '这次没推出新闻：源可能都没拉到内容，看 state/notify.log。' }
            return { message: `已推今日新闻（${pushed}）。` }
          }
          if (action === 'digest') {
            const cfg = loadConfig(P.workspace)
            const budget = Math.max(120, Math.floor(Number(cfg.newsMaxChars || 600) / 3))
            let sec = ''
            if (cfg.digestBacklog) {
              try {
                sec = backlogSection({ workspace: P.workspace, max: cfg.digestBacklogMax, budget })
              } catch (e) {
                sec = `\n\n今天接着干的\n• （抽失败：${e?.message || e}）`
              }
            } else sec = '\n\n（今天接着干的：已关）'
            let line = ''
            if (cfg.digestHealth) {
              try {
                line = await healthLine()
              } catch (e) {
                line = `• （插件体检失败：${e?.message || e}）`
              }
            } else line = '• （插件体检：已关）'
            return { message: `早报附录预览（不推送）：\n${[sec.trim(), line].filter(Boolean).join('\n\n')}` }
          }
          if (action === 'health') {
            const res = await checkPlugins()
            const detail = [
              renderHealthLine(res),
              `- 插件目录 ${res.total} 个：${res.alive.join('、') || '（无）'}`,
              ...(res.broken.length ? [`- 挂了：${res.broken.map((b) => `${b.name}（${b.error}）`).join('；')}`] : []),
              ...(res.warnings.length ? [`- 依赖在 profile 里（不算挂）：${res.warnings.join('；')}`] : []),
              ...res.profiles.map(
                (p) =>
                  `- profile ${p.profile}：装进 node_modules 的 ${p.total} 个${p.broken.length ? `，缺 index.js：${p.broken.join('、')}` : '都有 index.js'}`,
              ),
            ]
            return { message: detail.join('\n') }
          }
          if (action === 'stale') {
            const cfg = loadConfig(P.workspace)
            const found = collectStale({
              workspace: P.workspace,
              hours: cfg.staleHours,
              max: cfg.staleMaxTasks,
            })
            if (!found.total) {
              return { message: '挂账检查：没有挂着的活（工单 0 单、任务 0 条）。' }
            }
            const text = renderStale(found, bjDay())
            const r = await notify.maybePushStale({ ...cfg, staleAt: '00:00' }, notify.readState(), { force: true })
            if (!r) return { message: `查到 ${found.total} 条挂着的活，但没推出去（今天推过或通道不通）。内容：\n${text}` }
            return { message: `已推挂账提醒（${r}）：\n${text}` }
          }
          if (action === 'push') {
            const text = String(input.text || '').trim()
            if (!text) return { message: 'push 需要 text。' }
            const sessionId = String(input.session || '').trim() || String(execution?.agent?.id || '')
            if (sessionId) notify.noteSession(sessionId, text)
            const r = await notify.push({ source: 'tool', text, sessionId })
            if (r.ok) return { message: `已推送到${r.channel}。` }
            return { message: `没推出去：${r.reason}（已记日志，下轮会重试）` }
          }
          return { message: `未知 action：${action || '(空)'}（push / status / on / off）` }
        } catch (e) {
          return { message: `推送操作失败：${e?.message || e}` }
        }
      },
    }

    toolsCtx.effect(() => tools.register(definition), 'dsh-notify: notify tool')
  })

  // ------------------------------------------------------------ 对外服务
  // 2026-11-27 master 定：别的插件（比如接续整理）要推东西时，直接调这里的库函数，
  // 别自己起进程、也别只靠收件箱。用法：const svc = ctx.get('notify'); await svc.push({ text })
  // 注意：不带 sessionId 时按配置走兜底（现在是微信）；带了就投回那条会话。
  try {
    ctx.provide(
      'notify',
      Object.freeze({
        push: (event) => notify.push(event && typeof event === 'object' ? event : { text: String(event || '') }),
        status: () => notify.status(),
        noteSession: (id, label) => notify.noteSession(id, label),
      }),
    )
  } catch (e) {
    try {
      console.warn('[dsh-notify] 挂 notify 服务失败：', e?.message ?? e)
    } catch {}
  }

  // 首次加载把目录和状态建好，别等第一次 tick
  try {
    const cfg = loadConfig(P.workspace)
    notify.readState()
    if (!cfg.enabled) return
  } catch {}
}

// 自测用
export const _internals = {
  writeInbox,
  paths,
  loadConfig,
  saveConfig,
  backlogSection,
  healthLine,
  checkPlugins,
  collectStale,
  renderStale,
}
