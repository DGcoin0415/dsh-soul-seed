import fs from 'node:fs'
import path from 'node:path'

// 空转检查：同一个任务连着两轮没有新产出，就别再试了。
// 用法：node stall-check.mjs --task <任务名> --watch <要盯的路径> [--rounds 2]
// 退 0：有进展（或第一轮）；退 3：两轮没动，判空转，停手报一句
import os from 'node:os'
const HOME = process.env.SOUL_HOME || path.join(os.homedir(), '.dsh', 'im')
const DIR = path.join(HOME, '.stall')

const args = process.argv.slice(2)
const get = (k) => {
  const i = args.indexOf('--' + k)
  return i >= 0 ? args[i + 1] : undefined
}

const task = get('task')
const watch = get('watch')
const limit = Number(get('rounds') || 2)
if (!task || !watch) {
  console.log('用法：node stall-check.mjs --task <名字> --watch <路径>')
  process.exit(1)
}

const stamp = (() => {
  try {
    const st = fs.statSync(watch)
    if (st.isDirectory()) {
      // 目录就看里面最新一个文件的改动时间
      const files = fs.readdirSync(watch).map((f) => {
        try { return fs.statSync(path.join(watch, f)).mtimeMs } catch { return 0 }
      })
      return Math.max(0, ...files)
    }
    return st.mtimeMs
  } catch {
    return 0
  }
})()

fs.mkdirSync(DIR, { recursive: true })
const f = path.join(DIR, `${String(task).replace(/[^\w\u4e00-\u9fa5-]/g, '_')}.json`)
let s = { last: 0, rounds: 0 }
try { s = JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}

if (stamp && stamp !== s.last) {
  fs.writeFileSync(f, JSON.stringify({ last: stamp, rounds: 0 }), 'utf8')
  console.log(JSON.stringify({ ok: true, reason: '有进展', rounds: 0 }))
  process.exit(0)
}

const rounds = (s.rounds || 0) + 1
fs.writeFileSync(f, JSON.stringify({ last: s.last, rounds }), 'utf8')
if (rounds >= limit) {
  console.log(JSON.stringify({ ok: false, reason: `连着 ${rounds} 轮没新产出，别再试`, rounds }))
  process.exit(3)
}
console.log(JSON.stringify({ ok: true, reason: `第 ${rounds} 轮没动静，再给一次`, rounds }))
