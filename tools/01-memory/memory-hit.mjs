import fs from 'node:fs'
import path from 'node:path'

// 命中记账：哪条记忆被用到了，就记一笔。
// 用法：node memory-hit.mjs "条目名或关键词" [备注]
const DIR = 'C:/Users/Administrator/.dsh/im/shared/记忆本'
const HITS = path.join(DIR, '命中.jsonl')
fs.mkdirSync(DIR, { recursive: true })

const [key, note = ''] = process.argv.slice(2)
if (!key) {
  console.log('用法: node memory-hit.mjs "条目名或关键词" [备注]')
  process.exit(1)
}
const row = { at: new Date().toISOString(), key, note }
fs.appendFileSync(HITS, JSON.stringify(row) + '\n', 'utf8')

// 顺手统计一下这个 key 总共命中几次
let n = 0
for (const line of fs.readFileSync(HITS, 'utf8').split('\n')) {
  if (!line.trim()) continue
  try {
    if (JSON.parse(line).key === key) n++
  } catch {}
}
console.log(`记了一笔：${key}（累计 ${n} 次）`)
