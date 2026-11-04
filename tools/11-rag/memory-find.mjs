import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

// 查记忆：先翻摘要目录（不花钱），翻不到再走向量。
// 用法：node memory-find.mjs "想问的事" [--rag] [--top 3] [--budget 1600]
// 输出带三档判断：MATCHED（找到了）/ AMBIGUOUS（有候选但不硬）/ NOT_FOUND（没找到）。
// 每条都按预算切块给：路径块、摘要块、向量块各有上限，超了就降级，不整段硬塞。
const HOME = path.join(os.homedir(), '.dsh/im')
const IDX = path.join(HOME, 'shared', '索引', '摘要.jsonl')

const args = process.argv.slice(2)
const useRag = args.includes('--rag')
const topI = args.indexOf('--top')
const TOP = topI >= 0 ? Number(args[topI + 1]) : 3
const budgetI = args.indexOf('--budget')
const BUDGET = budgetI >= 0 ? Number(args[budgetI + 1]) : 1600

// 三块配额：路径清单 1/4，摘要正文不到一半，向量兜底三成，谁也不能借谁的
const SLICE = { paths: Math.round(BUDGET * 0.4), summaries: Math.round(BUDGET * 0.35), vectors: Math.round(BUDGET * 0.25) }

const query = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--top' && args[i - 1] !== '--budget').join(' ').trim()

if (!query) {
  console.log('用法：node memory-find.mjs "想问的事" [--rag] [--budget 1600]')
  process.exit(1)
}

const len = (s) => [...String(s)].length
const clip = (s, n) => (len(s) > n ? [...s].slice(0, n).join('') + '…' : s)

const tok = (s) => {
  const t = String(s).toLowerCase()
  const out = new Set()
  for (const w of t.match(/[a-z0-9_./-]{2,}/g) || []) out.add(w)
  const han = t.replace(/[^\u4e00-\u9fa5]+/g, '')
  for (let i = 0; i < han.length - 1; i++) out.add(han.slice(i, i + 2))
  return out
}

const rows = fs
  .readFileSync(IDX, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))

const STOP = new Set(['怎么', '什么', '在哪', '那个', '一下', '这个', '为啥', '哪里', '多少', '可以', '是不是'])
const qt = [...tok(query)].filter((t) => !STOP.has(t))
const df = new Map()
const docs = rows.map((r) => tok(`${r.path} ${r.name} ${r.summary} ${(r.heads || []).join(' ')}`))
for (const d of docs) for (const t of d) df.set(t, (df.get(t) || 0) + 1)
const idf = (t) => Math.log(1 + rows.length / (df.get(t) || 1))
const asciiQ = qt.filter((t) => /^[a-z0-9_./-]{2,}$/.test(t))
const pool = asciiQ.length ? rows.map((r, i) => [r, i]).filter(([, i]) => asciiQ.some((t) => docs[i].has(t))) : rows.map((r, i) => [r, i])
const scored = pool
  .map(([r, i]) => {
    let hit = 0
    let rare = false
    const seen = new Set()
    for (const t of qt) {
      if (!docs[i].has(t)) continue
      seen.add(t)
      hit += idf(t) * (/^[a-z0-9_./-]{4,}$/.test(t) ? 1.6 : 1)
      if (/^[a-z0-9_./-]{4,}$/.test(t) || (df.get(t) || 0) <= 3) rare = true
    }
    // 覆盖率：查询里的词命中了几成，只蹭上一个词不算找到
    const cover = seen.size / Math.max(1, qt.length)
    return { ...r, score: hit / Math.max(1, Math.sqrt(qt.length)), rare, cover }
  })
  .filter((r) => r.score > 0.05) // 0 分的噪声不往外打，这是老毛病
  .sort((a, b) => b.score - a.score)

const top = scored.slice(0, TOP)
const best = top[0]?.score || 0
const bestCover = top[0]?.cover || 0
// 分数够 + 覆盖率过半，才算「真找到」；只蹭上一个词最多算候选
const matched = bestCover >= 0.5 && (best >= 1.0 || top.some((r) => r.score >= 0.6 && r.rare))
const verdict = matched ? 'MATCHED' : top.length ? 'AMBIGUOUS' : 'NOT_FOUND'

const out = []
let pathUsed = 0
let sumUsed = 0
let dropped = 0

out.push(`[召回] ${verdict}  最高 ${best.toFixed(2)} · 预算 ${BUDGET}`)
if (top.length) {
  for (const r of top) {
    const pLine = `- ${r.score.toFixed(2)}  ${r.path}`
    if (pathUsed + len(pLine) > SLICE.paths) {
      dropped += 1
      continue
    }
    pathUsed += len(pLine)
    out.push(pLine)
    const head = r.summary ? clip(String(r.summary).replace(/\s+/g, ' '), 160) : ''
    const sLine = head ? `    ${head}` : ''
    if (sLine && sumUsed + len(sLine) <= SLICE.summaries) {
      sumUsed += len(sLine)
      out.push(sLine)
    }
  }
}
if (dropped) out.push(`  （预算紧，${dropped} 条没展开）`)
if (verdict === 'AMBIGUOUS') out.push('  候选而已，没到「就是这条」的程度；答之前先问一句或读原文核对。')
if (verdict === 'NOT_FOUND') out.push('  摘要目录里没有。别硬编，加 --rag 再走一次向量。')

console.log(out.join('\n'))

if (useRag) {
  // 先找同目录的 rag.mjs（仓库里就是这样放着），没有再用插件里那份
  const here = path.dirname(fileURLToPath(import.meta.url))
  const ragPath = [
    path.join(here, 'rag.mjs'),
    path.join(os.homedir(), '.dsh/plugins/dsh-misa-soul/lib/rag.mjs'),
  ].find((p) => fs.existsSync(p))
  if (!ragPath) {
    console.log('[向量兜底] 找不到 rag.mjs，跳过')
    process.exit(0)
  }
  const { recall } = await import(pathToFileURL(ragPath).href)
  const r = await recall(query, TOP)
  const hits = (r.hits || []).filter((h) => Number(h.score) >= 0.35)
  const topScore = Number(hits[0]?.score || 0)
  const ragVerdict = topScore >= 0.62 ? 'MATCHED' : hits.length ? 'AMBIGUOUS' : 'NOT_FOUND'
  console.log(`[向量兜底] ${ragVerdict}  最高 ${topScore.toFixed(2)}`)
  let vUsed = 0
  let vDropped = 0
  for (const h of hits) {
    const text = clip(String(h.text).replace(/\s+/g, ' '), 200)
    const block = `- ${Number(h.score).toFixed(2)}  ${h.file}  ${(h.dates || []).join(',')}\n    ${text}`
    if (vUsed + len(block) > SLICE.vectors) {
      vDropped += 1
      continue
    }
    vUsed += len(block)
    console.log(block)
  }
  if (vDropped) console.log(`  （向量块预算不够，${vDropped} 条没带正文）`)
  if (ragVerdict === 'NOT_FOUND') console.log('  向量也没捞到近的，就是没有。')
}
