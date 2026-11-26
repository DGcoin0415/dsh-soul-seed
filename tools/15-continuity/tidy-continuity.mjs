#!/usr/bin/env node
// 接续整理：每两小时跑一次。
// 规则（2026-11-20 master 定）：
//   - 没完成的，留在 shared/接续.md，一直挂着（挂超过 24 小时标 ⏰ 陈旧）；
//   - 已完成且超过 2 小时的，从接续里删掉，转成一条结论写进 shared/历史/当月.md（带出处）；
//   - 同一件事的多条合并成一条，时间写时间段；
//   - 结论要能「下次问到就想起来」：做了什么 + 结果/产物 + 出处；
//   - 原文不删，一直在 shared/全量/页/ 里。
//
// 用法：
//   node tidy-continuity.mjs           真跑
//   node tidy-continuity.mjs --dry     只看会怎么动，不写文件
//   node tidy-continuity.mjs --hours 2 改阈值（默认 2 小时）

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { selfName } from '../../lib/selfname.mjs'

const HOME = process.env.SOUL_HOME || path.join(os.homedir(), '.dsh', 'im')
const SHARED = path.join(HOME, 'shared')
const CONT = path.join(SHARED, '接续.md')
const HIST_DIR = path.join(SHARED, '历史')
const LOCK = path.join(HOME, '.shared-lock.json')

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const hi = args.indexOf('--hours')
const HOURS = hi >= 0 ? Number(args[hi + 1]) : 2
const STALE_H = 24
const ARCHIVE_H = 48 // 没完的挂满两天没后文，也转结论归档（2026-11-20 master 定）

const now = new Date()
const nowMs = now.getTime()

const DONE = /(办好了|办完了|完成了|做完了|出完了|发好了|已经.{0,4}(出|发|做|办)|搞定|作废|交付|解决了|已删除|已改好|改好了|试通了|跑通了|装好了|拍完了)/
const TODO = /(还没|尚未|未完成|待办|等着|等 master|等他说|回头|下一步|暂时没|卡在|没起来|失败|报错|要补|准备|明天再|晚点再)/
const NOISE = /(SCHEDULE REMINDER|reminders_json|自动检索|旧记忆参考)/

const monthFile = () => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

function parse() {
  if (!fs.existsSync(CONT)) return []
  const out = []
  for (const line of fs.readFileSync(CONT, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^- (⏰)?\[(\d{2})-(\d{2}) (\d{2}):(\d{2})(?:[–-]\d{2}:\d{2})?\]\s+(.*)$/)
    if (!m) continue
    const [, , mo, dd, hh, mi, rest] = m
    const t = new Date(now.getFullYear(), Number(mo) - 1, Number(dd), Number(hh), Number(mi))
    if (t.getTime() - nowMs > 12 * 3600 * 1000) t.setFullYear(t.getFullYear() - 1)
    const src = (rest.match(/〔(.+?)〕\s*$/) || [])[1] || ''
    const body = rest.replace(/〔.+?〕\s*$/, '').replace(/^〈待核[^〉]*〉\s*/, '').trim()
    out.push({ t, mo, dd, hh, mi, body, src, ageH: (nowMs - t.getTime()) / 3600000 })
  }
  return out
}

const isDone = (e) => (TODO.test(e.body) ? false : DONE.test(e.body))

