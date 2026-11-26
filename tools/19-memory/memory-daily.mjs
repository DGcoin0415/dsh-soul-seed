import { sharedHome } from '../../lib/shared.mjs'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { writeFileRetry } from './write-retry.mjs'

// 日档自动整理：从当天 12 小时页里挑 用户 说的话，落成一份日档。
// 用法：node memory-daily.mjs [--date 2026-11-03] [--force]
// 不调模型、不花钱；只做筛选和截断，细节仍旧回当天全量页看。
const IM = sharedHome()
const PAGE_DIR = path.join(IM, 'shared/全量/页')
const DAY_DIR = path.join(IM, 'shared/记忆本/日')

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : undefined
}
const force = args.includes('--force')

// 手动写日档（原来独立的 memory-note.mjs）：
//   node memory-daily.mjs note "触点：…" "变：…" "回：…"
if (args[0] === 'note') {
  const body = args.slice(1).filter(Boolean)
  if (body.length === 0) {
    console.log('用法: node memory-daily.mjs note "触点：…" "变：…" "回：…"')
    process.exit(1)
  }
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
  const clock = `${p(now.getHours())}:${p(now.getMinutes())}`
  fs.mkdirSync(DAY_DIR, { recursive: true })
  const file2 = path.join(DAY_DIR, day + '.md')
  if (!fs.existsSync(file2)) fs.writeFileSync(file2, `# 日档 · ${day}\n\n`, 'utf8')
  fs.appendFileSync(file2, `\n## ${clock}\n\n` + body.map((a) => `- ${a}`).join('\n') + '\n', 'utf8')
  console.log(`写进 ${day}.md：${body.length} 行`)
  process.exit(0)
}

const p2 = (n) => String(n).padStart(2, '0')
const fmt = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`

const target = opt('date') || fmt(new Date(Date.now() - 86400_000))
const outFile = path.join(DAY_DIR, target + '.md')

if (fs.existsSync(outFile) && !force) {
  const body = fs.readFileSync(outFile, 'utf8')
  if (body.replace(/^#.*$/m, '').trim().length > 40) {
    console.log(`${target} 已经有日档了，跳过`)
    process.exit(0)
  }
}

const pages = ['AM', 'PM']
  .map((s) => path.join(PAGE_DIR, `${target}-${s}.md`))
  .filter((p) => fs.existsSync(p))

if (pages.length === 0) {
  console.log(`${target} 没有分页文件，跳过`)
  process.exit(0)
}

const NOISE = ['dsh_im_files', 'sha256', '图片原文件', '文件清单', '1-image.jpg', '```']
const clean = (s) =>
  s
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

const picked = []
const seen = new Set()
for (const page of pages) {
  for (const raw of fs.readFileSync(page, 'utf8').split('\n')) {
    const m = /^- \[(\d{2}:\d{2})\] ([^：]{1,12})：(.*)$/.exec(raw)
    if (!m) continue
    const [, clock, who, rest] = m
    if (!/用户/i.test(who)) continue
    if (NOISE.some((n) => rest.includes(n))) continue
    const text = clean(rest)
    if (text.length < 6) continue
    const brief = text.length > 80 ? text.slice(0, 80) + '…' : text
    const key = brief.slice(0, 20)
    if (seen.has(key)) continue
    seen.add(key)
    picked.push({ clock, line: `- ${clock} ${brief}` })
    if (picked.length >= 12) break
  }
  if (picked.length >= 12) break
}

picked.sort((a, b) => a.clock.localeCompare(b.clock))

if (picked.length === 0) {
  console.log(`${target} 没挑出内容，跳过`)
  process.exit(0)
}

fs.mkdirSync(DAY_DIR, { recursive: true })
const body = [
  `# 日档 · ${target}`,
  '',
  `> 自动整理：只摘 用户 当天说的话，细节看 \`shared/全量/页/${target}-*.md\`。`,
  '',
  '## 当天提点',
  '',
  ...picked.map((x) => x.line),
  '',
].join('\n')

writeFileRetry(outFile, body)
console.log(`写进 ${target}.md：${picked.length} 条`)
