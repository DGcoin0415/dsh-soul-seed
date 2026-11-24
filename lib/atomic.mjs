import fs from 'node:fs'
import crypto from 'node:crypto'

/**
 * 原子写：先写临时文件、fsync、再 rename。
 * 从 heybox 插件借来的做法（2026-11-24）：状态文件写到一半断电/被占用，
 * 直接 writeFileSync 会留半截 JSON，下次读就炸；rename 是原子的，不会。
 */
export function atomicWrite(file, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    const fd = fs.openSync(temp, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, text)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temp, file)
  } finally {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp)
    } catch {}
  }
}
