import { sharedPath } from '../../lib/shared.mjs'
import os from 'node:os'
import path from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { writeFileRetry } from '../19-memory/write-retry.mjs'

const NODE = path.join(os.homedir(), '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe')
const MOOD_DIR = path.join(os.homedir(), '.bili-ai')
const MOOD_JSON = MOOD_DIR + '/mood.json'
const SHARED = sharedPath('shared', 'mood.md')
const MARK = '## MOOD-AUTO 当前心情'

const STAMP = sharedPath('.mood-sync-stamp.json')

function runMood() {
  try {
    execFileSync(NODE, ['mood.mjs'], { cwd: MOOD_DIR, timeout: 120000, stdio: 'pipe' })
    return true
  } catch (e) {
    return false
  }
}

function readStamp() {
  try { return JSON.parse(readFileSync(STAMP, 'utf8')) } catch { return {} }
}

function writeStamp(entry) {
  const key = `${entry.mood?.composite}|${entry.mood?.name}|${entry.mood?.emotion?.label}`
  writeFileRetry(STAMP, JSON.stringify({ at: entry.at, key }))
}

function latest() {
  const arr = JSON.parse(readFileSync(MOOD_JSON, 'utf8'))
  return Array.isArray(arr) ? arr[arr.length - 1] : arr
}

function fmt(entry) {
  const m = entry.mood || {}
  const when = new Date().toLocaleString('zh-CN', { hour12: false })
  const name = m.name || '?'
  const comp = m.composite ?? '?'
  const emo = m.emotion?.label ?? '?'
  const band = m.policy?.band ?? '?'
  const feel = m.flags?.feeling || m.why?.[0] || ''
  const lines = [
    MARK,
    '',
    `- 更新时间：${when}`,
    `- 心情：${name}（综合 ${comp}/100）· 情绪 ${emo} · 说话档 ${band}`,
  ]
  if (m.reason) lines.push(`- 来源：${m.reason}`)
  if (m.policy?.note) lines.push(`- 说话方式：${m.policy.note}`)
  lines.push('')
  return lines.join('\n')
}

function updateShared(block) {
  let text = existsSync(SHARED) ? readFileSync(SHARED, 'utf8') : ''
  const start = text.indexOf(MARK)
  if (start >= 0) {
    const rest = text.slice(start + MARK.length)
    const nextIdx = rest.indexOf('\n## ')
    const end = nextIdx >= 0 ? start + MARK.length + nextIdx + 1 : text.length
    text = text.slice(0, start) + block + (end < text.length ? text.slice(end) : '')
  } else {
    text = text.trimEnd() + '\n\n' + block
  }
  writeFileRetry(SHARED, text)
}

function updateCard(entry) {
  const card = path.join(os.homedir(), '.dsh/persona-cards/memories/card-mvqnzinf.json')
  if (!existsSync(card)) return false
  try {
    const d = JSON.parse(readFileSync(card, 'utf8'))
    const m = entry.mood || {}
    d.mood = `${m.name ?? '平常心'}（${m.composite ?? '?'}/100，${m.emotion?.label ?? '照常'}）`
    d.updatedAt = new Date().toISOString()
    writeFileRetry(card, JSON.stringify(d, null, 2))
    return true
  } catch {
    return false
  }
}

// 顺手把「现在」那页的心情一行也刷了：新会话开局读它，别写成一成不变的心情
function updateNow(entry) {
  const nowFile = sharedPath('shared', '现在.md')
  if (!existsSync(nowFile)) return false
  try {
    const m = entry.mood || {}
    const line = `- ${m.name ?? '平常心'}（${m.composite ?? '?'}/100，${m.emotion?.label ?? '照常'}）。`
    const text = readFileSync(nowFile, 'utf8')
    const i = text.indexOf('## 心情')
    if (i < 0) return false
    const head = text.slice(0, i)
    const rest = text.slice(i)
    const updated = rest.replace(/^## 心情[\s\S]*?(?=\n## |$)/, `## 心情\n\n${line}\n`)
    writeFileRetry(nowFile, head + updated)
    return true
  } catch {
    return false
  }
}

runMood()
const entry = latest()
if (!entry) { console.log('no mood entry'); process.exit(1) }

const stamp = readStamp()
const force = process.argv.includes('--force')
const key = `${entry.mood?.composite}|${entry.mood?.name}|${entry.mood?.emotion?.label}`
if (!force && stamp.key && stamp.key === key) {
  console.log('心情没变，跳过', key)
  process.exit(0)
}

// 写进公用记忆（同一区块直接覆盖，不追加）；--no-shared 时只改人设卡
if (!process.argv.includes('--no-shared')) updateShared(fmt(entry))
const nowOk = updateNow(entry)
const cardOk = updateCard(entry)
writeStamp(entry)
console.log('synced', entry.mood?.name, entry.mood?.composite, cardOk ? '+card' : '', nowOk ? '+now' : '')
