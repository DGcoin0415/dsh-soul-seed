import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/**
 * 灵魂数据放哪。
 *
 * 顺序：
 *   1. 环境变量 DSH_SOUL_DIR（最高优先，谁设谁说话）
 *   2. ~/.dsh/soul-seed —— 新的默认位置
 *   3. ~/.bili-ai      —— 老位置，存在就继续用，不搬、不改、不丢
 *   4. 都不存在 → 用新位置
 *
 * 老用户什么都不用做：老目录在，就还在用老目录。
 * 新用户从新目录开始，跟具体渠道（B 站/QQ/微信）无关。
 */
export function soulHome() {
  const env = (process.env.DSH_SOUL_DIR || '').trim()
  if (env) return path.resolve(env)

  const fresh = path.join(os.homedir(), '.dsh', 'soul-seed')
  const legacy = path.join(os.homedir(), '.bili-ai')
  if (fs.existsSync(fresh)) return fresh
  if (fs.existsSync(legacy)) return legacy
  return fresh
}

/** 老位置（只用来做兼容与提示，不写入）。 */
export function legacyHome() {
  return path.join(os.homedir(), '.bili-ai')
}

/** 现在是不是还在用老位置。 */
export function usingLegacy() {
  return soulHome() === legacyHome()
}
