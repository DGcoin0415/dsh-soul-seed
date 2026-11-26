// 接续整理常驻进程：每 2 小时跑一次 tidy-continuity.mjs，不占 token。
// 顺带：跨会话开关打开时，每次也跑一遍 cross-session.mjs（扫描别的会话说过什么）。
// 用法：node tidy-loop.mjs        （或双击 start-tidy-loop.vbs 隐藏启动）
// 日志：.tidy-loop.log；pid：shared/.tidy-loop.pid
//
// 2026-11-20 master 定：从「定时任务起会话」改成常驻进程，省 token。
// 2026-11-21 master 定：跨会话做成开关（shared/跨会话.json），开的时候自动扫。
// DSH 或电脑重启后要重新拉一次（双击 start-tidy-loop.vbs）。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HOME = process.env.SOUL_HOME || path.join(os.homedir(), '.dsh', 'im')
const NODE = process.execPath
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'tidy-continuity.mjs')
const XSCRIPT = path.join(HERE, 'cross-session.mjs')
const PID = path.join(HOME, 'shared', '.tidy-loop.pid')
const LOG = path.join(HOME, '.tidy-loop.log')
const EVERY = 2 * 3600 * 1000

function log(s) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${s}`
  try { fs.appendFileSync(LOG, line + '\n') } catch {}
  // 日志超过 200KB 就截一半
  try {
    if (fs.statSync(LOG).size > 200 * 1024) {
      const t = fs.readFileSync(LOG, 'utf8')
      fs.writeFileSync(LOG, t.slice(-100 * 1024))
    }
  } catch {}
}

function run(script, label, cb) {
  if (!fs.existsSync(script)) return cb && cb()
  execFile(NODE, [script], { cwd: HERE, timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
    if (err) {
      log(`${label} 跑失败：` + (stderr || err.message).split('\n')[0])
    } else if (stdout) {
      const first = stdout.split('\n')[0] || '（无输出）'
      if (!/归档 0 条/.test(first) || !/待核 0 条/.test(first)) log(`${label}：${first}`)
    }
    if (cb) cb()
  })
}

// 已经在跑就别起第二个
try {
  if (fs.existsSync(PID)) {
    const p = Number(fs.readFileSync(PID, 'utf8').trim())
    if (p && p !== process.pid) {
      process.kill(p, 0)
      console.log('已经有进程在跑，pid=' + p)
      process.exit(0)
    }
  }
} catch {}
try { fs.mkdirSync(path.dirname(PID), { recursive: true }); fs.writeFileSync(PID, String(process.pid)) } catch {}

function tick() {
  run(SCRIPT, '接续', () => run(XSCRIPT, '跨会话'))
}

log('启动，每 2 小时整理一次接续' + (fs.existsSync(XSCRIPT) ? '（跨会话开关打开时顺带扫描）' : ''))
tick()
setInterval(tick, EVERY)

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
