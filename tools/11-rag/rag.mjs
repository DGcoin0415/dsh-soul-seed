#!/usr/bin/env node
// 模糊回忆：把长对话原文建向量索引，再按语义检索。
// 用法：
//   node tools/11-rag/rag.mjs index          把 long/ 下 .md 全部入库
//   node tools/11-rag/rag.mjs query "想找的事" 检索
//   node tools/11-rag/rag.mjs stat           看索引里有多少块
import path from 'node:path'
import fs from 'node:fs'
import { buildIndex, recall, loadIndex, longDir, indexDir } from '../../lib/rag.mjs'

const [, , cmd, ...rest] = process.argv

if (cmd === 'index') {
  const r = await buildIndex({ log: (m) => console.log(' ' + m) })
  console.log(`完成：共 ${r.total} 块，新增 ${r.added} 块`)
} else if (cmd === 'query') {
  const q = rest.join(' ').trim()
  if (!q) { console.error('用法：node tools/11-rag/rag.mjs query "想找的事"'); process.exit(2) }
  const r = await recall(q, 5)
  if (!r.hits.length) { console.log(r.note || '没检索到'); process.exit(0) }
  for (const [i, h] of r.hits.entries()) {
    console.log(`${i + 1}. [${h.file} ${h.score}] ${h.text.slice(0, 200).replace(/\n/g, ' ')}`)
  }
} else if (cmd === 'stat') {
  const idx = loadIndex()
  console.log(`索引：${idx.chunks.length} 块 · ${idx.model} · 建于 ${idx.builtAt || '未建'}`)
  console.log(`原文目录：${longDir()}`)
  console.log(`索引文件：${path.join(indexDir(), 'index.json')}`)
} else {
  console.log('用法：node tools/11-rag/rag.mjs <index|query|stat> [参数]')
  process.exit(1)
}
