// rules.mjs —— 规则注入 / 功能清单 / 推荐插件的开关，根页 RULES、PLUGINS 两个标记块由它维护
// 用法：
//   node rules.mjs list                          看三组开关 + 根页现在注入了什么
//   node rules.mjs show                          打印会被注入根页的那两段
//   node rules.mjs set 省钱=off 语音=on           按名字改（一次可多个，三组一起查）
//   node rules.mjs all  [rules|features|plugins] 全开（默认三组都开）
//   node rules.mjs none [rules|features|plugins] 全关（默认三组都关）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const SWITCH_FILE = path.join(ROOT, 'shared', '规则开关.json')
const ROOT_PAGE = path.join(ROOT, 'SHARED-STATE.md')

const RULES_BEGIN = '<!-- RULES:BEGIN 由 node rules.mjs 维护，别手改 -->'
const RULES_END = '<!-- RULES:END -->'
const PLUGINS_BEGIN = '<!-- PLUGINS:BEGIN 由 node rules.mjs 维护，别手改 -->'
const PLUGINS_END = '<!-- PLUGINS:END -->'

// 九类规矩，一行一句话，顺序就是根页里的顺序
const RULES = [
  { name: '省钱', line: '到 60% 写交接、本地能做的别调模型、估价超两毛就停' },
  { name: '省时间', line: '长活开后台、能派就派、重复的活补轨道' },
  { name: '别弄坏', line: '原子写、写失败重试、空转检查、不自己重启 DSH' },
  { name: '别泄露', line: '打包不带数据、密钥只放本地、不报余额路径行踪' },
  { name: '别忘事', line: '根页注入、12 小时分页、检索走证据链' },
  { name: '能收到', line: 'QQ 只收 @/引用、微信走桥、语音只走 `say.mjs`' },
  { name: '会说话', line: '自称「咱」、不用方言、群里被动接、说错就认' },
  { name: '会干活', line: '先问要不要全部接管、按渠道继承、60% 交接' },
  { name: '会出活', line: '生图两条路、office 出文档、出完记一笔' },
]

// 功能八项，只在开关表里，不注入根页
const FEATURES = ['生图', '语音', '消息渠道', '文档', '图片编辑', 'OCR', '渔世界', '表情包']

// 推荐插件：一行一条，跟着根页 PLUGINS 块走
const PLUGINS = [
  { name: 'save-token', line: '结构化压缩 + 溢出落盘，直接砍每轮 token' },
  { name: 'tool-gate', line: '工具按组藏、按需开，省每轮工具定义' },
  { name: 'compact-self', line: '会话到 60% 起每 5% 重写交接，不调模型不花钱' },
  { name: 'unlag', line: '点一下应用插件改动、救回卡住的界面，不重启' },
  { name: 'qwen-paint', line: '本地 Qwen-Image 出图改图，零 API 费、不走网' },
  { name: 'say', line: '本地语音播报' },
  { name: 'dsh-im', line: 'QQ / 微信收发' },
  { name: 'misa-soul', line: '灵魂本体（根页注入、记忆树、账本）' },
]

const GROUPS = [
  { key: 'rules', label: '规则', names: RULES.map(r => r.name) },
  { key: 'features', label: '功能', names: FEATURES },
  { key: 'plugins', label: '插件', names: PLUGINS.map(p => p.name) },
]

const USAGE = [
  '用法：',
  '  node rules.mjs list                          看规则 / 功能 / 插件的开关',
  '  node rules.mjs show                          打印注入根页的那两段',
  '  node rules.mjs set 省钱=off 语音=on          按名字改，一次可多个',
  '  node rules.mjs all  [rules|features|plugins] 全开（默认三组都开）',
  '  node rules.mjs none [rules|features|plugins] 全关（默认三组都关）',
].join('\n')

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

function defaults() {
  const state = { rules: {}, features: {}, plugins: {}, askOnFirstRun: true, updated: new Date().toISOString() }
  for (const r of RULES) state.rules[r.name] = true
  for (const f of FEATURES) state.features[f] = true
  for (const p of PLUGINS) state.plugins[p.name] = true
  return state
}

