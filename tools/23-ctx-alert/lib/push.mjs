/**
 * dsh-ctx-alert · 推送通道
 *
 * 复用已装好的 dsh-notify（不重造）：
 *   1. 动态 import dsh-notify 的 lib/core.mjs，createNotify({workspace, agents}) 直接 push，
 *      带 sessionId 就会 followup 回发起会话（在哪问的在哪回）；
 *   2. import 不到（插件没装/路径变了）就退回收件箱：往 <工作区>/.notify-outbox/ 丢一个 JSON，
 *      下一轮 notify 轮询会捡走。
 * 两条都失败只记日志，不抛、不影响被监控的会话。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

let moduleCache = { tried: false, mod: null, file: '' }
let notifyCache = { key: '', instance: null }

function candidateFiles() {
  const home = os.homedir()
  const profile = String(process.env.DSH_PROFILE || '').trim()
  const out = []
  if (profile) {
    out.push(path.join(home, '.dsh', 'profiles', profile, 'node_modules', 'dsh-notify', 'lib', 'core.mjs'))
  }
  out.push(path.join(home, '.dsh', 'plugins', 'dsh-notify', 'lib', 'core.mjs'))
  return out
}

export async function loadNotify() {
  if (moduleCache.tried) return moduleCache.mod
  moduleCache.tried = true
  for (const file of candidateFiles()) {
    try {
      if (!fs.existsSync(file)) continue
      const mod = await import(pathToFileURL(file).href)
      if (typeof mod.createNotify === 'function') {
        moduleCache.mod = mod
        moduleCache.file = file
        return mod
      }
    } catch {
      // 换下一个候选
    }
  }
  return null
}

function notifyInstance(workspace, agents) {
  const mod = moduleCache.mod
  if (!mod) return null
  const key = `${workspace}|${agents ? 'agents' : 'noagents'}`
  if (notifyCache.instance && notifyCache.key === key) return notifyCache.instance
  try {
    const instance = mod.createNotify({ workspace, agents: agents || null })
    notifyCache = { key, instance }
    return instance
  } catch {
    return null
  }
}

/** 收件箱兜底：notify 插件每轮会扫这里。 */
export function writeInbox(inboxDir, text, sessionId) {
  try {
    fs.mkdirSync(inboxDir, { recursive: true })
    const name = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`
    const file = path.join(inboxDir, name)
    fs.writeFileSync(file, JSON.stringify({ text, source: 'ctx-alert', session: String(sessionId || '') }, null, 2), 'utf8')
    return file
  } catch {
    return ''
  }
}

/**
 * 推一条。
 * @returns {Promise<{ok:boolean, channel:string, reason:string}>}
 */
export async function pushAlert({ workspace, inboxDir, agents, text, sessionId }) {
  if (!text) return { ok: false, channel: '', reason: '空内容' }
  const mod = await loadNotify()
  if (mod) {
    const instance = notifyInstance(workspace, agents)
    if (instance) {
      try {
        const r = await instance.push({ source: 'ctx-alert', text, sessionId: String(sessionId || '') })
        if (r?.ok) return { ok: true, channel: String(r.channel || 'notify'), reason: '' }
        // 会话投不进去（会话退了 / 换了新的）也走收件箱兜底，别把消息丢了（2026-11-27 master 定）
        const fb = writeInbox(inboxDir, text, '')
        if (fb) return { ok: true, channel: '收件箱（原会话不在）', reason: '' }
        return { ok: false, channel: '', reason: String(r?.reason || 'notify 未推出去') }
      } catch (e) {
        const fb = writeInbox(inboxDir, text, '')
        if (fb) return { ok: true, channel: '收件箱（notify 异常）', reason: '' }
        return { ok: false, channel: '', reason: String(e?.message || e) }
      }
    }
  }
  const file = writeInbox(inboxDir, text, sessionId)
  if (file) return { ok: true, channel: '收件箱（等 notify 轮询）', reason: '' }
  return { ok: false, channel: '', reason: 'notify 不可用，收件箱也写不进去' }
}

export const _internals = { candidateFiles, moduleCache }
