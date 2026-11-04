import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 找 node 可执行文件。宿主是 Electron 时 process.execPath 是主程序而不是 node，
 * 直接拿它 spawn 会再开一个 DSH，不是跑脚本 —— 所以按这个顺序找：
 *
 *   1. DSH_NODE 环境变量
 *   2. 扫 ~/.dsh/dsh-runtimes 下 dependencies 里带的 node（bin 目录里的 node 或 node.exe）
 *   3. 自己 + ELECTRON_RUN_AS_NODE=1（宿主就是 electron 时，它会当 node 跑）
 *   4. PATH 里的 node
 */
export function resolveNode() {
  const env = (process.env.DSH_NODE || '').trim()
  if (env && fs.existsSync(env)) return { exe: env, env: process.env }

  const roots = [
    path.join(os.homedir(), '.dsh', 'dsh-runtimes'),
    path.join(path.dirname(process.execPath), 'resources', 'app.asar.unpacked', 'dsh', 'dsh-runtimes'),
  ]
  for (const root of roots) {
    const hit = scan(root, 0)
    if (hit) return { exe: hit, env: process.env }
  }

  // 宿主是 Electron 时，自己的可执行文件带上这个变量才会当 node 跑
  if (process.versions && process.versions.electron) {
    return { exe: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { exe: process.execPath, env: process.env }
}

function scan(dir, depth) {
  if (depth > 5 || !fs.existsSync(dir)) return null
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name === 'bin') {
      for (const name of ['node.exe', 'node']) {
        const p = path.join(dir, 'bin', name)
        if (fs.existsSync(p)) return p
      }
    }
    const hit = scan(path.join(dir, e.name), depth + 1)
    if (hit) return hit
  }
  return null
}
