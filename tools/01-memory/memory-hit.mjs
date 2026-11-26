#!/usr/bin/env node
import { sharedHome } from '../../lib/shared.mjs'
import { recordTurn, recentTurns } from '../../lib/turnlog.mjs'

// 命中记账：哪条记忆被用到了，就记一笔。
//
// 以前单独写 `shared/记忆本/命中.jsonl`，跟 `shared/翻叶.md` 是两套账；
// 现在只留一套 —— 统一记进翻叶，看「这轮翻过什么」和「哪条被反复用」是同一个文件。
//
// 用法：node tools/01-memory/memory-hit.mjs "条目名或关键词" [备注]
const [key, note = ''] = process.argv.slice(2)
if (!key) {
  console.log('用法: node tools/01-memory/memory-hit.mjs "条目名或关键词" [备注]')
  process.exit(1)
}

const soul = sharedHome()
recordTurn(soul, '命中', note ? key + ' | ' + note : key)

// 累计次数：从翻叶里数同一个 key
const rows = recentTurns(soul, 500)
const n = rows.filter((r) => typeof r === 'string' && r.includes(key)).length
console.log(`记了一笔：${key}（累计 ${n} 次）`)
