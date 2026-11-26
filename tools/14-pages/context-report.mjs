#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { soulHome } from '../../lib/home.mjs'
import { readRecords, newestSessionFile } from '../../lib/sessionlog.mjs'
import { analyze, render } from '../../lib/ctxreport.mjs'

// 上下文账：把一轮的输入拆开，看看空间被谁吃了。
//
//   node tools/14-pages/context-report.mjs               看最新会话
//   node tools/14-pages/context-report.mjs <session-id>   看指定会话
//   node tools/14-pages/context-report.mjs --json         给程序看
//
// 只读会话日志：不调模型、不花钱、不改任何文件。

const DSH = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SESSIONS = path.join(DSH, 'sessions')
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const want = args.find((a) => !a.startsWith('--'))

let file = null
if (want) {
  // 按 session id 找：目录名里包含
  const found = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) { if (e.name.includes(want)) found.push(full); else walk(full) }
    }
  }
  try { walk(SESSIONS) } catch {}
  for (const dir of found) {
    const f = path.join(dir, 'session.v4.jsonl.zstd')
    if (fs.existsSync(f)) file = f
  }
} else {
  const newest = newestSessionFile(SESSIONS)
  file = newest?.file || null
}

if (!file) {
  console.error('没找到会话日志（可用参数给 session id）')
  process.exit(1)
}

// 外部注入的规模：人格与账本
const home = soulHome()
const sizeOf = (rel) => {
  try { return fs.readFileSync(path.join(home, rel), 'utf8').length } catch { return 0 }
}
const extra = {
  personaChars: sizeOf('persona.md'),
  memoryChars: sizeOf('memory.json'),
  peopleChars: sizeOf('people.json')
}

const records = readRecords(file)
const report = analyze(records, extra)

if (asJson) {
  console.log(JSON.stringify({ file, size: fs.statSync(file).size, records: records.length, ...report }, null, 2))
} else {
  console.log('文件：' + file)
  console.log('大小：' + (fs.statSync(file).size / 1024 / 1024).toFixed(2) + ' MB，记录 ' + records.length + ' 条')
  console.log('')
  console.log(render(report))
}
