import { sharedHome } from '../../lib/shared.mjs'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

// 指针体检：把每轮都注入的那两页里反引号包着的路径挨个走一遍，走不通的报出来。
// 用法：node path-check.mjs [--quiet]
// 只读不写，不花钱；挂进每日修枝。
const IM = sharedHome()
const FILES = ['SHARED-STATE.md', 'AGENTS.md']
const SKIP = ['://', 'github.com', 'node ', 'git ', 'npm ', 'pnpm ', '--', '\\', '<', '>', '|', 'YYYY', 'XX', 'qq-pending-check']

const quiet = process.argv.includes('--quiet')

const exists = (p) => {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

// 相对路径可能在 IM 根、也可能在 shared/ 下，两边都试
const resolveOne = (raw, fromFile) => {
  const candidates = []
  if (raw.startsWith('~')) candidates.push(path.join(os.homedir(), raw.slice(1)))
  else if (path.isAbsolute(raw)) candidates.push(raw)
  else {
    candidates.push(path.join(IM, raw), path.join(IM, 'shared', raw), path.join(path.dirname(fromFile), raw))
  }
  return candidates
}

const missing = []
const optional = []          // 可选文件：缺了只提示，不算失败
for (const rel of FILES) {
  const file = path.join(IM, rel)
  if (!exists(file)) {
    // SHARED-STATE.md 只在配了跨工作区同步时才有；AGENTS.md 取决于部署者的工作区模板。
    // 这两个不是坏的证据，报成失败会让人天天看见红灯。
    optional.push(rel)
    continue
  }
  const text = fs.readFileSync(file, 'utf8')
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1].trim().replace(/[，。；、）)]+$/, '')
    if (!raw || raw.includes(' ') || raw.length > 120) continue
    if (SKIP.some((s) => raw.includes(s))) continue
    if (!raw.includes('/') && !raw.includes('.')) continue
    if (!/^[~./A-Za-z_\u4e00-\u9fa5]/.test(raw)) continue
    if (!resolveOne(raw, file).some(exists)) missing.push(`${rel} → ${raw}`)
  }
}

const uniq = [...new Set(missing)]
if (optional.length && !quiet) {
  console.log('可选页不在（不算问题）：' + optional.join('、'))
}
if (uniq.length === 0) {
  if (!quiet) console.log('指针全通，没有走不通的')
  process.exit(0)
}
console.log(`有 ${uniq.length} 处指针走不通：`)
for (const u of uniq) console.log(' - ' + u)
process.exit(1)
