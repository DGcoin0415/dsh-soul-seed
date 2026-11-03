// 本回合翻过的叶：记下这一轮读了哪些枝、召回了哪些旧叶。
// 目的不是审计，是让「这轮用了什么记忆」看得见——像翻过的叶子能指出来。
import fs from 'node:fs'
import path from 'node:path'

const MAX_LINES = 200

export function turnLogFile(soulDir) {
  return path.join(soulDir, 'shared', '翻叶.md')
}

/** 追加一条；超过上限就只留最近的。 */
export function recordTurn(soulDir, kind, detail) {
  const file = turnLogFile(soulDir)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const line = `- ${ts}｜${kind}｜${String(detail).replace(/\s+/g, ' ').slice(0, 160)}`
    fs.appendFileSync(file, line + '\n', 'utf8')
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    if (lines.length > MAX_LINES + 20) {
      const head = '# 翻叶（最近用过的记忆，新的在后）\n\n'
      fs.writeFileSync(file, head + lines.slice(-MAX_LINES).join('\n').replace(/^\n+/, ''), 'utf8')
    }
  } catch {}
  return file
}

/** 读最近 n 条。 */
export function recentTurns(soulDir, n = 10) {
  try {
    const text = fs.readFileSync(turnLogFile(soulDir), 'utf8')
    return text.split('\n').filter((l) => l.startsWith('- ')).slice(-n)
  } catch {
    return []
  }
}
