/**
 * 这具躯体叫什么名字：脚本里别写死某个名字，谁用谁自己的。
 *
 * 取值顺序：
 *   1. 环境变量 SOUL_SELF_NAME（最快，临时换名不改文件）
 *   2. 工作区 人设卡配置.json 里选的卡 → persona-cards/<id>.json 的 name
 *   3. persona-cards/ 目录里第一张有 name 的卡
 *   4. 兜底「助手」
 *
 * 共享工作区位置按 lib/shared.mjs：DSH_SHARED_DIR > SOUL_HOME > ~/.dsh/im
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sharedPath } from './shared.mjs'

export const CARD_DIR = path.join(os.homedir(), '.dsh', 'persona-cards')

const SKIP = new Set(['index.json', 'sessions.json', '人设卡配置.json'])

let cached = null

function nameOfCard(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'))
    const n = typeof c?.name === 'string' ? c.name.trim() : ''
    return n || ''
  } catch {
    return ''
  }
}

export function selfName() {
  if (cached) return cached
  const env = (process.env.SOUL_SELF_NAME || '').trim()
  if (env) return (cached = env)

  // 配置里选的那张
  try {
    const cfg = JSON.parse(fs.readFileSync(sharedPath('人设卡配置.json'), 'utf8'))
    const id = typeof cfg?.card === 'string' ? cfg.card.trim() : ''
    if (id) {
      const n = nameOfCard(path.join(CARD_DIR, id + '.json'))
      if (n) return (cached = n)
    }
  } catch {}

  // 目录里第一张有名字的卡
  try {
    for (const f of fs.readdirSync(CARD_DIR)) {
      if (!f.endsWith('.json') || f.includes('.bak') || SKIP.has(f)) continue
      const n = nameOfCard(path.join(CARD_DIR, f))
      if (n) return (cached = n)
    }
  } catch {}

  return (cached = '助手')
}

/** 测试用：清掉缓存（换了卡或环境变量后重新取）。 */
export function resetSelfName() {
  cached = null
}
