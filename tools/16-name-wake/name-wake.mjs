// 名字叫醒：盯一个标记文件，发现有人喊名字就往「已打开的那个会话」里投一句。
// 依据：DSH 的 session/prompt 只认客户端已经打开的会话；QQ 私聊会话正是这种，所以能投。
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_POLL_MS = 3000
const MAX_ATTEMPTS = 3
// 标记最多活这么久，超了就丢。跟微信那边待发队列一个规矩：卡住的不许一直重试。
const STALE_MS = 10 * 60 * 1000

function readFlag(file) {
  try {
    const st = fs.statSync(file)
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (!raw) return null
    const [at, ...rest] = raw.split('|')
    return { at, text: rest.join('|').trim(), mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

function clearFlag(file) {
  try { fs.unlinkSync(file) } catch {}
}

/**
 * @param {object} opts
 * @param {() => string|undefined} opts.getController 惰性取 sessionController
 * @param {() => string[]} opts.getSessionIds 取要投的会话 id（按优先级）
 * @param {string} opts.flagFile 标记文件
 * @param {(msg: string) => void} [opts.log]
 */
export function startNameWake({ getController, getSessionIds, flagFile, pollMs = DEFAULT_POLL_MS, log = () => {} }) {
  let stopped = false
  let timer = null

  async function deliver(text) {
    const controller = getController()
    if (!controller?.prompt) {
      log('没有 sessionController，跳过这次叫醒')
      return false
    }
    const ids = getSessionIds().filter(Boolean)
    if (!ids.length) {
      log('没有可投的会话 id，跳过')
      return false
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      for (const sessionId of ids) {
        const ac = new AbortController()
        try {
          if (typeof controller.resume === 'function') {
            try { await controller.resume({ sessionId }) } catch {}
          }
          await controller.prompt(
            { sessionId, mode: 'queue', content: [{ type: 'text', text }] },
            ac.signal,
          )
          log(`已投进 ${sessionId}`)
          return true
        } catch (error) {
          const msg = String(error?.message ?? error)
          log(`投递失败（第 ${attempt + 1} 次，${sessionId}）：${msg}`)
          // 会话忙就等一会儿再试，别的错误也重试，总次数受控
        }
      }
      await new Promise((r) => setTimeout(r, 2500))
      if (stopped) return false
    }
    return false
  }

  async function tick() {
    if (stopped) return
    const flag = readFlag(flagFile)
    if (flag) {
      const age = Date.now() - flag.mtimeMs
      if (age > STALE_MS) {
        log(`标记过期（${age} 毫秒，${flag.at}），丢掉不再投`)
        clearFlag(flagFile)
      } else {
        const text = `【叫醒】群里有人在喊：${flag.text}\n（来自标记文件，${flag.at}）`
        const ok = await deliver(text)
        if (ok) {
          clearFlag(flagFile)
        } else {
          log(`投不进去，标记丢掉，等下次有人喊再投`)
          clearFlag(flagFile)
        }
      }
    }
    if (!stopped) timer = setTimeout(tick, pollMs)
  }

  timer = setTimeout(tick, pollMs)

  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
    /** 手动触发一次（测试用） */
    trigger(text) {
      return deliver(text)
    },
  }
}

export function defaultFlagFile(soulDir) {
  return path.join(soulDir, 'qq-call.flag')
}

