import os from 'node:os'
import path from 'node:path'

/**
 * 灵魂数据放哪。
 *
 * 只有一条规则：环境变量 DSH_SOUL_DIR 优先，否则 ~/.dsh/soul-seed。
 *
 * 想让数据留在别处（比如另一块盘，或者沿用某个已有目录），设 DSH_SOUL_DIR 指过去就行，
 * 也可以在系统上把 ~/.dsh/soul-seed 做成指向那个目录的联接 —— 插件不关心它背后是谁。
 */
export function soulHome() {
  const env = (process.env.DSH_SOUL_DIR || '').trim()
  if (env) return path.resolve(env)
  return path.join(os.homedir(), '.dsh', 'soul-seed')
}
