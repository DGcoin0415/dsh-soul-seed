import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * 读会话日志（session.v4.jsonl.zstd）。
 *
 * DSH 是追加式写：一个文件里塞了很多个 zstd 帧，直接解只出第一帧。
 * 这里按 magic 28 B5 2F FD 切帧，逐帧解，半截帧（正在写）跳过。
 *
 * @param {string} file
 * @returns {object[]} 记录数组（原始 JSON 对象）
 */
export function readRecords(file) {
  const raw = fs.readFileSync(file)
  const offs = []
  for (let i = 0; i + 4 <= raw.length; i++) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) offs.push(i)
  }
  const out = []
  for (let k = 0; k < offs.length; k++) {
    const s = offs[k]
    const e = k + 1 < offs.length ? offs[k + 1] : raw.length
    let text = ''
    try { text = zlib.zstdDecompressSync(raw.subarray(s, e)).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.trim().startsWith('{')) continue
      try { out.push(JSON.parse(line)) } catch {}
    }
  }
  return out
}

/** 找一个工作区下最新的会话文件。 */
export function newestSessionFile(sessionsRoot, workspaceDirName) {
  const base = workspaceDirName ? path.join(sessionsRoot, workspaceDirName) : sessionsRoot
  if (!fs.existsSync(base)) return null
  let best = null
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name === 'session.v4.jsonl.zstd') {
        const st = fs.statSync(full)
        if (!best || st.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: st.mtimeMs, size: st.size }
      }
    }
  }
  try { walk(base) } catch { return null }
  return best
}
