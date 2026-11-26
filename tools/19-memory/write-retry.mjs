import fs from 'node:fs'

// 写文件重试：Windows 上杀软或别的进程正握着文件时，会抛 ReplaceFileW EIO (1175)。
// 等一下再写一般就过去了，不用每次手动重试。
// 用法：import { writeFileRetry } from './write-retry.mjs'
export function writeFileRetry(file, data, { tries = 3, waitMs = 80 } = {}) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      fs.writeFileSync(file, data, 'utf8')
      return true
    } catch (e) {
      lastErr = e
      const retryable = /EIO|EPERM|EBUSY|EACCES/.test(String(e?.code || e?.message || ''))
      if (!retryable || i === tries - 1) break
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs * (i + 1))
      } catch {}
    }
  }
  throw lastErr
}
