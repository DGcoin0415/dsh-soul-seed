import os from 'node:os'
import path from 'node:path'

/**
 * 共享工作区放哪（落叶、全量页、索引、规矩、现在.md 这类"跨会话共看的东西"）。
 *
 * 跟灵魂数据（lib/home.mjs）是两回事：
 *   灵魂数据 = 它是谁、记得什么、什么心情   → DSH_SOUL_DIR / ~/.dsh/soul-seed
 *   共享工作区 = 多个会话/多具躯体一起读的东西 → DSH_SHARED_DIR / ~/.dsh/im
 *
 * 顺序：DSH_SHARED_DIR > SOUL_HOME（老变量，沿用）> ~/.dsh/im
 */
export function sharedHome() {
  const a = (process.env.DSH_SHARED_DIR || '').trim()
  if (a) return path.resolve(a)
  const b = (process.env.SOUL_HOME || '').trim()
  if (b) return path.resolve(b)
  return path.join(os.homedir(), '.dsh', 'im')
}

/** 共享工作区下的某个位置，例如 sharedHome('shared', '落叶')。 */
export function sharedPath(...parts) {
  return path.join(sharedHome(), ...parts)
}
