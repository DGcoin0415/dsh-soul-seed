// 接续整理：每 N 小时把最近的对话整理进 shared/接续.md，顺手扫一次跨会话聚合。
//
// 2026-11-24 master 定：从「定时任务起新会话跑脚本」改成插件内计时器——
// DSH 只要活着就自己跑，不新开会话、不占 token、会话关了也不断。
// 状态写 .continuity-schedule.json，DSH 重启后错过的时间点补跑一次。
//
// 整理脚本本身还是工作区里的那两个（tidy-continuity.mjs / cross-session.mjs），
// 插件只负责「什么时候跑」，脚本照旧可以手动 node 跑。
//
// 2026-11-27 master 定：每跑完一轮推一条短结论（走 dsh-notify），
// 开关在 .continuity-config.json 的 pushEachRun（默认 true）；
// 推送连不上/抛错/超时都只记日志，绝不影响整理本身。
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { soulDir } from './soul.mjs'
import { resolveNode } from './tidy.mjs'
import { atomicWrite } from './atomic.mjs'
import { noteSelf } from './selfnote.mjs'

const DEFAULT_HOURS = 6
const CONFIG_FILE = '.continuity-config.json'
const STATE_FILE = '.continuity-schedule.json'
const RUN_TIMEOUT = 5 * 60 * 1000
const PUSH_TIMEOUT = 10_000

/** 脚本位置两套都认：工作区根目录（老部署）或仓库的 tools/15-continuity。 */
const pick = (cands) => cands.find((p) => fs.existsSync(p)) || cands[0]

/** 读 .continuity-config.json：hours（间隔）和 pushEachRun（跑完推不推）。 */
function readConfig(home) {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(path.join(home, CONFIG_FILE), 'utf8')) || {}
  } catch {}
  const h = Number(raw?.hours)
  return {
    hours: Number.isFinite(h) && h >= 1 && h <= 72 ? h : DEFAULT_HOURS,
    // 默认推；想关就在 .continuity-config.json 里写 "pushEachRun": false
    pushEachRun: raw?.pushEachRun !== false,
  }
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

/**
 * 拼一条给 master 的短结论。
 * 数字从 tidy-continuity.mjs 的 stdout 里取：
 *   「接续 N 条 → 合并成 M 条；归档 X 条，留 Y 条（其中待核 Z 条）」
 * 留 Y 条里，待核 Z 条是「刚做完、还没归档」的，其余是没完的。
 * @param {{stdout?:string, slot?:number}} opts
 */
export function continuitySummary({ stdout = '', slot = Date.now() } = {}) {
  const kept = /留\s*(\d+)\s*条（其中待核\s*(\d+)\s*条）/.exec(stdout)
  const arc = /归档\s*(\d+)\s*条/.exec(stdout)
  const hour = String(new Date(slot).getHours()).padStart(2, '0')
  const head = kept
    ? `没完的 ${Math.max(0, Number(kept[1]) - Number(kept[2]))} 条，刚完成 ${Number(kept[2])} 条`
    : '这轮没数出条目'
  const extra = arc && Number(arc[1]) > 0 ? `，归档 ${Number(arc[1])} 条` : ''
  return `接续已整理：${head}${extra}，写了 接续.md（${hour}:00 这一轮）`
}

/** 跑一个整理脚本；失败只记日志，不抛。resolve 出 stdout（可能空串）。 */
function runScript(exe, env, script, label, log) {
  return new Promise((resolve) => {
    if (!fs.existsSync(script)) return resolve('')
    execFile(exe, [script], { cwd: path.dirname(script), timeout: RUN_TIMEOUT, env }, (err, stdout, stderr) => {
      if (err) log(`${label} 跑失败：` + String(stderr || err.message).split('\n')[0])
      else if (stdout) log(`${label}：` + String(stdout).split('\n')[0])
      resolve(String(stdout || ''))
    })
  })
}

