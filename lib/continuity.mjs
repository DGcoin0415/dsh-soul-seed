// 接续整理：每 N 小时把最近的对话整理进 shared/接续.md，顺手扫一次跨会话聚合。
//
// 2026-11-24 master 定：从「定时任务起新会话跑脚本」改成插件内计时器——
// DSH 只要活着就自己跑，不新开会话、不占 token、会话关了也不断。
// 状态写 .continuity-schedule.json，DSH 重启后错过的时间点补跑一次。
//
// 整理脚本本身还是工作区里的那两个（tidy-continuity.mjs / cross-session.mjs），
// 插件只负责「什么时候跑」，脚本照旧可以手动 node 跑。
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { soulDir } from './soul.mjs'
import { resolveNode } from './tidy.mjs'

const DEFAULT_HOURS = 6
const CONFIG_FILE = '.continuity-config.json'
const STATE_FILE = '.continuity-schedule.json'
const RUN_TIMEOUT = 5 * 60 * 1000

/** 脚本位置两套都认：工作区根目录（老部署）或仓库的 tools/15-continuity。 */
const pick = (cands) => cands.find((p) => fs.existsSync(p)) || cands[0]

function readHours(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, CONFIG_FILE), 'utf8'))
    const h = Number(raw?.hours)
    if (Number.isFinite(h) && h >= 1 && h <= 72) return h
  } catch {}
  return DEFAULT_HOURS
}

/** 对齐到整点的槽位：以本地 0 点为基准，每 hours 小时一个。 */
function slotOf(ms, hours) {
  const d = new Date(ms)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const step = hours * 3600_000
  return start + Math.floor((ms - start) / step) * step
}

export function latestSlot(hours = DEFAULT_HOURS, now = Date.now()) {
  return slotOf(now, hours)
}

export function nextSlot(hours = DEFAULT_HOURS, now = Date.now()) {
  return slotOf(now, hours) + hours * 3600_000
}

/** 跑一个整理脚本；失败只记日志，不抛。 */
function runScript(exe, env, script, label, log, done) {
  if (!fs.existsSync(script)) return done()
  execFile(exe, [script], { cwd: path.dirname(script), timeout: RUN_TIMEOUT, env }, (err, stdout, stderr) => {
    if (err) log(`${label} 跑失败：` + String(stderr || err.message).split('\n')[0])
    else if (stdout) log(`${label}：` + String(stdout).split('\n')[0])
    done()
  })
}

/**
 * 起插件内的接续整理计时器。
 * @param {{home?:string, hours?:number, log?:(s:string)=>void, onError?:(e:unknown)=>void}} opts
 */
export function startContinuityLoop({ home = soulDir(), hours, log = () => {}, onError = () => {} } = {}) {
  const every = Number(hours) > 0 ? Number(hours) : readHours(home)
  const stateFile = path.join(home, STATE_FILE)
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
      fs.writeFileSync(stateFile, JSON.stringify({ lastRun: ms, hours: every }), 'utf8')
    } catch {}
  }

  const tick = (why) => {
    if (running || stopped) return
    running = true
    let nodeRef = { exe: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
    try {
      nodeRef = resolveNode()
    } catch (e) {
      onError(e)
    }
    const tidyScript = pick([path.join(home, 'tidy-continuity.mjs'), path.join(home, 'tools', '15-continuity', 'tidy-continuity.mjs')])
    const crossScript = pick([path.join(home, 'cross-session.mjs'), path.join(home, 'tools', '15-continuity', 'cross-session.mjs')])
    const auditScript = pick([path.join(home, 'track-audit.mjs'), path.join(home, 'tools', '15-continuity', 'track-audit.mjs')])
    runScript(nodeRef.exe, nodeRef.env, tidyScript, '接续', log, () => {
      runScript(nodeRef.exe, nodeRef.env, crossScript, '跨会话', log, () => {
        runScript(nodeRef.exe, nodeRef.env, auditScript, '轨道审计', log, () => {
          writeLast(Date.now())
          log(`接续整理完成（${why}）`)
          running = false
        })
      })
    })
  }

  const arm = () => {
    if (stopped) return
    const ms = Math.max(60_000, nextSlot(every) - Date.now())
    timer = setTimeout(() => {
      tick('到点')
      arm()
    }, ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  // 开机补跑：上次该跑的槽位过了还没跑，说明那会儿 DSH 不在
  const last = readLast()
  const boundary = latestSlot(every)
  if (last < boundary) {
    const gap = Math.max(1, Math.round((Date.now() - Math.max(last, boundary)) / 3600_000))
    tick(`补跑，距上次约 ${gap} 小时`)
  }
  arm()

  return {
    hours: every,
    nextAt: nextSlot(every),
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
