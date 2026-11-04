import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { writeFileRetry } from './write-retry.mjs'

// 给共享树编一份「摘要目录」：文件一行 + 每个小节一行，查东西先看它，不用一上来读全文。
// 每条还带 4 个标签（从标题里切，本地做，不调模型不花钱），检索时能先按标签筛。
// 用法：node memory-index.mjs
const HOME = path.join(os.homedir(), '.dsh/im')
const SHARED = path.join(HOME, 'shared')
const OUT = path.join(SHARED, '索引', '摘要.jsonl')

const SKIP_DIRS = new Set(['全量', '向量', '落叶', '旧', '索引', '凭据'])

function firstLine(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const body = lines.find((l) => !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('|') && !l.startsWith('-'))
  return (body || lines.find((l) => !l.startsWith('#')) || '').replace(/[`*|]/g, '').slice(0, 90)
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(full, out)
    } else if (e.name.endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

const rows = []
for (const f of walk(SHARED)) {
  const text = fs.readFileSync(f, 'utf8')
  const rel = path.relative(SHARED, f).replace(/\\/g, '/')
  const mtime = fs.statSync(f).mtimeMs
  const secHeads = [...text.matchAll(/^##\s+(.+)$/gm)]

  rows.push({
    path: `shared/${rel}`,
    name: path.basename(f),
    summary: firstLine(text),
    heads: secHeads.map((m) => m[1].trim()).slice(0, 12),
    size: text.length,
    mtime,
  })

  // 按小节再拆一层：查「工具分组」这种词，能直接落到文件里的那一节
  secHeads.forEach((m, i) => {
    const start = m.index + m[0].length
    const end = i + 1 < secHeads.length ? secHeads[i + 1].index : text.length
    const body = text.slice(start, end).trim()
    if (body.length < 40) return
    const line = body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('|') && !l.startsWith('>')) || ''
    rows.push({
      path: `shared/${rel}#${m[1].trim()}`,
      name: path.basename(f),
      summary: `${m[1].trim()} —— ${line.replace(/[`*|]/g, '').slice(0, 70)}`,
      heads: [m[1].trim()],
      size: body.length,
      mtime,
    })
  })
}

// 根上那两个和几份 json 也算进来：规矩和配置经常比枝更先被问到
for (const extra of ['AGENTS.md', 'SHARED-STATE.md']) {
  const full = path.join(HOME, extra)
  if (!fs.existsSync(full)) continue
  const text = fs.readFileSync(full, 'utf8')
  const secHeads = [...text.matchAll(/^##\s+(.+)$/gm)]
  rows.push({ path: extra, name: extra, summary: firstLine(text), heads: secHeads.map((m) => m[1].trim()).slice(0, 12), size: text.length, mtime: fs.statSync(full).mtimeMs })
  secHeads.forEach((m, i) => {
    const start = m.index + m[0].length
    const end = i + 1 < secHeads.length ? secHeads[i + 1].index : text.length
    const body = text.slice(start, end).trim()
    if (body.length < 40) return
    const line = body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('|') && !l.startsWith('>')) || ''
    rows.push({ path: `${extra}#${m[1].trim()}`, name: extra, summary: `${m[1].trim()} —— ${line.replace(/[`*|]/g, '').slice(0, 70)}`, heads: [m[1].trim()], size: body.length, mtime: fs.statSync(full).mtimeMs })
  })
}
for (const jf of fs.readdirSync(SHARED).filter((x) => x.endsWith('.json'))) {
  const full = path.join(SHARED, jf)
  rows.push({ path: `shared/${jf}`, name: jf, summary: `配置文件：${jf}`, heads: [], size: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs })
}
// 分页也编进去，但每条只留一句提示（页本身很大，读全文另走）
const pagesDir = path.join(SHARED, '全量', '页')
if (fs.existsSync(pagesDir)) {
  for (const f of fs.readdirSync(pagesDir).filter((x) => /^\d{4}-\d{2}-\d{2}-(AM|PM)\.md$/.test(x))) {
    const full = path.join(pagesDir, f)
    const text = fs.readFileSync(full, 'utf8')
    const first = text.split('\n').find((l) => l.startsWith('- ')) || ''
    rows.push({
      path: `shared/全量/页/${f}`,
      name: f,
      summary: first.replace(/^-\s*/, '').slice(0, 90),
      heads: [],
      size: text.length,
      mtime: fs.statSync(full).mtimeMs,
    })
  }
}

// 打标签：从标题里切，本地做、不调模型、不花钱。
// 标题是人写的，本来就接近标签；太长的段多半是整句，不要。英文标识符（busy、mood-auto）也留一个。
const STOP = new Set([
  '可以', '什么', '这个', '那个', '一下', '我们', '你们', '他们', '就是', '然后', '如果', '所以', '因为', '但是',
  '没有', '一个', '这些', '那些', '需要', '进行', '使用', '这样', '那样', '现在', '今天', '之后', '已经',
  '时候', '里面', '还有', '不是', '自己', '怎么', '这里', '那里', '或者', '以及', '而且', '还是', '只是',
  '一种', '一些', '上面', '下面', '东西', 'shared', 'dsh', 'md',
])
function tagsOf(r) {
  const seen = new Set()
  const isWhole = !String(r.path).includes('#')
  // 整文件条目看所有小节标题，小节条目只看它自己那条；整文件用单条标题容易被一行正文带偏
  const heads = isWhole ? (r.heads || []).join(' ') : (r.heads || [])[0] || ''
  const title = String(heads + ' ' + (r.summary || '')).replace(/[`*|]/g, '')
  for (const seg of title.split(/[^\u4e00-\u9fa5]+/)) {
    const s = seg.trim()
    if (s.length >= 2 && s.length <= 6 && !STOP.has(s)) seen.add(s)
  }
  for (const w of String(r.path + ' ' + title).match(/[a-zA-Z][a-zA-Z0-9_.-]{2,}/g) || []) {
    const lw = w.toLowerCase().replace(/\.(md|json|mjs|ps1)$/, '')
    if (lw.length >= 3 && !STOP.has(lw)) seen.add(lw)
  }
  return [...seen].slice(0, 4)
}
rows.forEach((r) => {
  r.tags = tagsOf(r)
})

fs.mkdirSync(path.dirname(OUT), { recursive: true })
writeFileRetry(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
console.log(`摘要目录：${rows.length} 条，带标签 → ${OUT}`)
