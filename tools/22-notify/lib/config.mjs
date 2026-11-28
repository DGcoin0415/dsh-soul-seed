/**
 * dsh-notify · 配置
 *
 * 配置优先级：环境变量 DSH_NOTIFY_HOME（工作区）→ 默认 ~/.dsh/im
 * 文件：<工作区>/.notify-config.json
 * 兼容老开关：<工作区>/.yuyu-notify.json 里的 {"enabled":false} 也算关掉。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readJson } from './util.mjs'

const HOME = os.homedir()

export function workspaceDir() {
  const env = String(process.env.DSH_NOTIFY_HOME || '').trim()
  if (env) return path.resolve(env)
  return path.join(HOME, '.dsh', 'im')
}

export function paths(workspace = workspaceDir()) {
  return {
    workspace,
    config: path.join(workspace, '.notify-config.json'),
    legacyToggle: path.join(workspace, '.yuyu-notify.json'),
    state: path.join(workspace, 'state', 'notify.json'),
    log: path.join(workspace, 'state', 'notify.log'),
    outbox: path.join(workspace, '.notify-outbox'),
    yuyuEnvFiles: [path.join(workspace, 'fw.env'), 'D:\\AI\\im_out\\fw.env'],
  }
}

export const DEFAULTS = {
  enabled: true,
  intervalMin: 10,
  sources: { yuyu: true, inbox: true, news: true },
  /** 有发起会话时优先投回那条会话 */
  preferSession: true,
  /** 没有发起会话时（鱼世界这种环境事件）投到哪：wechat | session */
  fallbackChannel: 'wechat',
  /** fallbackChannel=session 时投给哪个会话 id */
  fallbackSession: '',
  /** 每日新闻：几点推、推到哪、几条 */
  newsAt: '08:30',
  newsChannel: 'session',
  newsMaxGeneral: 5,
  newsMaxAi: 5,
  newsMaxChars: 600,
  /** 早报附录①：今天接着干的（任务.md / 接续.md 里没完的，最多几条） */
  digestBacklog: true,
  digestBacklogMax: 5,
  /** 早报附录②：每天早上体检一次插件（index.js 在不在、能不能 import） */
  digestHealth: true,
  /** 挂账检查：工单/任务 24 小时没动就推一条（每天一次，可关） */
  staleCheck: true,
  staleAt: '09:00',
  staleHours: 24,
  staleMaxTasks: 5,
  /** 单条推送最多多少字 */
  maxChars: 1200,
  /** 每轮最多推几条，剩下留到下轮 */
  maxPerTick: 8,
  /** 失败重试次数 */
  maxRetry: 5,
  /** 微信目标（留空自动找最近给咱发消息的那个） */
  wechatToUserId: '',
}

export function loadConfig(workspace) {
  const p = paths(workspace)
  const raw = readJson(p.config, {})
  const legacy = readJson(p.legacyToggle, {})
  const src = raw.sources && typeof raw.sources === 'object' ? raw.sources : {}
  const cfg = {
    ...DEFAULTS,
    ...raw,
    sources: { ...DEFAULTS.sources, ...src },
  }
  cfg.intervalMin = Number(cfg.intervalMin) > 0 ? Number(cfg.intervalMin) : DEFAULTS.intervalMin
  cfg.maxPerTick = Number(cfg.maxPerTick) > 0 ? Number(cfg.maxPerTick) : DEFAULTS.maxPerTick
  cfg.maxRetry = Number(cfg.maxRetry) > 0 ? Number(cfg.maxRetry) : DEFAULTS.maxRetry
  cfg.maxChars = Number(cfg.maxChars) > 0 ? Number(cfg.maxChars) : DEFAULTS.maxChars
  // 四项新功能：默认开，配置里显式 false 才算关
  cfg.digestBacklog = cfg.digestBacklog !== false
  cfg.digestHealth = cfg.digestHealth !== false
  cfg.staleCheck = cfg.staleCheck !== false
  cfg.digestBacklogMax =
    Number(cfg.digestBacklogMax) > 0 ? Math.round(Number(cfg.digestBacklogMax)) : DEFAULTS.digestBacklogMax
  cfg.staleHours = Number(cfg.staleHours) > 0 ? Number(cfg.staleHours) : DEFAULTS.staleHours
  cfg.staleMaxTasks = Number(cfg.staleMaxTasks) > 0 ? Math.round(Number(cfg.staleMaxTasks)) : DEFAULTS.staleMaxTasks
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(cfg.staleAt || '').trim())) cfg.staleAt = DEFAULTS.staleAt
  if (typeof legacy.enabled === 'boolean' && legacy.enabled === false) cfg.enabled = false
  return cfg
}

export function saveConfig(patch, workspace) {
  const p = paths(workspace)
  const current = fs.existsSync(p.config) ? readJson(p.config, {}) : {}
  const next = { ...current, ...patch }
  fs.mkdirSync(path.dirname(p.config), { recursive: true })
  fs.writeFileSync(p.config, JSON.stringify(next, null, 2), 'utf8')
  return next
}
