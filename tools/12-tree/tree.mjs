#!/usr/bin/env node
// 翻叶 / 修枝：看最近用过哪些记忆，顺手把长乱的收拾一下。
// 用法：
//   node tools/12-tree/tree.mjs leaves [n]   最近用过的记忆（默认 15 条）
//   node tools/12-tree/tree.mjs tidy         截断翻叶、归档旧落叶、重建索引
import os from 'node:os'
import path from 'node:path'
import { recentTurns } from '../../lib/turnlog.mjs'
import { tidy } from '../../lib/tidy.mjs'
import { soulHome } from '../../lib/home.mjs'

const soul = process.env.SOUL_SEED_ROOT?.trim()
  ? path.resolve(process.env.SOUL_SEED_ROOT.trim())
  : soulHome()

const [, , cmd, ...rest] = process.argv

if (cmd === 'leaves') {
  const n = Number(rest[0] || 15)
  const rows = recentTurns(soul, n)
  console.log(rows.length ? rows.join('\n') : '翻叶是空的')
} else if (cmd === 'tidy') {
  const r = await tidy({ log: (m) => console.log(' ' + m) })
  console.log(`修枝：截断 ${r.trimmed} 行，归档 ${r.archived} 份，索引新增 ${r.reindexed} 块`)
} else {
  console.log('用法：node tools/12-tree/tree.mjs <leaves|tidy> [n]')
  process.exit(1)
}
