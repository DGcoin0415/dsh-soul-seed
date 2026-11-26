// 本机兼容层：仓库版的数据目录默认是 ~/.dsh/soul-seed，但老工作区的根页、账本、
// 翻叶、轨道都在 ~/.dsh/im 下。这里统一决定「共享工作区」在哪：
//
//   1. 显式设了 DSH_SHARED_DIR / SOUL_HOME —— 听它的（测试、搬家、多躯体都靠这个）；
//   2. 什么都没设，且本机有 ~/.dsh/im —— 用老工作区，老数据接着用；
//   3. 都没有 —— 回落到 ~/.dsh/soul-seed。
//
// 根页（SHARED-STATE.md）、shared/ 下的枝、账本都从这一层往下找。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { soulHome } from './home.mjs'

/** 老工作区的默认位置：~/.dsh/im。 */
export const LOCAL_WORKSPACE = path.join(os.homedir(), '.dsh', 'im')

/** 显式指定的共享工作区；没设返回空串。 */
export function envSharedBase() {
  const env = (process.env.DSH_SHARED_DIR || process.env.SOUL_HOME || '').trim()
  return env ? path.resolve(env) : ''
}

/** 共享工作区根（根页所在的那一层）。 */
export function sharedBase() {
  const explicit = envSharedBase()
  if (explicit) return explicit
  try {
    if (fs.statSync(LOCAL_WORKSPACE).isDirectory()) return LOCAL_WORKSPACE
  } catch {}
  return soulHome()
}

/** 当前用的是不是老工作区（用来在返回里说清楚数据打哪来）。 */
export function usingLocalWorkspace(base = sharedBase()) {
  try {
    return path.resolve(base) === path.resolve(LOCAL_WORKSPACE)
  } catch {
    return false
  }
}

/**
 * 账本候选路径，按优先级：
 *   1. <共享工作区>/shared/people/people.json —— 老格式（v1：affinity / moodScore / encounters）
 *   2. <soul-seed>/people.json               —— 仓库自己的格式（v2：goodwill / mood / meets）
 */
export function ledgerCandidates() {
  return [
    path.join(sharedBase(), 'shared', 'people', 'people.json'),
    path.join(soulHome(), 'people.json'),
  ]
}

/** 实际用哪个账本文件：先找存在的，都没有就返回第一候选（新建时用）。 */
export function resolveLedgerFile() {
  const candidates = ledgerCandidates()
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return file
    } catch {}
  }
  return candidates[0]
}