// 只留结论要用的字：人名压成一个字的标记（米=咱说的，哥=master 说的），去标点
// 名字不写死：从人设卡 / SOUL_SELF_NAME 取，谁用谁的。
const SELF_RE = String(selfName()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SELF_SPEAK = new RegExp('^(' + SELF_RE + '|咱)[:：]')
const SELF_STRIP = new RegExp('^((' + SELF_RE + ')|咱|master|哥)[:：]\\s*', 'i')

function core(s) {
  let tag = ''
  if (SELF_SPEAK.test(s)) tag = '米'
  else if (/^(master|哥)[:：]/i.test(s)) tag = '哥'
  const body = s
    .replace(SELF_STRIP, '')
    .replace(/[，。、；：！？,.;:!?（）()【】\[\]「」“”\s]/g, '')
  return tag ? `${tag}·${body}` : body
}

// 两句话像不像在说同一件事
function sim(a, b) {
  const A = core(a)
  const B = core(b)
  if (!A || !B) return 0
  if (A === B) return 1
  const grams = (s) => {
    const set = new Set()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const ga = grams(A)
  const gb = grams(B)
  let hit = 0
  for (const g of ga) if (gb.has(g)) hit++
  return hit / Math.min(ga.size, gb.size)
}

function oneLine(s, max = 90) {
  const t = s.replace(/\s+/g, ' ').replace(/。$/, '').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

// 1. 读 + 去噪
let entries = parse().filter((e) => !NOISE.test(e.body))
if (!entries.length) {
  console.log('接续是空的或者格式对不上，啥也没动')
  process.exit(0)
}
entries.sort((a, b) => a.t - b.t)

// 2. 同一件事合并
const merged = []
for (const e of entries) {
  const last = merged[merged.length - 1]
  if (last && last.dd === e.dd && sim(last.body, e.body) >= 0.55) {
    last.body = e.body // 用最新的说法
    last.t2 = e.t
    last.src = e.src || last.src
    last.hits = (last.hits || 1) + 1
    continue
  }
  merged.push({ ...e, t2: e.t, hits: 1 })
}

// 3. 分类（完成的先挂「待核」，过一轮没人反对才真的归档 —— 2026-11-20 master 定）
const PENDING = path.join(HOME, '.tidy-pending.json')
let pending = {}
try {
  if (fs.existsSync(PENDING)) pending = JSON.parse(fs.readFileSync(PENDING, 'utf8'))
} catch {}
const pkey = (e) => core(e.body).slice(0, 20)

const keep = []
const finish = []
const nextPending = {}
for (const e of merged) {
  const lastAt = e.t2 ? e.t2.getTime() : e.t.getTime()
  const idleH = (nowMs - lastAt) / 3600000
  const k = pkey(e)
  if (isDone(e) && e.ageH >= HOURS) {
    const since = pending[k]
    if (since && nowMs - since >= HOURS * 3600000) {
      finish.push({ ...e, why: 'done' }) // 挂满一轮没人反对 → 归档
    } else {
      nextPending[k] = since || nowMs // 第一次见到 → 挂待核
      keep.push({ ...e, pendingSince: nextPending[k] })
    }
  } else if (!isDone(e) && idleH >= ARCHIVE_H) {
    finish.push({ ...e, why: 'idle' }) // 两天没后文，搁置归档
  } else {
    keep.push(e)
  }
}
if (!DRY) {
  try { fs.writeFileSync(PENDING, JSON.stringify(nextPending, null, 2)) } catch {}
}
keep.sort((a, b) => {
  const da = isDone(a) ? 1 : 0
  const db = isDone(b) ? 1 : 0
  if (da !== db) return da - db
  return a.t - b.t
})

const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

console.log(`接续 ${entries.length} 条 → 合并成 ${merged.length} 条；归档 ${finish.length} 条，留 ${keep.length} 条（其中待核 ${keep.filter((e) => e.pendingSince).length} 条）`)
for (const e of finish) console.log('  归档 → ' + (e.why === 'idle' ? '（两天没后文）' : '') + oneLine(core(e.body), 60))
for (const e of keep) console.log(`  ${e.pendingSince ? '待核' : '留着'} ← ${oneLine(core(e.body), 60)}`)

if (DRY) {
  console.log('\n--dry：没写文件')
  process.exit(0)
}

// 4. 拿锁 → 写历史 → 重写接续
function acquire() {
  try {
    if (fs.existsSync(LOCK)) {
      const j = JSON.parse(fs.readFileSync(LOCK, 'utf8'))
      if (Date.now() - new Date(j.at).getTime() < 15 * 60 * 1000) return false
    }
  } catch {}
  fs.writeFileSync(LOCK, JSON.stringify({ tag: 'tidy-continuity', at: new Date().toISOString() }))
  return true
}
const release = () => { try { fs.unlinkSync(LOCK) } catch {} }

if (!acquire()) {
  console.log('共享锁被别人拿着，这轮跳过')
  process.exit(0)
}

try {
  if (finish.length) {
    fs.mkdirSync(HIST_DIR, { recursive: true })
    const f = path.join(HIST_DIR, `${monthFile()}.md`)
    let text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : `# ${monthFile()} 定下的事\n\n`
    const add = finish
      .map((e) => {
        const tag = e.why === 'idle' ? '（两天没后文，搁置）' : ''
        return `- ${today} [结论] ${oneLine(core(e.body), 150)}${tag}｜出处：${e.src || '接续'}`
      })
      .join('\n')
    fs.writeFileSync(f, text.replace(/\s*$/, '\n') + add + '\n')
    console.log(`写进 ${path.basename(f)}：${finish.length} 条`)
  }

  const fmt = (e) => {
    const stale = !isDone(e) && e.ageH >= STALE_H && !e.pendingSince ? '⏰' : ''
    const pend = e.pendingSince ? `〈待核 ${new Date(e.pendingSince).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 起〉` : ''
    const span = e.t2 && e.t2.getTime() - e.t.getTime() > 60000
      ? `${e.hh}:${e.mi}–${String(e.t2.getHours()).padStart(2, '0')}:${String(e.t2.getMinutes()).padStart(2, '0')}`
      : `${e.hh}:${e.mi}`
    return `- ${stale}[${e.mo}-${e.dd} ${span}] ${pend}${e.body} 〔${e.src}〕`
  }
  const unfinished = keep.filter((e) => !isDone(e))
  const doneRecent = keep.filter((e) => isDone(e))
  const out = [
    `# 接续 · 没完的 + 最近 ${HOURS} 小时`,
    '',
    `> 整理于 ${now.toLocaleString('zh-CN')}（tidy-continuity.mjs，每 2 小时一次）`,
    `> 没完的一直挂着，⏰ 表示挂超过 ${STALE_H} 小时；做完的先挂〈待核〉，满 ${HOURS} 小时没人反对才归档；挂满 ${ARCHIVE_H} 小时没后文的直接归档。结论都写进 shared/历史/。原文在 shared/全量/页/。`,
    '',
    '## 没完的',
    '',
    unfinished.length ? unfinished.map(fmt).join('\n') : '- （没有）',
    '',
    `## 刚完成（未满 ${HOURS} 小时）`,
    '',
    doneRecent.length ? doneRecent.map(fmt).join('\n') : '- （没有）',
    '',
  ].join('\n')
  fs.writeFileSync(CONT, out)
  console.log('接续已重写')
} finally {
  release()
}
