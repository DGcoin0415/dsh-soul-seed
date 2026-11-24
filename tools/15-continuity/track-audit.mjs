// 轨道审计：从历史对话里挖「反复出现、但轨道里没有」的命令，列成待补清单。
// 用法：node track-audit.mjs [--days 30] [--min 3]
// 产物：shared/轨道待补.md（每次覆盖写）
// 判定：同一命令（去掉参数的骨架）在 ≥min 个不同日期里出现过，且运维页「固定轨道」里没有它 → 待补。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.SOUL_HOME || path.join(os.homedir(), '.dsh', 'im')
const SHARED = path.join(HOME, 'shared')
const PAGES = path.join(SHARED, '全量', '页')
const OPS = path.join(SHARED, '资料', '运维.md')
const OUT = path.join(SHARED, '轨道待补.md')

const argv = process.argv.slice(2)
const num = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? Number(argv[i + 1]) || dflt : dflt
}
const DAYS = num('--days', 30)
const MIN = num('--min', 3)

const cutoff = Date.now() - DAYS * 86400_000

/** 把命令骨架化：去掉 JSON/引号里的参数、路径里的随机名，只留工具+子命令。 */
function skeleton(cmd) {
  return String(cmd)
    .replace(/[\u4e00-\u9fa5]/g, '')            // 去掉中文参数
    .replace(/'[^']*'/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/--?[a-zA-Z-]+=[^\s]*/g, '')
    .replace(/\b\d+(\.\d+)?\b/g, 'N')
    .replace(/[A-Za-z]:[\\/][^\s]*/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

function collect() {
  const hits = new Map() // skeleton -> { days:Set, sample }
  if (!fs.existsSync(PAGES)) return hits
  for (const f of fs.readdirSync(PAGES)) {
    if (!f.endsWith('.md')) continue
    const full = path.join(PAGES, f)
    let st
    try {
      st = fs.statSync(full)
    } catch {
      continue
    }
    if (st.mtimeMs < cutoff) continue
    let text = ''
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      continue
    }
    for (const m of text.matchAll(/`([^`\n]{6,200})`/g)) {
      const raw = m[1].trim()
      // 只收像命令的：含 .mjs / 已知工具名 / 带参数
      if (!/(\.mjs|\.ps1|\.py|node |python|pnpm |npm |git |curl )/i.test(raw)) continue
      const key = skeleton(raw)
      if (key.length < 6) continue
      const rec = hits.get(key) || { days: new Set(), sample: raw }
      rec.days.add(f.slice(0, 10))
      hits.set(key, rec)
    }
  }
  return hits
}

let trackText = ''
try {
  trackText = fs.readFileSync(OPS, 'utf8')
} catch {}

const covered = (key) => {
  // 取骨架里最能代表命令的片段去运维页里找
  const probe = key.split(' ').filter((w) => w && w !== '<path>').slice(0, 3).join(' ')
  return probe.length >= 4 && trackText.includes(probe)
}

const hits = collect()
const rows = []
for (const [key, rec] of hits) {
  if (rec.days.size < MIN) continue
  if (covered(key)) continue
  rows.push({ key, days: rec.days.size, sample: rec.sample })
}
rows.sort((a, b) => b.days - a.days)

const lines = [
  '# 轨道待补（自动扫出来的，等人确认）',
  '',
  `> 扫描范围：最近 ${DAYS} 天 · 判据：同一命令在 ≥${MIN} 个不同日期出现过、且运维页「固定轨道」里没有它。`,
  `> 生成时间：${new Date().toLocaleString('zh-CN')} · 生成者：track-audit.mjs`,
  '> 用法：看着像「还会做第二次」的，就补进固定轨道，然后把它从这页划掉；不是重复活的，忽略即可。',
  '',
]

if (!rows.length) {
  lines.push('（这次没扫出待补的，轨道覆盖得还行）')
} else {
  lines.push(`| 次数(不同天) | 命令骨架 | 出现过的原样 |`)
  lines.push('| --- | --- | --- |')
  for (const r of rows.slice(0, 40)) {
    const sample = r.sample.replace(/\|/g, '\\|').slice(0, 90)
    lines.push(`| ${r.days} | \`${r.key.replace(/\|/g, '\\|')}\` | \`${sample}\` |`)
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
console.log(`轨道审计：扫了 ${hits.size} 种命令骨架，待补 ${rows.length} 条 → ${OUT}`)
