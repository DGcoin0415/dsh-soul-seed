#!/usr/bin/env node
// 跨会话扫描（可开关）：把最近一段时间里其他会话/渠道说过的话聚成一页 shared/跨会话.md，
// 让新开的会话一眼看到「别的会话刚才在聊什么」，不用自己去翻几十页实时记录。
//
// 开关：shared/跨会话.json  {"enabled": true, "hours": 12, "max": 40}
//   - 文件不存在、或 enabled 不是 true → 不扫，直接退出（默认关）
// 用法：
//   node cross-session.mjs          按开关来（关着就什么都不做）
//   node cross-session.mjs --force  这次强制扫（不看开关）
//   node cross-session.mjs --status 只看开没开
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.SOUL_HOME || path.join(os.homedir(), '.dsh', 'im')
const SHARED = path.join(HOME, 'shared')
const CFG = path.join(SHARED, '跨会话.json')
const OUT = path.join(SHARED, '跨会话.md')
const REALTIME = path.join(SHARED, '实时')
const CONT = path.join(SHARED, '接续.md')

const force = process.argv.includes('--force')
const statusOnly = process.argv.includes('--status')

function readCfg() {
  try {
    const j = JSON.parse(fs.readFileSync(CFG, 'utf8'))
    return { enabled: j.enabled === true, hours: Number(j.hours) > 0 ? Number(j.hours) : 12, max: Number(j.max) > 0 ? Number(j.max) : 40 }
  } catch {
    return { enabled: false, hours: 12, max: 40 }
  }
}

const cfg = readCfg()
if (statusOnly) {
  console.log(`跨会话扫描：${cfg.enabled ? '开' : '关'}（窗口 ${cfg.hours} 小时，最多 ${cfg.max} 条）`)
  process.exit(0)
}
if (!cfg.enabled && !force) {
  console.log('跨会话扫描：关（要开就在 shared/跨会话.json 里写 {"enabled": true}）')
  process.exit(0)
}

const since = Date.now() - cfg.hours * 3600 * 1000
const lineRe = /^- \[(\d{2})-(\d{2}) (\d{2}):(\d{2})\] \[([^\]]+)\] (.*)$/
const year = new Date().getFullYear()

function stampOf(m, d, hh, mm) {
  const t = new Date(year, Number(m) - 1, Number(d), Number(hh), Number(mm))
  if (t.getTime() > Date.now() + 86400000) t.setFullYear(year - 1)
  return t
}

const picked = []
const seen = new Set()

function scanFile(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return }
  for (const raw of text.split('\n')) {
    const m = raw.trim().match(lineRe)
    if (!m) continue
    const t = stampOf(m[1], m[2], m[3], m[4])
    if (t.getTime() < since) continue
    const key = `${m[1]}-${m[2]} ${m[3]}:${m[4]} ${m[5]} ${m[6].slice(0, 40)}`
    if (seen.has(key)) continue
    seen.add(key)
    picked.push({ t, at: `${m[1]}-${m[2]} ${m[3]}:${m[4]}`, ch: m[5], text: m[6] })
  }
}

if (fs.existsSync(REALTIME)) {
  for (const f of fs.readdirSync(REALTIME).filter((x) => x.endsWith('.md')).sort()) scanFile(path.join(REALTIME, f))
}
scanFile(CONT)

picked.sort((a, b) => a.t - b.t)
const rows = picked.slice(-cfg.max)

const now = new Date()
const head = [
  '# 跨会话（自动扫描）',
  '',
  `> 开关：开 · 窗口 ${cfg.hours} 小时 · 最多 ${cfg.max} 条 · 扫描于 ${now.toLocaleString('zh-CN', { hour12: false })}`,
  '> 来源：shared/实时/*.md + shared/接续.md。这一页只给「别的会话刚才在聊什么」，原文以来源页为准。',
  '',
]
const body = rows.length ? rows.map((r) => `- [${r.at}] [${r.ch}] ${r.text}`) : ['- （这段时间没有别的会话记录）']
fs.writeFileSync(OUT, [...head, ...body, ''].join('\n'), 'utf8')
console.log(`跨会话：扫到 ${rows.length} 条 → ${OUT}`)
