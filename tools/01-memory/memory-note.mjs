import fs from 'node:fs'
import path from 'node:path'

// 日档：一条记忆写三行（触点 / 变 / 回），不写小作文。
// 用法：node memory-note.mjs "触点：谁说了什么" "变：以后遇到X我会Y" "回：说了什么"
const DIR = 'C:/Users/Administrator/.dsh/im/shared/记忆本/日'
fs.mkdirSync(DIR, { recursive: true })

const args = process.argv.slice(2).filter(Boolean)
if (args.length === 0) {
  console.log('用法: node memory-note.mjs "触点：…" "变：…" "回：…"')
  process.exit(1)
}
const now = new Date()
const p = (n) => String(n).padStart(2, '0')
const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
const clock = `${p(now.getHours())}:${p(now.getMinutes())}`
const file = path.join(DIR, day + '.md')

if (!fs.existsSync(file)) {
  fs.writeFileSync(file, `# 日档 · ${day}\n\n`, 'utf8')
}

const body = args.map((a) => `- ${a}`).join('\n')
fs.appendFileSync(file, `\n## ${clock}\n\n${body}\n`, 'utf8')
console.log(`写进 ${day}.md：${args.length} 行`)