function readState() {
  if (!fs.existsSync(SWITCH_FILE)) return defaults()
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(SWITCH_FILE, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    fail(`开关文件读不了：${SWITCH_FILE}\n${e.message}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`开关文件格式不对：${SWITCH_FILE}`)
  const state = {
    rules: {},
    features: {},
    plugins: {},
    askOnFirstRun: raw.askOnFirstRun !== false,
    updated: typeof raw.updated === 'string' ? raw.updated : new Date().toISOString(),
  }
  // 缺的项按「开」补，写死的 false 才算关
  for (const r of RULES) state.rules[r.name] = raw.rules?.[r.name] !== false
  for (const f of FEATURES) state.features[f] = raw.features?.[f] !== false
  for (const p of PLUGINS) state.plugins[p.name] = raw.plugins?.[p.name] !== false
  return state
}

function sleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* 不支持就跳过等待 */ }
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, 'utf8')
  try {
    // 先写临时再换名；Windows 上换名可能被占用挡一下，挡了就重试三次
    for (let i = 0; i < 3; i++) {
      try {
        fs.renameSync(tmp, file)
        return
      } catch (e) {
        if (i === 2) throw e
        sleep(80 * (i + 1))
      }
    }
  } catch {
    // 换名一直被占，退一步直接覆盖写，别让命令半路失败
    fs.writeFileSync(file, text, 'utf8')
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* 已经换名走掉了，没临时文件 */ }
  }
}

function saveState(state) {
  state.updated = new Date().toISOString()
  atomicWrite(SWITCH_FILE, JSON.stringify(state, null, 2) + '\n')
}

function ruleBlock(state) {
  const lines = [RULES_BEGIN]
  let n = 0
  for (const r of RULES) if (state.rules[r.name]) lines.push(`${++n}. **${r.name}** — ${r.line}`)
  lines.push(RULES_END)
  return lines.join('\n')
}

function pluginBlock(state) {
  const lines = [PLUGINS_BEGIN]
  for (const p of PLUGINS) if (state.plugins[p.name]) lines.push(`- ${p.name} — ${p.line}`)
  lines.push(PLUGINS_END)
  return lines.join('\n')
}

function enabledNames(state, key) {
  return GROUPS.find(g => g.key === key).names.filter(n => state[key][n])
}

function replaceBlock(text, begin, end, block) {
  const b = text.indexOf(begin)
  const e = text.indexOf(end)
  if (b < 0 || e < 0 || e < b) {
    throw new Error(`根页里找不到标记块：${begin} … ${end}`)
  }
  return text.slice(0, b) + block + text.slice(e + end.length)
}

function rewritePage(state) {
  let text = fs.readFileSync(ROOT_PAGE, 'utf8')
  text = replaceBlock(text, RULES_BEGIN, RULES_END, ruleBlock(state))
  text = replaceBlock(text, PLUGINS_BEGIN, PLUGINS_END, pluginBlock(state))
  atomicWrite(ROOT_PAGE, text)
}

function pageBlocks() {
  let text = ''
  try { text = fs.readFileSync(ROOT_PAGE, 'utf8') } catch { return { rules: null, plugins: null } }
  const grab = (begin, end) => {
    const b = text.indexOf(begin)
    const e = text.indexOf(end)
    if (b < 0 || e < 0 || e < b) return null
    return text.slice(b, e + end.length)
  }
  return { rules: grab(RULES_BEGIN, RULES_END), plugins: grab(PLUGINS_BEGIN, PLUGINS_END) }
}

function mark(ok) {
  return ok ? '✔' : '✘'
}

function cmdList() {
  const state = readState()
  for (const g of GROUPS) {
    const on = enabledNames(state, g.key).length
    console.log(`${g.label}（${on}/${g.names.length} 开）`)
    for (const n of g.names) console.log(`  ${mark(state[g.key][n])} ${n}`)
    console.log('')
  }

  const page = pageBlocks()
  if (page.rules === null) {
    console.log('根页：找不到 RULES 标记块')
  } else {
    const inPage = RULES.filter(r => page.rules.includes(`**${r.name}**`)).map(r => r.name)
    console.log(`根页当前注入：${inPage.length} 类（${inPage.join('、') || '无'}）`)
    if (inPage.join(',') !== enabledNames(state, 'rules').join(',')) {
      console.log('注意：开关文件和根页不一致，跑一次 node rules.mjs set 类名=on|off 会把根页重写回来')
    }
  }
  if (page.plugins === null) {
    console.log('根页：找不到 PLUGINS 标记块')
  } else {
    const inPage = PLUGINS.filter(p => page.plugins.includes(`- ${p.name} —`)).map(p => p.name)
    console.log(`根页当前列插件：${inPage.length} 个（${inPage.join('、') || '无'}）`)
    if (inPage.join(',') !== enabledNames(state, 'plugins').join(',')) {
      console.log('注意：插件开关和根页不一致，跑一次 node rules.mjs set 名字=on|off 会把根页重写回来')
    }
  }
}

function cmdShow() {
  const state = readState()
  console.log(ruleBlock(state))
  console.log('')
  console.log(pluginBlock(state))
}

function parseValue(v) {
  const s = String(v).trim().toLowerCase()
  if (['on', 'true', '1', 'yes', '开'].includes(s)) return true
  if (['off', 'false', '0', 'no', '关'].includes(s)) return false
  return null
}

function findGroup(name) {
  for (const g of GROUPS) if (g.names.includes(name)) return g.key
  return null
}

function cmdSet(args) {
  if (!args.length) fail(`set 得给 名字=on|off\n\n${USAGE}`)
  const state = readState()
  const changes = []
  for (const arg of args) {
    const i = arg.indexOf('=')
    if (i <= 0) fail(`看不懂「${arg}」，要写成 名字=on 或 名字=off\n\n${USAGE}`)
    const name = arg.slice(0, i).trim()
    const value = parseValue(arg.slice(i + 1))
    if (value === null) fail(`「${arg}」的值只认 on / off\n\n${USAGE}`)
    const key = findGroup(name)
    if (!key) {
      fail(`没有叫「${name}」的规则 / 功能 / 插件。\n规则：${GROUPS[0].names.join('、')}\n功能：${GROUPS[1].names.join('、')}\n插件：${GROUPS[2].names.join('、')}`)
    }
    state[key][name] = value
    changes.push(`${name} → ${value ? '开' : '关'}`)
  }
  saveState(state)
  rewritePage(state)
  console.log(changes.join('\n'))
  console.log(`已更新，根页现在注入 ${enabledNames(state, 'rules').length} 类，列 ${enabledNames(state, 'plugins').length} 个插件`)
}

function cmdBulk(on, args) {
  if (args.length > 1) fail(`${on ? 'all' : 'none'} 后面最多跟一个范围\n\n${USAGE}`)
  const scope = args[0]
  const keys = ['rules', 'features', 'plugins']
  if (scope && !keys.includes(scope)) fail(`范围只认 rules / features / plugins，不认识「${scope}」\n\n${USAGE}`)
  const targets = scope ? [scope] : keys

  const state = readState()
  for (const key of targets) for (const n of GROUPS.find(g => g.key === key).names) state[key][n] = on
  saveState(state)
  rewritePage(state)

  const bits = targets.map(key => {
    const g = GROUPS.find(x => x.key === key)
    return `${g.label}${on ? '全开' : '全关'}（${g.names.length}）`
  })
  console.log(bits.join('，'))
  console.log(`已更新，根页现在注入 ${enabledNames(state, 'rules').length} 类，列 ${enabledNames(state, 'plugins').length} 个插件`)
}

function main() {
  const [, , cmd, ...rest] = process.argv
  try {
    if (!cmd || cmd === 'list') return cmdList()
    if (cmd === 'show') return cmdShow()
    if (cmd === 'set') return cmdSet(rest)
    if (cmd === 'all') return cmdBulk(true, rest)
    if (cmd === 'none') return cmdBulk(false, rest)
    if (cmd === 'help' || cmd === '-h' || cmd === '--help') { console.log(USAGE); return }
    fail(`不认识的参数「${cmd}」\n\n${USAGE}`)
  } catch (e) {
    fail(`出错了：${e.message}`)
  }
}

main()