/** 给推送加个总时长上限，免得 notify 卡住把整理进程拖着。 */
function withTimeout(promise, ms) {
  let timer = null
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer)
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`推送超时 ${Math.round(ms / 1000)} 秒`)), ms)
    }),
  ])
}

/**
 * 跑一轮接续整理（可手动调用，自检也用它）。
 * @param {{home?:string, log?:(s:string)=>void, onError?:(e:unknown)=>void,
 *          push?: (text:string)=>any, why?:string, stateFile?:string, force?:boolean}} opts
 */
export async function runContinuityOnce({
  home = soulDir(),
  log = () => {},
  onError = () => {},
  push = null,
  why = '手动',
  stateFile = path.join(home, STATE_FILE),
  force = false,
} = {}) {
  const cfg = readConfig(home)
  const slot = latestSlot(cfg.hours)
  let lastPushSlot = 0
  try {
    lastPushSlot = Number(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastPushSlot) || 0
  } catch {}

  if (String(why).includes('补跑')) {
    try {
      noteSelf(home, '醒来', why)
    } catch {}
  }

  let nodeRef = { exe: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  try {
    nodeRef = resolveNode()
  } catch (e) {
    try {
      onError(e)
    } catch {}
  }

  const tidyScript = pick([path.join(home, 'tidy-continuity.mjs'), path.join(home, 'tools', '15-continuity', 'tidy-continuity.mjs')])
  const crossScript = pick([path.join(home, 'cross-session.mjs'), path.join(home, 'tools', '15-continuity', 'cross-session.mjs')])
  const auditScript = pick([path.join(home, 'track-audit.mjs'), path.join(home, 'tools', '15-continuity', 'track-audit.mjs')])

  const tidyOut = await runScript(nodeRef.exe, nodeRef.env, tidyScript, '接续', log)
  await runScript(nodeRef.exe, nodeRef.env, crossScript, '跨会话', log)
  await runScript(nodeRef.exe, nodeRef.env, auditScript, '轨道审计', log)

  // ---------- 推送：同一轮只推一次，失败不影响上面的整理结果 ----------
  const summary = continuitySummary({ stdout: tidyOut, slot })
  let pushed = 'skipped'
  if (!cfg.pushEachRun) {
    pushed = 'off'
    log('推送关着（pushEachRun=false），这轮只整理')
  } else if (typeof push !== 'function') {
    pushed = 'no-pusher'
    log(`没有 pusher，这轮不推：${summary}`)
  } else if (!force && lastPushSlot >= slot) {
    pushed = 'dup'
    log(`这个槽位已经推过，不重复推：${summary}`)
  } else {
    lastPushSlot = slot // 先记上，失败也不重复推同一条
    try {
      await withTimeout(push(summary), PUSH_TIMEOUT)
      pushed = 'ok'
      log(`推送完成：${summary}`)
    } catch (e) {
      pushed = 'error'
      log(`推送失败（不影响整理）：${e?.message ?? e}`)
    }
  }

  try {
    atomicWrite(stateFile, { lastRun: Date.now(), hours: cfg.hours, lastPushSlot })
  } catch {}
  log(`接续整理完成（${why}）`)
  return { summary, pushed, slot, hours: cfg.hours, keep: tidyOut }
}

/**
 * 起插件内的接续整理计时器。
 * @param {{home?:string, hours?:number, log?:(s:string)=>void, onError?:(e:unknown)=>void,
 *          push?: (text:string)=>any}} opts
 */
export function startContinuityLoop({ home = soulDir(), hours, log = () => {}, onError = () => {}, push = null } = {}) {
  const cfg = readConfig(home)
  const every = Number(hours) > 0 ? Number(hours) : cfg.hours
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

  const tick = (why) => {
    if (running || stopped) return
    running = true
    runContinuityOnce({ home, log, onError, push, why, stateFile })
      .catch((e) => {
        try {
          onError(e)
        } catch {}
      })
      .finally(() => {
        running = false
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
