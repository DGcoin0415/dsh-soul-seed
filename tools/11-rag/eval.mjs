// 检索评测：拿一组真实提问跑纯向量 vs 混检，看命中率差多少。
// 用法：node tools/11-rag/eval.mjs [topK]
import fs from 'node:fs'
import path from 'node:path'

// 允许直接跑：从仓库根目录引用 lib/rag.mjs
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const { recall, soulDir } = await import('file://' + path.join(here, '..', '..', 'lib', 'rag.mjs').replace(/\\/g, '/'))

const TOPK = Number(process.argv[2] || 5)
const evalFile = path.join(soulDir(), 'shared', '向量', '评测.jsonl')

const rows = fs
  .readFileSync(evalFile, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))

const mark = (hitText, expect) => expect.some((k) => hitText.includes(k))

async function run(mode) {
  if (mode === 'vector') process.env.HYBRID = '0'
  else delete process.env.HYBRID
  let hit3 = 0
  let mrr = 0
  const misses = []
  for (const row of rows) {
    const { hits } = await recall(row.q, TOPK)
    const at = hits.findIndex((h) => mark(h.text, row.expect))
    if (at >= 0 && at < 3) hit3++
    if (at >= 0) mrr += 1 / (at + 1)
    else misses.push(row.q)
  }
  return { hit3: hit3 / rows.length, mrr: mrr / rows.length, misses }
}

const vec = await run('vector')
const hyb = await run('hybrid')

const pct = (x) => (x * 100).toFixed(1) + '%'
console.log(`题数 ${rows.length}，top3 命中 / MRR`)
console.log(`纯向量  ${pct(vec.hit3)}  ${vec.mrr.toFixed(3)}`)
console.log(`向量+关键词  ${pct(hyb.hit3)}  ${hyb.mrr.toFixed(3)}`)
if (hyb.misses.length) console.log('混检也没命中：' + hyb.misses.join(' / '))
