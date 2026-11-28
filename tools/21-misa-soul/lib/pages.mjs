// 分页：0 点和 12 点各刷一次（页是 12 小时一页，跑脚本只是把新消息追进当前页）。
// 开机时会补一次：如果上一次该跑的时间点已经过了却没跑（关机、DSH 没开），起来立刻补。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { atomicWrite } from './atomic.mjs'

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

function runScript(script, { onError, log }) {
  return new Promise((resolve) => {
    if (!fs.existsSync(script)) {
      log('分页脚本不存在：' + script)
      return resolve(false)
    }
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', (e) => {
      onError(e)
      resolve(false)
    })
    child.on('exit', (code) => resolve(code === 0))
  })
}

export function startPages({ home, log = () => {}, onError = () => {} } = {}) {
  const stateFile = path.join(home, '.pages-schedule.json')
  const scripts = [path.join(home, 'page-archive.mjs'), path.join(home, 'compact-session.mjs')]

  let timer = null
  let stopped = false
  let running = false

  const readLast = () => {
    try {
      return Number(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastRun) || 0
    } catch {
      return 0
    }
  }
  const writeLast = (ms) => {
    try {
      atomicWrite(stateFile, { lastRun: ms })
    } catch {}
  }

  const run = async (why) => {
    if (running || stopped) return
    running = true
    try {
      for (const s of scripts) await runScript(s, { onError, log })
      writeLast(Date.now())
      log(`分页刷新完成（${why}）`)
    } catch (e) {
      onError(e)
    } finally {
      running = false
    }
  }

  const arm = () => {
    if (stopped) return
    const ms = Math.max(60_000, nextBoundary() - Date.now())
    timer = setTimeout(async () => {
      await run('到点')
      arm()
    }, ms)
  }

  // 开机补跑：上一次该跑的点过了还没跑，说明那会儿不在
  const last = readLast()
  const boundary = latestBoundary()
  if (last < boundary) {
    const gap = Math.round((Date.now() - Math.max(last, boundary)) / 3600000)
    run(`补跑，距上次约 ${gap} 小时`)
  }
  arm()

  return { stop() { stopped = true; if (timer) clearTimeout(timer) } }
}
