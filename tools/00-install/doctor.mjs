#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 体检总入口：四个检查合成一条命令。
//
//   node tools/00-install/doctor.mjs           全查
//   node tools/00-install/doctor.mjs install   只查装机
//   node tools/00-install/doctor.mjs paths     只查指针
//   node tools/00-install/doctor.mjs model     只查模型
//   node tools/00-install/doctor.mjs bom       只查 BOM
//
// 实现分别在四个文件里（各管一件事，不重复），这里是统一入口。

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

const CHECKS = [
  ['install', '装机', 'tools/00-install/check.mjs'],
  ['paths', '指针', 'tools/19-memory/path-check.mjs'],
  ['model', '模型', 'tools/13-model-check/model-check.mjs'],
  ['bom', 'BOM', 'tools/07-sync/bom-check.mjs']
]

const pick = process.argv[2]
const list = pick ? CHECKS.filter((c) => c[0] === pick) : CHECKS
if (pick && list.length === 0) {
  console.log('用法: node tools/00-install/doctor.mjs [install|paths|model|bom]')
  process.exit(2)
}

let failed = 0
for (const [key, label, rel] of list) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) { console.log('– ' + label + '：脚本不在（' + rel + '）'); continue }
  console.log('── ' + label)
  const r = spawnSync(process.execPath, [file], { cwd: ROOT, stdio: 'inherit', timeout: 120000 })
  if (r.status !== 0) failed += 1
}

console.log('')
console.log(failed === 0 ? '体检全过' : failed + ' 项没通过')
process.exit(failed ? 1 : 0)
