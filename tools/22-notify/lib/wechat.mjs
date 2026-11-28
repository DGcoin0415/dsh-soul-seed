/**
 * dsh-notify · 微信私聊发文字（兜底通道）
 *
 * 复用工作区的 wxlib.mjs（@zxz9988/dsh-wechat-bridge 那套协议），
 * 凭据从 ~/.dsh/.credentials.yaml 读，context token 从
 * ~/.dsh/integrations/dsh-weixin/accounts/[账号]/state.json 读。
 * 任何情况下都不把 token 写进日志或返回值。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readJson, redact, clip } from './util.mjs'

const HOME = os.homedir()
const CREDS = path.join(HOME, '.dsh', '.credentials.yaml')
const ACCOUNTS = path.join(HOME, '.dsh', 'integrations', 'dsh-weixin', 'accounts')
const BASE_URL = 'https://ilinkai.weixin.qq.com'

function readTokenFor(suffix) {
  let text = ''
  try {
    text = fs.readFileSync(CREDS, 'utf8')
  } catch {
    return ''
  }
  const key = `DSH_WEIXIN_BOT_TOKEN_${String(suffix || '').toUpperCase()}`
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm')
  const m = re.exec(text)
  if (m) return m[1].replace(/^["']|["']$/g, '').trim()
  // 兜底：任意一个微信 bot token
  const any = /^\s*DSH_WEIXIN_BOT_TOKEN_[A-Z0-9]+\s*:\s*(.+?)\s*$/m.exec(text)
  return any ? any[1].replace(/^["']|["']$/g, '').trim() : ''
}

/** 找账号：带 context token 的，且（可选）那里面有目标用户。 */
function findAccount(preferredTo = '') {
  let dirs = []
  try {
    dirs = fs.readdirSync(ACCOUNTS).filter((d) => d.startsWith('wx_'))
  } catch {
    return null
  }
  const found = []
  for (const dir of dirs) {
    const state = readJson(path.join(ACCOUNTS, dir, 'state.json'), {})
    const users = state?.contextTokens?.users && typeof state.contextTokens.users === 'object'
      ? state.contextTokens.users
      : {}
    const ids = Object.keys(users)
    if (!ids.length) continue
    let picked = preferredTo && users[preferredTo] ? preferredTo : ''
    if (!picked) {
      picked = ids
        .map((id) => ({ id, at: Number(users[id]?.messageTimeMs) || 0 }))
        .sort((a, b) => b.at - a.at)[0].id
    }
    const ctx = users[picked]?.token
    if (!ctx) continue
    found.push({ dir, suffix: dir.replace(/^wx_/, ''), to: picked, ctx })
  }
  if (!found.length) return null
  if (preferredTo) {
    const exact = found.find((a) => a.to === preferredTo)
    if (exact) return exact
  }
  return found[0]
}

let clientPromise = null

async function getClient(workspace) {
  if (clientPromise) return clientPromise
  clientPromise = (async () => {
    const file = path.join(workspace, 'wxlib.mjs')
    const mod = await import(pathToFileURL(file).href)
    if (typeof mod.WeChatClient !== 'function') {
      throw new Error(`wxlib.mjs 里没有 WeChatClient（${file}）`)
    }
    return { WeChatClient: mod.WeChatClient }
  })()
  return clientPromise
}

/**
 * 发一段文字到 master 微信私聊。
 * @returns {Promise<{ok:true, id:string, to:string}>}
 */
export async function sendWechatText({ workspace, text, toUserId = '' }) {
  const body = clip(String(text || ''), 3000)
  if (!body) throw new Error('没内容可发')
  const account = findAccount(toUserId)
  if (!account) throw new Error('找不到可用的微信账号（integrations/dsh-weixin/accounts 里没有 context token）')
  const token = readTokenFor(account.suffix)
  if (!token) throw new Error('找不到微信 bot token（.credentials.yaml）')
  const { WeChatClient } = await getClient(workspace)
  const client = new WeChatClient({ baseUrl: BASE_URL })
  client.api.setToken(token)
  const id = await client.sendText(account.to, body, account.ctx)
  return { ok: true, id: String(id || ''), to: account.to }
}

/** 自检用：只报能不能找到账号，不报凭据。 */
export function wechatProbe() {
  try {
    const account = findAccount('')
    if (!account) return { ok: false, reason: '没有 context token' }
    return { ok: Boolean(readTokenFor(account.suffix)), account: account.suffix, to: account.to }
  } catch (e) {
    return { ok: false, reason: redact(e?.message || e) }
  }
}
