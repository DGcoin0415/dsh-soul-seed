/**
 * dsh-notify · 早报附录②：每天早上一次插件体检
 *
 * 查两处：
 *   1. ~/.dsh/plugins/<名>/ 有没有 index.js，能不能 import() 成功（try/catch）；
 *   2. ~/.dsh/profiles/<档>/node_modules/<名>/ 装进 profile 的有没有对应目录和 index.js。
 *
 * 判红要谨慎（根页规矩：体检别造假红灯）：
 *   - 「可选页/没装上」不算问题，只有「索引真指错」才算；
 *   - 依赖找不到（ERR_MODULE_NOT_FOUND 且是裸包名）算「依赖在别处」，不当成挂；
 *   - 别的错误才算挂，只报一句话。
 * 全部 try/catch，一个都不崩；每个插件在一个进程里只 import 一次（有缓存）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { clip } from './util.mjs'

/** file -> Promise<{ok, error}>：同一个文件一个进程只 import 一次 */
const IMPORTED = new Map()

function shortError(e) {
  const code = String(e?.code || e?.name || '').trim()
  let msg = String(e?.message || e || '未知错误')
    .split(/\r?\n/)[0]
    .replace(/[A-Za-z]:\\[^\s:：]+/g, '<路径>') // 报错里别带整条路径
    .replace(/file:\/\/\/[^\s:：]+/g, '<路径>')
    .replace(/\s+/g, ' ')
    .trim()
  if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (?:package|module)/i.test(msg)) {
    // 依赖在 profile 的 node_modules 里，从 plugins 目录 import 自然找不到 —— 不算挂
    return { error: clip(msg, 60), depOnly: true }
  }
  return { error: clip(`${code ? code + '：' : ''}${msg}`, 70), depOnly: false }
}

function importOnce(file, timeoutMs = 8000) {
  const hit = IMPORTED.get(file)
  if (hit) return hit
  const p = Promise.race([
    import(pathToFileURL(file).href).then(
      () => ({ ok: true, error: '', depOnly: false }),
      (e) => ({ ok: false, ...shortError(e) }),
    ),
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, error: `import 超过 ${Math.round(timeoutMs / 1000)} 秒`, depOnly: false }), timeoutMs).unref?.(),
    ),
  ]).catch((e) => ({ ok: false, ...shortError(e) }))
  IMPORTED.set(file, p)
  return p
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
  } catch {
    return []
  }
}

/**
 * 找包的入口文件：先看 package.json 的 main，再退回 index.js / lib/index.js / dist/index.js。
 * profile 里那些 npm 包的 main 是 lib/index.js，只认 index.js 会造假红灯。
 */
export function entryOf(dir) {
  let main = ''
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    main = String(pj?.main || pj?.module || '').trim()
  } catch {
    main = ''
  }
  const cands = []
  if (main) cands.push(path.join(dir, main))
  cands.push(
    path.join(dir, 'index.js'),
    path.join(dir, 'index.mjs'),
    path.join(dir, 'lib', 'index.js'),
    path.join(dir, 'lib', 'index.mjs'),
    path.join(dir, 'dist', 'index.js'),
  )
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c
    } catch {}
  }
  return ''
}

/**
 * 体检一次。
 * @returns {Promise<{total:number, alive:string[], broken:Array<{name:string,error:string}>, warnings:string[], profiles:Array, checkedAt:number}>}
 */
export async function checkPlugins({ pluginsDir, profilesDir, timeoutMs = 8000 } = {}) {
  const home = os.homedir()
  const pDir = pluginsDir || path.join(home, '.dsh', 'plugins')
  const profDir = profilesDir || path.join(home, '.dsh', 'profiles')
  const res = { total: 0, alive: [], broken: [], warnings: [], profiles: [], checkedAt: Date.now() }

  const names = listDirs(pDir)
  res.total = names.length
  for (const name of names) {
    const dir = path.join(pDir, name)
    try {
      const entry = entryOf(dir)
      if (!entry) {
        res.broken.push({ name, error: '没有入口文件（index.js）' })
        continue
      }
      const r = await importOnce(entry, timeoutMs)
      if (r.ok) res.alive.push(name)
      else if (r.depOnly) res.warnings.push(`${name}：${r.error}`)
      else res.broken.push({ name, error: r.error })
    } catch (e) {
      res.broken.push({ name, error: clip(String(e?.message || e), 70) })
    }
  }

  // 装进 profile 的有没有对应目录
  for (const profile of listDirs(profDir)) {
    const nm = path.join(profDir, profile, 'node_modules')
    if (!fs.existsSync(nm)) continue
    const installed = listDirs(nm).filter((n) => n.startsWith('dsh-'))
    if (!installed.length) continue
    const broken = []
    for (const n of installed) {
      try {
        if (!entryOf(path.join(nm, n))) broken.push(n)
      } catch {
        broken.push(n)
      }
    }
    res.profiles.push({ profile, total: installed.length, broken })
  }
  return res
}

/** 排成一行（早报里就一行，挂了才多几个字）。 */
export function renderHealthLine(res) {
  try {
    if (!res) return '• 插件体检没跑成（没结果）'
    const parts = []
    if (!res.broken?.length) parts.push(`插件 ${res.total} 个都在`)
    else parts.push(`插件挂了：${res.broken.map((b) => `${b.name}（${b.error}）`).join('；')}`)
    for (const p of res.profiles || []) {
      if (p.broken?.length) parts.push(`profile ${p.profile} 缺 ${p.broken.join('、')}`)
      else parts.push(`profile ${p.profile} ${p.total} 个都在`)
    }
    if (res.warnings?.length) parts.push(`依赖在 profile 里：${res.warnings.join('；')}`)
    return `• ${parts.join('｜')}`
  } catch {
    return '• 插件体检结果排不出来'
  }
}

/** 一步到位：体检 + 一行（失败返回一行说明）。 */
export async function healthLine(opts) {
  try {
    return renderHealthLine(await checkPlugins(opts))
  } catch (e) {
    return `• 插件体检失败：${clip(String(e?.message || e), 60)}`
  }
}
