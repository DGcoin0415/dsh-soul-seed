#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 把本机状态写到共享目录，一个入口两件事：
//
//   node tools/08-ops/publish.mjs          两件都刷
//   node tools/08-ops/publish.mjs mood     只刷心情（→ shared/mood.md）
//   node tools/08-ops/publish.mjs now      只刷「现在」（→ shared/现在.md）
//
// 实现仍在两个文件里（各自只管一种状态），这里是统一入口。

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

const JOBS = [
  ['mood', '心情', 'tools/17-mood/sync-mood.mjs'],
  ['now', '现在', 'tools/19-memory/now-update.mjs']
]

const pick = process.argv[2]
const list = pick ? JOBS.filter((j) => j[0] === pick) : JOBS
if (pick && list.length === 0) {
  console.log('用法: node tools/08-ops/publish.mjs [mood|now]')
  process.exit(2)
}

let failed = 0
for (const [key, label, rel] of list) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) { console.log('– ' + label + '：脚本不在（' + rel + '）'); continue }
  const r = spawnSync(process.execPath, [file], { cwd: ROOT, stdio: 'inherit', timeout: 120000 })
  if (r.status !== 0) failed += 1
}
console.log(failed === 0 ? '发布完成' : failed + ' 项失败')
process.exit(failed ? 1 : 0)
