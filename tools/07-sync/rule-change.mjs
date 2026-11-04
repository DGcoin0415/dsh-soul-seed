import { sharedPath } from '../../lib/shared.mjs'
import fs from 'node:fs'
import path from 'node:path'

// 规矩改动：只替换提到的那一段，旧段落存档，其余不动。
// 用法：
//   node rule-change.mjs <文件> <主题> "<新内容>" [--why "为什么改"]
// 例：
//   node rule-change.mjs 情绪与说话.md "冷场" "冷场超过两分钟就自己找句话。" --why "master 说太冷了"
const RULES = sharedPath('shared', '规矩')
const HIST = sharedPath('shared', '历史', '规矩变更.md')

const args = process.argv.slice(2)
const whyIdx = args.indexOf('--why')
let why = ''
if (whyIdx >= 0) {
  why = args[whyIdx + 1] || ''
  args.splice(whyIdx, 2)
}
const [file, topic, content] = args
if (!file || !topic || !content) {
  console.log('用法: node rule-change.mjs <文件> <主题> "<新内容>" [--why "原因"]')
  process.exit(1)
}

const target = path.join(RULES, file)
if (!fs.existsSync(target)) {
  console.log('文件不存在:', target)
  process.exit(1)
}

const text = fs.readFileSync(target, 'utf8')
const now = new Date()
const p = (n) => String(n).padStart(2, '0')
const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`

// 定位 "## 主题" 到下一个 ## 之间
const lines = text.split('\n')
let start = -1
let end = lines.length
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === `## ${topic}`) {
    start = i
    for (let j = i + 1; j < lines.length; j++) {
      if (/^##\s/.test(lines[j])) {
        end = j
        break
      }
    }
    break
  }
}

let oldBlock = ''
let newText
if (start >= 0) {
  oldBlock = lines.slice(start, end).join('\n').trimEnd()
  const head = lines.slice(0, start).join('\n')
  const tail = lines.slice(end).join('\n')
  newText = [head, `## ${topic}`, '', content.trim(), '', tail].filter((x) => x !== '').join('\n') + '\n'
  // 上面拼接会丢空行，做一次规整
  newText = (head ? head.replace(/\s+$/, '') + '\n\n' : '') + `## ${topic}\n\n${content.trim()}\n\n` + (tail ? tail.replace(/^\s+/, '') : '')
  if (!newText.endsWith('\n')) newText += '\n'
  fs.writeFileSync(target, newText, 'utf8')
  console.log(`改了：${file} · ${topic}`)
} else {
  fs.appendFileSync(target, `\n## ${topic}\n\n${content.trim()}\n`, 'utf8')
  console.log(`新增：${file} · ${topic}`)
}

// 旧段存档
const entry = [
  '',
  `## ${stamp} · ${file} · ${topic}`,
  '',
  why ? `> 为什么改：${why}` : '> 为什么改：（没写）',
  '',
  start >= 0 ? '```\n' + oldBlock + '\n```' : '> 之前没有这一段，是新增',
  '',
].join('\n')

fs.mkdirSync(path.dirname(HIST), { recursive: true })
fs.appendFileSync(HIST, entry, 'utf8')
console.log('旧段落已存进 历史/规矩变更.md')
