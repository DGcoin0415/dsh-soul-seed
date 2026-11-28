/**
 * dsh-ctx-alert · 到 70% 自动写交接（不调模型、不花一分钱）
 *
 * 干什么：占用第一次到「倒数第二轮」那条线（默认第 0 轮 70%）时，除了推送，
 * 顺手在 shared/交接.md 的「刚完成」段补一行：
 *   - [HH:MM] 上下文 70%，本会话先写交接（插件自动） · 会话 session-xxx
 *
 * 规矩：
 *   - 只插这一行，别整篇重写（读全文 → 插一行 → 原子写回）；
 *   - 幂等：同一会话已经在「刚完成」里写过就跳过，写两遍也只留一条；
 *   - 没有「刚完成」段就在文末补一个；文件不在就建一个最小的；
 *   - 写失败只返回原因，绝不抛（不能因为写盘挂了影响告警）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { beijingStamp } from './store.mjs'

export const AUTO_TAG = '（插件自动）'
export const SECTION_RE = /^##\s*刚完成/
const HEADING_RE = /^##\s/

export function handoffLine({ sessionId, pct, at = Date.now() }) {
  const t = beijingStamp(at)
  const p = Math.round(Number(pct) || 0)
  return `- [${t.time}] 上下文 ${p}%，本会话先写交接${AUTO_TAG} · 会话 ${String(sessionId || '')}`
}

/** 「刚完成」段的起止行号；没有返回 null。 */
export function findSection(lines) {
  const start = lines.findIndex((l) => SECTION_RE.test(String(l).trim()))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADING_RE.test(String(lines[i]))) {
      end = i
      break
    }
  }
  return { start, end }
}

function atomicWrite(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {}
  }
}

/**
 * 写一行到「刚完成」。
 * @returns {{ok:boolean, added:boolean, reason:string, file:string, line:string}}
 */
export function writeHandoff({ file, sessionId, pct, at = Date.now() }) {
  const out = { ok: false, added: false, reason: '', file, line: '' }
  try {
    const sid = String(sessionId || '').trim()
    if (!file) return { ...out, reason: '没给交接文件路径' }
    if (!sid) return { ...out, reason: '没有会话 id' }
    const line = handoffLine({ sessionId: sid, pct, at })
    out.line = line

    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      text = ''
    }
    const existed = Boolean(text)
    const eol = /\r\n/.test(text) ? '\r\n' : '\n'
    const lines = text ? text.split(eol) : []
    const sec = findSection(lines)

    // 幂等：这个会话已经在「刚完成」里写过自动条就跳过
    if (sec) {
      const body = lines.slice(sec.start, sec.end).join('\n')
      if (body.includes(AUTO_TAG) && body.includes(sid)) {
        return { ...out, ok: true, added: false, reason: '这个会话已经写过' }
      }
    }

    if (!sec) {
      // 没有这一段：文末补一个
      const base = text && !text.endsWith(eol) ? text + eol : text
      const block = `${base}${base ? eol : ''}## 刚完成${eol}${eol}${line}${eol}`
      atomicWrite(file, block)
      return { ...out, ok: true, added: true, reason: existed ? '补了「刚完成」段' : '新建交接文件' }
    }

    // 有这一段：插到段尾（跳过尾部空行）
    let at2 = sec.end
    while (at2 - 1 > sec.start && String(lines[at2 - 1]).trim() === '') at2 -= 1
    const next = [...lines.slice(0, at2), line, ...lines.slice(at2)]
    atomicWrite(file, next.join(eol))
    return { ...out, ok: true, added: true, reason: '插到「刚完成」段尾' }
  } catch (e) {
    return { ...out, ok: false, added: false, reason: String(e?.message || e) }
  }
}

export const _internals = { atomicWrite, findSection }
