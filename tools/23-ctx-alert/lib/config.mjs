/**
 * dsh-ctx-alert · 配置
 *
 * 配置优先级：环境变量 DSH_CTX_ALERT_HOME（工作区）→ 默认 ~/.dsh/im
 * 文件：<工作区>/.ctx-alert-config.json（改完不用重启，插件每轮重读，有 5 秒缓存）
 *
 * 关键项：
 *   maxRounds      压缩轮上限，默认 1（历史数据：80% 撞墙会话死在第 0 轮，压不动，回合数涨不上去）
 *   windowTokens   窗口 token，默认 1048576（会话里有 request/context 时以会话里的为准）
 *   dropPoints     占用一次回落多少点算「压缩了一轮」，默认 15
 *   lastRoundPct   最后一轮（round >= maxRounds）告警阈值，默认 60
 *   penultRoundPct 倒数第二轮（round == maxRounds-1）告警阈值，默认 70（回放：70 比 68 少 3 条误报，覆盖不降）
 *   absolutePct    绝对线（不看轮次），默认 72；真死线 75.58% = 窗口 - maxTokens 预留
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()

export function workspaceDir() {
  const env = String(process.env.DSH_CTX_ALERT_HOME || '').trim()
  if (env) return path.resolve(env)
  return path.join(HOME, '.dsh', 'im')
}

export function paths(workspace = workspaceDir()) {
  return {
    workspace,
    config: path.join(workspace, '.ctx-alert-config.json'),
    state: path.join(workspace, 'state', 'ctx-alert.json'),
    log: path.join(workspace, 'state', 'ctx-alert.log'),
    history: path.join(workspace, 'shared', '历史'),
    handoff: path.join(workspace, 'shared', '交接.md'),
    inbox: path.join(workspace, '.notify-outbox'),
    sessionsRoot: path.join(HOME, '.dsh', 'sessions'),
  }
}

export const DEFAULTS = {
  enabled: true,
  /** 压缩轮上限：1 —— 压过一次就到「换新会话」那一档 */
  maxRounds: 1,
  /** 窗口 token（会话里有 request/context.contextWindow 时优先用会话的） */
  windowTokens: 1048576,
  /** 一次回落多少个百分点算压缩一轮 */
  dropPoints: 15,
  /** 最后一轮（round >= maxRounds）到多少才告警 */
  lastRoundPct: 60,
  /** 倒数第二轮（round == maxRounds-1）到多少才告警 */
  penultRoundPct: 70,
  /** 绝对线：不看轮次，占用到这条线就告警（0 = 关） */
  absolutePct: 72,
  /** 每分钟兜底检查一次（除了每轮事件之外） */
  checkEveryMin: 1,
  /** 只看最近多少小时内动过的会话 */
  activeHours: 2,
  /** 告警后同一轮同一阈值不再重复（保留字段，语义由 alerts 去重保证） */
  quietMin: 0,
  /** 每次告警附带写一条到 shared/历史/<当月>.md */
  writeHistory: true,
  /** 占用第一次到 70%（第 0 轮那条线）时，顺手往 shared/交接.md 的「刚完成」段补一行（不调模型） */
  writeHandoff: true,
  /** 状态文件里每个会话保留多少条占用记录 */
  keepSamples: 30,
  /** 状态文件里最多留几个会话 */
  keepSessions: 40,
  /** 告警统一投到哪条会话（2026-11-28 master 定：都通到他说话的那条）；空 = 投回发起会话 */
  pushSession: '',
}

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const cfg = { ...DEFAULTS, ...src }
  cfg.enabled = cfg.enabled !== false
  cfg.maxRounds = Math.max(1, Math.round(num(cfg.maxRounds, DEFAULTS.maxRounds)))
  cfg.windowTokens = Math.max(1000, Math.round(num(cfg.windowTokens, DEFAULTS.windowTokens)))
  cfg.dropPoints = Math.max(1, num(cfg.dropPoints, DEFAULTS.dropPoints))
  cfg.lastRoundPct = Math.min(100, Math.max(1, num(cfg.lastRoundPct, DEFAULTS.lastRoundPct)))
  cfg.penultRoundPct = Math.min(100, Math.max(1, num(cfg.penultRoundPct, DEFAULTS.penultRoundPct)))
  cfg.absolutePct = num(cfg.absolutePct, DEFAULTS.absolutePct)
  if (cfg.absolutePct > 0) cfg.absolutePct = Math.min(100, Math.max(1, cfg.absolutePct))
  else cfg.absolutePct = 0
  cfg.checkEveryMin = Math.max(1, num(cfg.checkEveryMin, DEFAULTS.checkEveryMin))
  cfg.activeHours = Math.max(1, num(cfg.activeHours, DEFAULTS.activeHours))
  cfg.keepSamples = Math.max(5, Math.round(num(cfg.keepSamples, DEFAULTS.keepSamples)))
  cfg.keepSessions = Math.max(5, Math.round(num(cfg.keepSessions, DEFAULTS.keepSessions)))
  cfg.writeHistory = cfg.writeHistory !== false
  cfg.writeHandoff = cfg.writeHandoff !== false
  return cfg
}

export function loadConfig(workspace) {
  const p = paths(workspace)
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(p.config, 'utf8'))
  } catch {
    raw = {}
  }
  return normalize(raw)
}

export function saveConfig(patch, workspace) {
  const p = paths(workspace)
  let current = {}
  try {
    current = JSON.parse(fs.readFileSync(p.config, 'utf8'))
  } catch {
    current = {}
  }
  const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) }
  fs.mkdirSync(path.dirname(p.config), { recursive: true })
  fs.writeFileSync(p.config, JSON.stringify(next, null, 2), 'utf8')
  return normalize(next)
}
