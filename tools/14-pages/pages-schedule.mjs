import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 分页的定时器：0 点 / 12 点各刷一次；开机发现错过了就立刻补跑。
// 用法：node tools/14-pages/pages-schedule.mjs      （前台常驻，适合挂到自己的守护里）
// 可选环境变量：SOUL_HOME（默认 ~/.dsh/im）
const HOME = process.env.SOUL_HOME || path.join(os.homedir(), '.dsh', 'im')
const STATE = path.join(HOME, '.pages-schedule.json')
const SCRIPTS = [path.join(HOME, 'page-archive.mjs'), path.join(HOME, 'compact-session.mjs')]

// 最近一个该跑的时间点：今天 0:00 或 12:00
export function latestBoundary(now = Date.now()) {
  const d = new Date(now)
  d.setMinutes(0, 0, 0)
  if (d.getHours() >= 12) d.setHours(12)
  else d.setHours(0)
  return d.getTime()
}

// 下一个该跑的时间点
export function nextBoundary(now = Date.now()) {
  const d = new Date(now)
  d.setMinutes(0, 0, 0)
  if (d.getHours() < 12) d.setHours(12)
  else {
    d.setDate(d.getDate() + 1)
    d.setHours(0)
  }
  return d.getTime()
}

function readLast() {
  try {
    return Number(JSON.parse(fs.readFileSync(STATE, 'utf8')).lastRun) || 0
  } catch {
    return 0
  }
}

function writeLast(ms) {
  try {
    fs.writeFileSync(STATE, JSON.stringify({ lastRun: ms }), 'utf8')
  } catch {}
}

function runScript(script) {
  return new Promise((resolve) => {
    if (!fs.existsSync(script)) {
      console.log('缺脚本：' + script)
      return resolve(false)
    }
    // 用 Electron 当 node 跑也行（这台机器没装 node 时就是这么跑的）
    const env = { ...process.env }
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    const child = spawn(process.execPath, [script], { env, stdio: 'ignore', windowsHide: true })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

async function run(why) {
  for (const s of SCRIPTS) await runScript(s)
  writeLast(Date.now())
  console.log(`[${new Date().toLocaleString()}] 分页刷新完成（${why}）`)
}

function arm() {
  const ms = Math.max(60_000, nextBoundary() - Date.now())
  setTimeout(async () => {
    await run('到点')
    arm()
  }, ms)
}

const last = readLast()
const boundary = latestBoundary()

// 被 import 时只提供两个时间函数，不自己开跑
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

if (isMain) {
  if (last < boundary) {
    const gap = Math.round((Date.now() - Math.max(last, boundary)) / 3600000)
    await run(`补跑，距上次约 ${gap} 小时`)
    console.log('补跑完了，接下来到 0 点 / 12 点再跑。')
  } else {
    console.log('已经跑过了，等下一个 0 点 / 12 点。')
  }
  arm()
}
