import { sharedHome } from '../../lib/shared.mjs'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { pickSeedTerms } from '../../lib/hop.mjs'

// 查记忆：先翻摘要目录（不花钱），翻不到再走向量。
// 用法：node memory-find.mjs "想问的事" [--rag] [--top 3] [--budget 1600] [--hop]（--hop：顺着命中再找一轮，适合「这件事我在哪几篇写过」）
// 输出带三档判断：MATCHED（找到了）/ AMBIGUOUS（有候选但不硬）/ NOT_FOUND（没找到）。
// 每条都按预算切块给：路径块、摘要块、向量块各有上限，超了就降级，不整段硬塞。
const HOME = sharedHome()
const IDX = path.join(HOME, 'shared', '索引', '摘要.jsonl')

const args = process.argv.slice(2)
// 建索引 / 看索引：原来独立的 rag.mjs 并进来了
//   node memory-find.mjs index
//   node memory-find.mjs stat
if (args[0] === 'index' || args[0] === 'stat') {
  const { buildIndex, loadIndex, longDir, indexDir } = await import('../../lib/rag.mjs')
  if (args[0] === 'index') {
    const r = await buildIndex({ log: (m) => console.log(' ' + m) })
    console.log(`完成：共 ${r.total} 块，新增 ${r.added} 块`)
  } else {
    const idx = loadIndex()
    console.log(`索引：${idx.chunks.length} 块 · ${idx.model} · 建于 ${idx.builtAt || '未建'}`)
    console.log(`原文目录：${longDir()}`)
    console.log(`索引文件：${path.join(indexDir(), 'index.json')}`)
  }
  process.exit(0)
}
const useRag = args.includes('--rag')
const topI = args.indexOf('--top')
const TOP = topI >= 0 ? Number(args[topI + 1]) : 3
const budgetI = args.indexOf('--budget')
const BUDGET = budgetI >= 0 ? Number(args[budgetI + 1]) : 1600
const tagI = args.indexOf('--tag')
const TAG = tagI >= 0 ? String(args[tagI + 1] || '').toLowerCase() : ''

// 三块配额：路径清单 1/4，摘要正文不到一半，向量兜底三成，谁也不能借谁的
const SLICE = { paths: Math.round(BUDGET * 0.4), summaries: Math.round(BUDGET * 0.35), vectors: Math.round(BUDGET * 0.25) }

const OMIT = new Set(['--top', '--budget', '--tag'])
const query = args.filter((a, i) => !a.startsWith('--') && !OMIT.has(args[i - 1])).join(' ').trim()

if (!query && !TAG) {
  console.log('用法：node memory-find.mjs "想问的事" [--rag] [--budget 1600] [--tag 标签]')
  process.exit(1)
}

const len = (s) => [...String(s)].length
const clip = (s, n) => (len(s) > n ? [...s].slice(0, n).join('') + '…' : s)

// 距今多久：模型不会自己按时间戳算，这里直接给成「3天前」这种说法
const age = (ms) => {
  if (!ms) return ''
  const d = Math.floor((Date.now() - Number(ms)) / 86400000)
  if (d <= 0) return '今天'
  if (d === 1) return '昨天'
  if (d < 30) return `${d}天前`
  if (d < 365) return `${Math.floor(d / 30)}个月前`
  return `${Math.floor(d / 365)}年前`
}

const tok = (s) => {
  const t = String(s).toLowerCase()
  const out = new Set()
  for (const w of t.match(/[a-z0-9_./-]{2,}/g) || []) out.add(w)
  const han = t.replace(/[^\u4e00-\u9fa5]+/g, '')
  for (let i = 0; i < han.length - 1; i++) out.add(han.slice(i, i + 2))
  return out
}

const rows = fs.existsSync(IDX)
  ? fs.readFileSync(IDX, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => !TAG || (r.tags || []).some((t) => String(t).toLowerCase().includes(TAG)))
  : []

// 只给标签、没给问题：按标签列最近的条目，不打分
if (!query && TAG) {
  const hit = [...rows].sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, TOP)
  console.log(`[标签] ${TAG} · 共 ${rows.length} 条`)
  for (const r of hit) console.log(`- ${r.path}  [${(r.tags || []).join('/')}]`)
  process.exit(0)
}

// 问法扩展：同一个事实换个问法（「全名」问、历史里写的是「我叫 X」）
const QUERY_EXPAND = new Map([
  ['全名', ['名字', '叫', '称呼', '姓名']],
  ['名字', ['全名', '叫', '称呼']],
  ['多大', ['岁', '年龄', '年纪']],
  ['年龄', ['岁', '多大', '年纪']],
  ['生日', ['月', '日', '过生', '出生']],
  ['住哪', ['住', '区', '地址', '合租']],
  ['做什么', ['工作', '职业', '上班', '客服']],
  ['欠', ['还', '欠着', '剩', '记着']],
  ['答应', ['说好', '约定', '算一个']],
  ['矛盾', ['对不上', '前后', '改口', '说过']],
  ['对不上', ['矛盾', '前后', '改口']],
])

// 这些词出现时说明要「把散落的几处拼起来」，召回要给多一点
const NEEDS_MORE = /矛盾|对不上|前后|改口|理一下|整理|汇总|都有哪些|几件|哪些事|回忆/
const NEEDS_MORE_TOP = 8

