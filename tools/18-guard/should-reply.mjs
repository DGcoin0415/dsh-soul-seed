import fs from 'node:fs'
import path from 'node:path'

// 接话前的第一道筛子（程序层）：不看内容，只看「该不该开口」。
// 用法：node should-reply.mjs --from qq:1234 --kind group --text "..."
// 退出码：0 该接（或该交给模型判断），2 不接
//   --list 只看规则
import os from 'node:os'
const HOME = sharedHome()
const CONF = path.join(HOME, 'shared', '接话.json')
const LOG = path.join(HOME, 'shared', '接话日志.jsonl')

const args = process.argv.slice(2)
const get = (k) => {
  const i = args.indexOf('--' + k)
  return i >= 0 ? args[i + 1] : undefined
}

const DEFAULT = {
  // 这几个人什么时候都接
  always: ['qq:1042442284', 'master'],
  // 这几个人直接不接
  never: [],
  // 安静时段不主动开口（白名单除外）
  quiet: { from: '00:30', to: '07:30' },
  // 同一个人在这段时间内连发，只当一句（秒）
  mergeSeconds: 60,
  // 每个会话一天最多接多少句
  dailyCap: 40,
  // 群里的陌生人：没 @ 到就不接
  strangersInGroup: 'mention-only',
}

function loadConf() {
  try {
    const raw = fs.readFileSync(CONF, 'utf8').replace(/^\uFEFF/, '')
    return { ...DEFAULT, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT }
  }
}

const conf = loadConf()
if (args.includes('--list')) {
  console.log(JSON.stringify(conf, null, 2))
  process.exit(0)
}

const from = get('from') || ''
const kind = get('kind') || 'group'
const text = get('text') || ''
const now = new Date()
const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

const inQuiet = (() => {
  const { from: qf, to: qt } = conf.quiet || {}
  if (!qf || !qt) return false
  return qf <= qt ? hhmm >= qf && hhmm < qt : hhmm >= qf || hhmm < qt
})()

const verdict = (ok, reason) => {
  try {
    fs.appendFileSync(
      LOG,
      JSON.stringify({ at: now.toISOString(), from, kind, ok, reason, text: text.slice(0, 60) }) + '\n',
      'utf8',
    )
  } catch {}
  console.log(JSON.stringify({ ok, reason }))
  process.exit(ok ? 0 : 2)
}

if (conf.never?.includes(from)) verdict(false, '黑名单')
if (conf.always?.includes(from)) verdict(true, '白名单')

// 私聊陌生人：先说一句，别不理人
if (kind === 'dm' && !conf.always?.includes(from)) {
  if (inQuiet) verdict(false, '安静时段，陌生人先不回')
  // 一天之内同一人已经回过，就交回给模型判断值不值得再答
}

if (inQuiet) verdict(false, '安静时段')
if (kind === 'group' && conf.strangersInGroup === 'mention-only' && !text.includes('@')) {
  verdict(false, '群里没点名')
}

// 合并连发：同一个来源 60 秒内已经有接话记录就等一等
try {
  const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-200)
  const last = [...lines].reverse().find((l) => {
    try {
      const o = JSON.parse(l)
      return o.from === from && o.ok
    } catch {
      return false
    }
  })
  if (last) {
    const o = JSON.parse(last)
    const gap = (now - new Date(o.at)) / 1000
    if (gap < conf.mergeSeconds) verdict(false, `刚接过（${Math.round(gap)} 秒前），并成一句`)
  }
  // 日上限
  const today = now.toISOString().slice(0, 10)
  const todayCount = lines.filter((l) => {
    try {
      const o = JSON.parse(l)
      return o.ok && o.from === from && o.at.startsWith(today)
    } catch {
      return false
    }
  }).length
  if (todayCount >= conf.dailyCap) verdict(false, `今天跟这个会话说满了（${todayCount} 句）`)
} catch {}

verdict(true, '程序层放过，交给模型判断')
