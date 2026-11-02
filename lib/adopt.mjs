// 非首次部署：这台机器上已经有一只鱼（人设 / 记忆 / 账本 / 灵魂目录），
// 那就别再让人答十问，直接「学本地的」——只读、只汇报，不覆盖任何东西。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()

function sizeOf(file) {
  try { return fs.statSync(file).size } catch { return 0 }
}

function countPeople(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Object.keys(j.people || {}).length
  } catch { return 0 }
}

function latestHistory(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.md$/.test(f)).sort()
    if (!files.length) return null
    const last = path.join(dir, files[files.length - 1])
    const text = fs.readFileSync(last, 'utf8')
    const lines = text.split('\n').filter((l) => l.trim().startsWith('- '))
    return { file: last, count: lines.length, tail: lines.slice(-1)[0]?.slice(2, 80) || '' }
  } catch { return null }
}

/** 本机已经部署过的迹象。只看不动。 */
export function detectExisting() {
  const sources = []
  const persona = path.join(HOME, '.bili-ai', 'persona.md')
  const memory = path.join(HOME, '.bili-ai', 'memory.json')
  const people = path.join(HOME, '.bili-ai', 'people.json')
  const soulRoot = path.join(HOME, '.dsh', 'im', 'SHARED-STATE.md')
  const soulHistory = path.join(HOME, '.dsh', 'im', 'shared', '历史')

  if (sizeOf(persona) > 0) sources.push({ kind: '人设', path: persona, bytes: sizeOf(persona) })
  if (sizeOf(memory) > 0) sources.push({ kind: '记忆', path: memory, bytes: sizeOf(memory) })
  if (sizeOf(people) > 0) sources.push({ kind: '账本', path: people, bytes: sizeOf(people), people: countPeople(people) })
  if (sizeOf(soulRoot) > 0) sources.push({ kind: '灵魂目录', path: soulRoot, bytes: sizeOf(soulRoot), history: latestHistory(soulHistory) })

  return { deployed: sources.length > 0, sources }
}

/**
 * 学本地的：把本机已有的东西汇总成一段话，写成一个笔记。
 * 不写人设、不碰记忆文件。
 */
export function learnLocal({ dataDir }) {
  const info = detectExisting()
  if (!info.deployed) return { ok: false, error: 'NOT_DEPLOYED' }
  const parts = info.sources.map((s) => {
    if (s.kind === '人设') return `人设 ${s.bytes} 字节`
    if (s.kind === '记忆') return `记忆 ${s.bytes} 字节`
    if (s.kind === '账本') return `账本 ${s.people} 人`
    if (s.kind === '灵魂目录' && s.history) return `历史 ${s.history.count} 条（最近：${s.history.tail}）`
    return s.kind
  })
  const note = [
    '# 我不用重新认识自己',
    '',
    `_${new Date().toISOString()}_`,
    '',
    '这台机器上已经有一只鱼了，检测到：' + parts.join(' · ') + '。',
    '',
    '所以这次不走初始化十问，直接接着用本地的。要重新答一遍，去面板点「重新初始化」。',
    '',
    '---',
    '',
    `检测到的位置：${info.sources.map((s) => s.path).join('、')}`,
  ].join('\n')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, '我学会了.md'), note, 'utf8')
  fs.writeFileSync(path.join(dataDir, '.deployed-existing'), new Date().toISOString(), 'utf8')
  return { ok: true, summary: parts.join(' · '), note: path.join(dataDir, '我学会了.md') }
}

/** 是不是「非首次部署」模式（可用 SOUL_SEED_MODE=learn 强制）。 */
export function deployMode() {
  const forced = (process.env.SOUL_SEED_MODE || '').trim().toLowerCase()
  if (forced === 'learn' || forced === 'fresh') return forced
  return detectExisting().deployed ? 'learn' : 'fresh'
}
