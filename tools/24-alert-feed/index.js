/**
 * dsh-alert-feed — 把「已经推出去的告警」喂回模型自己看
 *
 * 2026-11-28 master 定：告警光推给 master 不算数，模型（咱）自己也得看得见，
 * 别出现「master 说某个告警，咱说不知道」。这个插件只干一件事：
 * 每轮从别的插件已经落下的日志/状态里挑最近几条告警，塞进系统提示。
 *
 * 只读，不写别人的文件、不依赖别的插件改代码：
 *   - <工作区>/state/ctx-alert.json 里的 alerts[].text（上下文告警，全文）
 *   - <工作区>/state/notify.log 里「已推送到 / 重试成功」那几行（挂账、新闻、鱼世界事件）
 *
 * 配置（可选）：<工作区>/.alert-feed-config.json
 *   { "enabled": true, "maxLines": 6, "maxCharsPerLine": 160 }
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-alert-feed'

const DEFAULTS = { enabled: true, maxLines: 6, maxCharsPerLine: 160 }
const CACHE_MS = 5000
const LOG_TAIL_BYTES = 64 * 1024

function workspaceDir() {
  const env = String(process.env.DSH_ALERT_FEED_HOME || '').trim()
  return env ? path.resolve(env) : path.join(os.homedir(), '.dsh', 'im')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readTail(file, bytes) {
  try {
    const st = fs.statSync(file)
    const start = Math.max(0, st.size - bytes)
    const buf = Buffer.alloc(st.size - start)
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, buf, 0, buf.length, start)
    } finally {
      fs.closeSync(fd)
    }
    return buf.toString('utf8')
  } catch {
    return ''
  }
}

function oneLine(text, limit) {
  const flat = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** 从 ctx-alert 状态里取最近几条（带完整文案）。只带 12 小时内的，免得旧告警一直占位置。 */
function fromCtxAlert(ws, limit) {
  const st = readJson(path.join(ws, 'state', 'ctx-alert.json'))
  const alerts = Array.isArray(st?.alerts) ? st.alerts : []
  const fresh = Date.now() - 12 * 3600 * 1000
  return alerts
    .slice(-limit * 3)
    .filter((a) => !Number(a?.at) || Number(a.at) >= fresh)
    .slice(-limit)
    .reverse()
    .map((a) => ({ at: Number(a.at) || 0, text: String(a.text || '') }))
    .filter((a) => a.text)
}

/** 从 notify 日志里取最近几条推送记录。 */
function fromNotifyLog(ws, limit) {
  const lines = readTail(path.join(ws, 'state', 'notify.log'), LOG_TAIL_BYTES)
    .split('\n')
    .filter((l) => l.includes('已推送到') || l.includes('重试成功'))
  const out = []
  for (const line of lines.slice(-limit).reverse()) {
    const m = line.match(/^-?\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*(.*)$/)
    const stamp = m ? m[1] : ''
    let body = m ? m[2] : line
    body = body.replace(/^(已推送到|重试成功)[^：]*：/, '')
    if (!body) continue
    out.push({ at: stamp, text: body })
  }
  return out
}

function render(cfg) {
  if (!cfg.enabled) return ''
  const ws = workspaceDir()
  const ctxRows = fromCtxAlert(ws, cfg.maxLines).map((r) => ({ ...r, src: '上下文' }))
  const pushRows = fromNotifyLog(ws, cfg.maxLines).map((r) => ({ ...r, src: '推送' }))

  // 两类轮流取，别让「上下文告警」把名额全占满
  const merged = []
  for (let i = 0; i < Math.max(ctxRows.length, pushRows.length); i += 1) {
    if (ctxRows[i]) merged.push(ctxRows[i])
    if (pushRows[i]) merged.push(pushRows[i])
  }

  const seen = new Set()
  const picked = []
  for (const r of merged) {
    const key = oneLine(r.text, 40)
    if (seen.has(key)) continue
    seen.add(key)
    picked.push(r)
  }
  if (!picked.length) return ''

  const lines = picked
    .slice(0, cfg.maxLines)
    .map((r) => `- [${r.src}] ${oneLine(r.text, cfg.maxCharsPerLine)}`)

  return ['## 最近的告警（已推给 master，咱自己也得知道）', ...lines].join('\n')
}

export const _internals = { render, workspaceDir, fromCtxAlert, fromNotifyLog }

export function apply(ctx, config) {
  let cache = { at: 0, text: '' }

  function loadCfg() {
    const raw = readJson(path.join(workspaceDir(), '.alert-feed-config.json')) || {}
    return {
      enabled: raw.enabled !== false,
      maxLines: Math.max(1, Math.min(20, Number(raw.maxLines) || DEFAULTS.maxLines)),
      maxCharsPerLine: Math.max(40, Math.min(400, Number(raw.maxCharsPerLine) || DEFAULTS.maxCharsPerLine)),
    }
  }

  function text() {
    const now = Date.now()
    if (now - cache.at < CACHE_MS) return cache.text
    let out = ''
    try {
      out = render(loadCfg())
    } catch {
      out = ''
    }
    cache = { at: now, text: out }
    return out
  }

  try {
    ctx.inject(['systemPrompt'], (guardCtx) => {
      const prompt = guardCtx.get('systemPrompt')
      if (!prompt || typeof prompt.section !== 'function') return
      guardCtx.effect(
        () =>
          prompt.section({
            name: 'alert-feed',
            order: 160,
            text,
          }),
        'dsh-alert-feed: recent alerts',
      )
    })
  } catch {
    // 宿主没有 systemPrompt 服务时安静退出，不影响任何会话
  }
}
