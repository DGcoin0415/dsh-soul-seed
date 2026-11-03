/**
 * dsh-tool-gate — 工具分组 + 按需开放。
 *
 * 平时模型只看得到「常驻」工具，其余按组藏起来，连定义都不发；
 * 需要时调 tool_gate 开一组，这组工具立刻可用，管整个会话。
 *
 * 配置在 ~/.dsh/im/tool-groups.json：
 *   { "keep": ["常驻工具名..."], "groups": { "组名": ["工具名..."] } }
 * 没写进任何组的工具保持原样，不动它，免得漏配把工具弄没。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-tool-gate'

const CONFIG = path.join(os.homedir(), '.dsh', 'im', 'tool-groups.json')
const GATE = 'tool_gate'

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, '')
    const json = JSON.parse(raw)
    return { keep: json.keep || [], groups: json.groups || {}, trim: json.trim || null }
  } catch {
    return { keep: [], groups: {}, trim: null }
  }
}

// 压参数说明：字段名、类型、必填都留着，只把每个字段的说明砍短。
// 递归处理 properties / items，别的键原样不动。
function shrink(node, cfg, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return node
  const limit = Number(cfg.paramDesc || 0)
  if (!limit) return node
  const out = Array.isArray(node) ? [] : {}
  for (const [k, v] of Object.entries(node)) {
    if (k === 'description' && typeof v === 'string') {
      out[k] = v.length <= limit ? v : v.slice(0, limit) + '…'
      continue
    }
    if (k === 'properties' && v && typeof v === 'object') {
      const props = {}
      for (const [pk, pv] of Object.entries(v)) {
        // 必填字段的说明给宽一点，避免用错
        props[pk] = shrink(pv, cfg, depth + 1)
      }
      out[k] = props
      continue
    }
    out[k] = v && typeof v === 'object' ? shrink(v, cfg, depth + 1) : v
  }
  return out
}

// 一个工具：顶上加一句短的（可选），参数按上面压
function shrinkTool(tool, cfg) {
  const next = { ...tool }
  if (cfg.toolDesc && typeof tool.description === 'string') {
    const full = new Set((cfg.fullDesc || []).map((x) => String(x).toLowerCase()))
    if (!full.has(String(tool.name).toLowerCase())) {
      const limit = Number(cfg.toolDesc)
      next.description = tool.description.length <= limit ? tool.description : tool.description.slice(0, limit) + '…'
    }
  }
  next.parameters = shrink(tool.parameters, cfg)
  return next
}

export function apply(ctx) {
  // agent -> 已开的组（小写）
  const opened = new Map()

  const openSet = (agent) => {
    let s = opened.get(agent)
    if (!s) {
      s = new Set()
      opened.set(agent, s)
    }
    return s
  }

  // 当前该藏哪些工具：在组里、组没开、又不在 keep 里
  function hiddenFor(agent) {
    const { keep, groups } = readConfig()
    const keepSet = new Set(keep.map((x) => String(x).toLowerCase()))
    const open = openSet(agent)
    const hidden = new Set()
    for (const [group, names] of Object.entries(groups)) {
      if (open.has(group.toLowerCase())) continue
      for (const tool of names) {
        const low = String(tool).toLowerCase()
        if (!keepSet.has(low) && low !== GATE) hidden.add(tool)
      }
    }
    return hidden
  }

  // 目录给模型看：每组有哪些工具、开没开
  function catalog(agent) {
    const { groups } = readConfig()
    const open = openSet(agent)
    return Object.entries(groups).map(([group, tools]) => ({
      group,
      open: open.has(group.toLowerCase()),
      count: tools.length,
      tools,
    }))
  }

  // ---- 注册 tool_gate ----
  ctx.inject(['tools'], (c) => {
    const tools = c.get('tools')
    if (!tools) return
    c.effect(() =>
      tools.register({
        name: GATE,
        description:
          '按需开工具组。不带参数=看有哪些组和每组里有什么；action=open + group=组名 打开整组（本会话一直有效）；action=close 收回。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'open', 'close'], description: '默认 list' },
            group: { type: 'string', description: '组名，open / close 必填' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        execute: async (args, exec) => {
          const agent = exec?.agent
          const catalogRows = agent ? catalog(agent) : []
          const action = args?.action || 'list'
          if (action === 'list' || !args?.group) {
            const lines = catalogRows.map(
              (r) => `${r.open ? '● 已开' : '○ 未开'} ${r.group}（${r.count} 个）：${r.tools.join('、')}`
            )
            return { text: lines.length ? lines.join('\n') : '没配任何工具组' }
          }
          const wanted = String(args.group).toLowerCase()
          const hit = catalogRows.find((r) => r.group.toLowerCase() === wanted)
          if (!hit) {
            return { text: `没有这个组：${args.group}。现有：${catalogRows.map((r) => r.group).join('、')}` }
          }
          const open = openSet(agent)
          if (action === 'open') {
            open.add(wanted)
            return { text: `已开「${hit.group}」：${hit.tools.join('、')}。下一条消息起就能用。` }
          }
          if (action === 'close') {
            open.delete(wanted)
            return { text: `已收回「${hit.group}」` }
          }
          return { text: `不认识的 action：${action}` }
        },
      })
    )
  })

  // ---- 每个 agent 装一层过滤 ----
  function install(agent) {
    const scoped = agent.ctx.get('tools')
    if (!scoped || typeof agent.ctx.on !== 'function') return

    // 拦执行：藏起来的工具被调用就提示先开组
    scoped.guard?.((execution) => {
      if (!hiddenFor(agent).has(execution.name)) return undefined
      const { groups } = readConfig()
      const group = Object.keys(groups).find((g) =>
        groups[g].some((t) => String(t).toLowerCase() === String(execution.name).toLowerCase())
      )
      return `工具 ${execution.name} 在未打开的组「${group}」里，先调 ${GATE}({"action":"open","group":"${group}"})`
    })

    // 拦组装：把藏起来的工具定义从这一轮的提示里摘掉
    agent.ctx.on('system-prompt/assemble', async (...args) => {
      const next = args[args.length - 1]
      if (typeof next !== 'function') return args[0]
      const assembly = await next()
      if (!assembly || !Array.isArray(assembly.tools)) return assembly
      const hidden = hiddenFor(agent)
      if (hidden.size === 0) return assembly
      const { trim } = readConfig()
      const visible = assembly.tools.filter((t) => !hidden.has(t.name))
      return {
        ...assembly,
        tools: trim ? visible.map((t) => shrinkTool(t, trim)) : visible,
        sections: Array.isArray(assembly.sections)
          ? assembly.sections.filter((s) => {
              const n = typeof s?.name === 'string' && s.name.startsWith('tool:') ? s.name.slice(5) : undefined
              return n === undefined || !hidden.has(n)
            })
          : assembly.sections,
      }
    })
  }

  ctx.inject(['agents'], (c) => {
    const agents = c.get('agents')
    for (const agent of agents?.list?.() ?? []) install(agent)
    c.on('agent/created', (...args) => {
      const agent = args[0]?.agent ?? args[0]
      if (agent?.ctx) install(agent)
    })
    c.on('agent/disposed', (...args) => {
      const agent = args[0]?.agent ?? args[0]
      if (agent) opened.delete(agent)
    })
  })
}
