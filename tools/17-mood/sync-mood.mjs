import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

// 心情同步：跑一遍心情脚本，把结果写进 shared/mood.md 和那本人设卡。
// 用法：node tools/17-mood/sync-mood.mjs [--force] [--no-shared]
//   SOUL_HOME     灵魂工作区（默认 ~/.dsh/im）
//   SOUL_MOOD_DIR 心情脚本所在目录（默认 ~/.bili-ai，里面要有 mood.mjs / mood.json）
const SOUL = process.env.SOUL_HOME || path.join(os.homedir(), '.dsh', 'im')
const MOOD_DIR = process.env.SOUL_MOOD_DIR || path.join(os.homedir(), '.bili-ai')
const MOOD_JSON = path.join(MOOD_DIR, 'mood.json')
const SHARED = path.join(SOUL, 'shared', 'mood.md')
const STAMP = path.join(SOUL, '.mood-sync-stamp.json')
const CARD = path.join(os.homedir(), '.dsh', 'persona-cards', 'memories', 'card-mvqnzinf.json')
const MARK = '## MOOD-AUTO 当前心情'

function runMood() {
  try {
    execFileSync(process.execPath, ['mood.mjs'], { cwd: MOOD_DIR, timeout: 120000, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function readStamp() {
  try { return JSON.parse(readFileSync(STAMP, 'utf8')) } catch { return {} }
}

function writeStamp(entry) {
  const key = `${entry.mood?.composite}|${entry.mood?.name}|${entry.mood?.emotion?.label}`
  writeFileSync(STAMP, JSON.stringify({ at: entry.at, key }), 'utf8')
}

function latest() {
  const arr = JSON.parse(readFileSync(MOOD_JSON, 'utf8'))
  return Array.isArray(arr) ? arr[arr.length - 1] : arr
}

function fmt(entry) {
  const m = entry.mood || {}
  const when = new Date().toLocaleString('zh-CN', { hour12: false })
  const lines = [
    MARK,
    '',
    `- 更新时间：${when}`,
    `- 心情：${m.name || '?'}（综合 ${m.composite ?? '?'}/100）· 情绪 ${m.emotion?.label ?? '?'} · 说话档 ${m.policy?.band ?? '?'}`,
  ]
  if (m.reason) lines.push(`- 来源：${m.reason}`)
  if (m.policy?.note) lines.push(`- 说话方式：${m.policy.note}`)
  lines.push('')
  return lines.join('\n')
}

// 同一个区块直接覆盖，不追加第二份
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
  writeFileSync(SHARED, text, 'utf8')
}

function updateCard(entry) {
  if (!existsSync(CARD)) return false
  try {
    const d = JSON.parse(readFileSync(CARD, 'utf8'))
    const m = entry.mood || {}
    d.mood = `${m.name ?? '平常心'}（${m.composite ?? '?'}/100，${m.emotion?.label ?? '照常'}）`
    d.updatedAt = new Date().toISOString()
    writeFileSync(CARD, JSON.stringify(d, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

runMood()
const entry = latest()
if (!entry) {
  console.log('没读到心情记录：' + MOOD_JSON)
  process.exit(1)
}

const stamp = readStamp()
const force = process.argv.includes('--force')
const key = `${entry.mood?.composite}|${entry.mood?.name}|${entry.mood?.emotion?.label}`
if (!force && stamp.key && stamp.key === key) {
  console.log('心情没变，跳过', key)
  process.exit(0)
}

if (!process.argv.includes('--no-shared')) updateShared(fmt(entry))
const cardOk = updateCard(entry)
writeStamp(entry)
console.log('同步完成', entry.mood?.name, entry.mood?.composite, cardOk ? '+人设卡' : '')
