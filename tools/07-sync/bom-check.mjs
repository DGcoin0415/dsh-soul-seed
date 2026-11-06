// BOM 体检：JSON/YAML/JS 不能带 BOM（DSH 读配置会直接崩），
// 带中文的 PowerShell 脚本必须带 BOM（否则按 ANSI 读成乱码）。
//
// 用法：
//   node bom-check.mjs            只报，不改
//   node bom-check.mjs --fix      按规则修正

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const FIX = process.argv.includes('--fix')
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const ROOT = process.env.DSH_BOM_ROOT || path.join(os.homedir(), '.dsh')

// JSON / YAML / JS / MD：不能有 BOM
// 只有会被程序解析的才怕 BOM；md/txt 带 BOM 无所谓，不查
const NO_BOM = /\.(json|jsonl|ya?ml|mjs|cjs|js|ts|ndjson)$/i
// PowerShell：有中文就建议带 BOM
const PS = /\.ps1$/i

const problems = []
const fixed = []

function walk(dir, depth = 0) {
  if (depth > 4) return
  let items
  try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const it of items) {
    if (it.name === 'node_modules' || it.name === '.git') continue
    const full = path.join(dir, it.name)
    if (it.isDirectory()) { walk(full, depth + 1); continue }
    if (!/\.(json|jsonl|ya?ml|mjs|cjs|js|ts|md|txt|ndjson|ps1)$/i.test(it.name)) continue
    let buf
    try { buf = fs.readFileSync(full) } catch { continue }
    if (buf.length > 2_000_000) continue
    const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf

    if (NO_BOM.test(it.name)) {
      if (hasBom) {
        problems.push({ file: full, type: '多余 BOM', hint: 'JSON/YAML/JS 带 BOM 会被解析失败' })
        if (FIX) {
          fs.writeFileSync(full, buf.subarray(3))
          fixed.push(full)
        }
      }
      // JSON 额外校验语法
      if (/\.json$/i.test(it.name) && buf.length < 500_000) {
        const text = (hasBom && !FIX ? buf.subarray(3) : buf).toString('utf8')
        try { JSON.parse(text) } catch (e) {
          problems.push({ file: full, type: 'JSON 语法错', hint: String(e.message).slice(0, 80) })
        }
      }
    } else if (PS.test(it.name)) {
      const text = (hasBom ? buf.subarray(3) : buf).toString('utf8')
      const hasCJK = /[\u4e00-\u9fa5]/.test(text)
      if (hasCJK && !hasBom) {
        problems.push({ file: full, type: '缺 BOM（含中文）', hint: '会被按 ANSI 读成乱码' })
        if (FIX) {
          fs.writeFileSync(full, Buffer.concat([BOM, buf]))
          fixed.push(full)
        }
      }
    }
  }
}

walk(ROOT)

if (!problems.length) {
  console.log('✓ 没发现问题')
} else {
  console.log(`发现 ${problems.length} 处：`)
  for (const p of problems) {
    console.log(`- [${p.type}] ${p.file.replace(ROOT, '~/.dsh')}`)
    console.log(`  ${p.hint}`)
  }
  if (FIX) console.log(`\n已修正 ${fixed.length} 个文件`)
  else console.log('\n加 --fix 试一下自动修正')
}
process.exit(problems.length && !FIX ? 1 : 0)
