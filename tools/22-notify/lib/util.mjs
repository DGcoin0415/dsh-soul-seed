/**
 * dsh-notify · 小工具
 * 原子写、读 JSON、日志（脱敏）、时间戳。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const BJ_OFFSET = 8 * 3600_000

const pad2 = (n) => String(n).padStart(2, '0')

/** 北京时间 "MM-DD HH:mm" */
export function bjShort(ms = Date.now()) {
  const t = new Date(Number(ms) + BJ_OFFSET)
  return `${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())} ${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`
}

/** 北京时间 "YYYY-MM-DD HH:mm:ss" */
export function bjFull(ms = Date.now()) {
  const t = new Date(Number(ms) + BJ_OFFSET)
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())} ${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}:${pad2(t.getUTCSeconds())}`
}

/** 北京时间 "YYYY-MM-DD"（当天 key） */
export function bjDay(ms = Date.now()) {
  const t = new Date(Number(ms) + BJ_OFFSET)
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`
}

/** 日志/报错里别把 token 带出去（UUID/会话 id 不算密钥，留着好对账）。 */
export function redact(text) {
  return String(text == null ? '' : text)
    .split(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/[A-Za-z0-9+/=_-]{28,}/g, '<redacted>')))
    .join('')
    .replace(/(Bearer\s+)\S+/gi, '$1<redacted>')
}

export function clip(text, n = 400) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

/**
 * 保留换行的截断（推送正文用）。
 * clip() 会把整条压成一行，新闻/早报的「每条一行」排版就全毁了，所以正文走这个：
 * 行内多空格收成一个、连续空行收成一行、整条超长才截断。
 */
export function clipLines(text, n = 400) {
  const lines = String(text == null ? '' : text)
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, ' ').trimEnd())
  const out = []
  for (const l of lines) {
    if (!l.trim() && (!out.length || !out[out.length - 1].trim())) continue
    out.push(l)
  }
  let s = out.join('\n').trim()
  if (s.length > n) s = s.slice(0, n) + '…'
  return s
}

export function readJson(file, fallback) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' ? raw : fallback
  } catch {
    return fallback
  }
}

export function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(temp, file)
  } finally {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp)
    } catch {}
  }
}

export function appendLog(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `- ${bjFull()} ${redact(line)}\n`, 'utf8')
  } catch {}
}

export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {}
}