const STOP = new Set(['怎么', '什么', '在哪', '那个', '一下', '这个', '为啥', '哪里', '多少', '可以', '是不是'])
const baseQt = [...tok(query)].filter((t) => !STOP.has(t))
const expandQuery = (tokens) => {
  const out = new Set(tokens)
  for (const tk of tokens) {
    const extra = QUERY_EXPAND.get(tk)
    if (extra) for (const e of extra) out.add(e)
  }
  return [...out]
}
const qt = expandQuery(baseQt)
const wantMore = NEEDS_MORE.test(query)
const TOP_USE = wantMore ? Math.max(TOP, NEEDS_MORE_TOP) : TOP
const df = new Map()
const docs = rows.map((r) => tok(`${r.path} ${r.name} ${r.summary} ${(r.heads || []).join(' ')} ${(r.tags || []).join(' ')}`))
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

const top = scored.slice(0, TOP_USE)
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
    const tagStr = (r.tags || []).length ? `  [${(r.tags || []).slice(0, 3).join('/')}]` : ''
    // 证据链：带行号，命中就能直接翻到原文那一段
    const at = r.line ? `:${r.line}${r.lineEnd && r.lineEnd !== r.line ? '-' + r.lineEnd : ''}` : ''
    const ago = age(r.mtime)
    const pLine = `- ${r.score.toFixed(2)}  ${r.path}${at}${tagStr}${ago ? '  ·' + ago : ''}`
    if (pathUsed + len(pLine) > SLICE.paths) {
      dropped += 1
      continue
    }
    pathUsed += len(pLine)
    out.push(pLine)
    const head = r.conclusion
      ? `结论：${clip(String(r.conclusion).replace(/\s+/g, ' '), 120)}`
      : r.summary
        ? clip(String(r.summary).replace(/\s+/g, ' '), 160)
        : ''
    const sLine = head ? `    ${head}` : ''
    if (sLine && sumUsed + len(sLine) <= SLICE.summaries) {
      sumUsed += len(sLine)
      out.push(sLine)
    }
  }
}
if (dropped) out.push(`  （预算紧，${dropped} 条没展开）`)
if (verdict === 'AMBIGUOUS') out.push('  候选而已，没到「就是这条」的程度：读原文核对；核对不了就说「我没记清」，别猜。')
if (verdict === 'NOT_FOUND') out.push('  摘要目录里没有。别硬编 —— 答「这条我没记着」比编一个强。')

console.log(out.join('\n'))

// ── 顺藤：从命中的摘要里再抽词，检索第二轮（跟 SAG2 学的那一手）──
//   找到一条不等于找全：同一件事常被切成好多段，靠第一轮的词捞不到全部。
//   只顺一轮，不再往下钻；--no-hop 可关。
if (verdict === 'MATCHED' && top.length && process.argv.includes('--hop')) {
  const seeds = pickSeedTerms(
    top.map((r) => [r.conclusion, r.summary, (r.heads || []).join(' ')].filter(Boolean).join(' ')),
    [...qt],
    { max: 4 }
  )
  if (seeds.length) {
    const seenPaths = new Set(top.map((r) => r.path + (r.line || '')))
    // 种子词要按查询同样的口径切（二元组 + 英文词），否则永远对不上文档的 token 集
    const seedToks = [...new Set(seeds.flatMap((s) => [...tok(s)]))].filter((x) => !STOP.has(x))
    const hopScored = rows
      .map((r, i) => {
        let hit = 0
        let matched = 0
        for (const s of seedToks) if (docs[i].has(s)) { hit += idf(s); matched += 1 }
        return { ...r, score: hit / Math.max(1, Math.sqrt(seedToks.length)), matched }
      })
      // 双门槛：分数够 + 至少两个种子词同时命中。一个弱词蹭上来的不算顺藤。
      .filter((r) => r.score >= 1.0 && r.matched >= Math.min(3, seedToks.length) && !seenPaths.has(r.path + (r.line || '')))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)

    if (hopScored.length) {
      console.log(`[顺藤] 用「${seeds.join('、')}」再找一轮 → ${hopScored.length} 条`)
      for (const r of hopScored) {
        const at = r.line ? `:${r.line}${r.lineEnd && r.lineEnd !== r.line ? '-' + r.lineEnd : ''}` : ''
        console.log(`- ${r.score.toFixed(2)}  ${r.path}${at}`)
        const head = r.conclusion || r.summary
        if (head) console.log('    ' + clip(String(head).replace(/\s+/g, ' '), 140))
      }
      console.log('  （顺着第一轮的关键词找到的，不是直接命中 —— 用之前对一眼原文）')
    }
  }
}

const autoRag = !useRag && verdict === 'NOT_FOUND' && !process.argv.includes('--no-rag')
if (useRag || autoRag) {
  // 直接用插件里的 lib/rag.mjs（0.13.x 起 tools/11-rag/rag.mjs 已经并进来了）
  let recall = null
  try {
    ;({ recall } = await import('../../lib/rag.mjs'))
  } catch (e) {
    console.log('[向量兜底] 载入失败，跳过：' + String(e?.message ?? e).slice(0, 80))
    process.exit(0)
  }
  let r
  try {
    r = await recall(query, TOP_USE)
  } catch (e) {
    const msg = String(e?.message ?? e)
    console.log('[向量兜底] 用不了：' + msg.slice(0, 120))
    if (/Arrearage|欠费|Access denied/i.test(msg)) console.log('  → 是 embedding 账户欠费/不可用，不是检索逻辑的问题；上面目录的结果仍然有效。')
    process.exit(0)
  }
  const hits = (r.hits || []).filter((h) => Number(h.score) >= 0.35)
  const topScore = Number(hits[0]?.score || 0)
  const ragVerdict = topScore >= 0.62 ? 'MATCHED' : hits.length ? 'AMBIGUOUS' : 'NOT_FOUND'
  console.log(`[向量兜底${autoRag ? '·自动' : ''}] ${ragVerdict}  最高 ${topScore.toFixed(2)}`)
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
