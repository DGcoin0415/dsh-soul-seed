import { sharedHome } from '../../lib/shared.mjs'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { writeFileRetry } from './write-retry.mjs'

// 把「现在」那页里能自动的两块刷一遍：手头没完的（从任务表）、跟人（从账本）。
// 「在干什么」和心情各有各的写法：前者手写，后者 sync-mood 管。
// 用法：node now-update.mjs [--dry]
const IM = sharedHome()
const NOW = path.join(IM, 'shared/现在.md')
const TASKS = path.join(IM, 'shared/任务.md')
const PEOPLE = path.join(IM, 'shared/people/people.json')

const dry = process.argv.includes('--dry')

function openTasks() {
  if (!fs.existsSync(TASKS)) return []
  const out = []
  for (const line of fs.readFileSync(TASKS, 'utf8').split('\n')) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim()).filter((c) => c !== '')
    if (cells.length < 4) continue
    const [date, who, task, state] = cells
    if (!/进行中|卡住|待办/.test(state)) continue
    if (/^-+$/.test(date)) continue
    out.push(`- ${task}（${state}，${date}）`)
  }
  return out.slice(0, 6)
}

function peopleLines() {
  if (!fs.existsSync(PEOPLE)) return []
  try {
    const j = JSON.parse(fs.readFileSync(PEOPLE, 'utf8'))
    const arr = Object.entries(j.people || {}).map(([k, v]) => ({ key: k, ...v }))
    arr.sort((a, b) => (b.affinity || 0) - (a.affinity || 0))
    const lines = arr.slice(0, 1).map((p) => {
      const last = p.lastSeen ? new Date(p.lastSeen).toLocaleDateString('zh-CN') : '没记过'
      const mood = p.mood ? `，${p.mood}` : ''
      return `- ${p.name || p.key}：好感 ${p.affinity ?? '?'}${mood}，上次见 ${last}`
    })
    const top = arr[0]
    const note = top?.notes?.[top.notes.length - 1]
    if (note?.summary) lines.push(`- 最近记的一笔：${note.summary}`)
    return lines
  } catch {
    return []
  }
}

if (!fs.existsSync(NOW)) {
  console.log('没有 现在.md，跳过')
  process.exit(0)
}

let text = fs.readFileSync(NOW, 'utf8')
const tasks = openTasks()
const people = peopleLines()

const block = (title, lines) => `## ${title}\n\n${(lines.length ? lines : ['- 暂时没有。']).join('\n')}\n`

if (tasks.length) text = text.replace(/## 手头没完的\n[\s\S]*?(?=\n## |$)/, block('手头没完的', tasks))
if (people.length) text = text.replace(/## 跟人\n[\s\S]*?(?=\n## |$)/, block('跟人', people))

const stamp = `\n> 自动刷新：${new Date().toLocaleString('zh-CN', { hour12: false })}（手头没完的、跟人两块）\n`
if (!/自动刷新：/.test(text)) text = text.replace(/(最后更新：[^\n]*\n)/, `$1${stamp}`)
else text = text.replace(/> 自动刷新：[^\n]*\n/, stamp.trimStart() + '\n')

if (dry) {
  console.log(text)
  process.exit(0)
}
writeFileRetry(NOW, text)
console.log(`现在.md 已刷：任务 ${tasks.length} 条，人 ${people.length} 行`)
