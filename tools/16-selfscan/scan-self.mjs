// 上线先扫一遍自己有什么 —— 出图链路、模型目录、环境。
// 用法：node scan-self.mjs [--deep]
//   --deep 多花十几秒，真去 python 里 import torch 看版本
//
// 2026-11-20 建（master 定：新躯体上来先扫描自己有什么，别一问三不知）。
// 顺手干三件事：
//   1) 把「云端百炼 / 本地千问 / SD1.5 / ComfyUI」实况写进根页 AUTO 区块；
//   2) 扫到没见过的新脚本，往 shared/工具变更.md 记一行（用途从文件头注释猜）；
//   3) 扫到新装的插件，用插件自己的 description 记一行。

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { selfName } from '../../lib/selfname.mjs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const hostRoot = () => dirname(fileURLToPath(import.meta.url))

const deep = process.argv.includes('--deep')
const COMFY = 'D:\\AI\\ComfyUI'
const PY = 'D:\\AI\\python311\\python.exe'
const BASE = 'http://127.0.0.1:8188'
const OUT = 'D:\\AI\\im_out'

const line = (s = '') => console.log(s)
const ok = (s) => console.log('  ✓ ' + s)
const bad = (s) => console.log('  ✗ ' + s)

function countFiles(dir, exts = ['.safetensors', '.ckpt', '.pt', '.pth', '.sft']) {
  if (!existsSync(dir)) return { exists: false, files: [] }
  const files = readdirSync(dir).filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)))
  return { exists: true, files }
}

function humanSize(bytes) {
  const gb = bytes / 1024 / 1024 / 1024
  return gb >= 1 ? gb.toFixed(2) + 'G' : Math.round(bytes / 1024 / 1024) + 'M'
}

// 猜一个脚本是干什么的：只看文件头的注释/文档字符串，取第一句人话
function guessPurpose(file) {
  const clean = (s) => s.replace(/^(#|\/\/|\*|"""|''')\s*/, '').replace(/^[-=*\s]+/, '').trim()
  const usable = (t) =>
    t.length >= 4 &&
    t.length <= 60 &&
    !/^[\w.]+\s*=/.test(t) &&
    !/(https?:\/\/|[A-Z]:\\|\/api\/|\.py\b|\.mjs\b)/i.test(t) &&
    !/^\s*(import|from|const|let|var|def|class|if|for|return|print\()/.test(t)
  try {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 25)
    for (const raw of lines) {
      const s = raw.trim()
      if (!s) continue
      if (/^#!/.test(s) || /^#\s*-\*-/.test(s)) continue
      if (!/^(#|\/\/|\*|"""|''')/.test(s)) continue
      const t = clean(s)
      if (usable(t)) return t.slice(0, 40)
    }
  } catch {}
  return ''
}

line('== ' + selfName() + '家底扫描 ' + new Date().toLocaleString('zh-CN') + ' ==')
line()

// --- ComfyUI ---
line('ComfyUI 服务')
let up = false
try {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 4000)
  const res = await fetch(BASE + '/system_stats', { signal: ctl.signal })
  clearTimeout(timer)
  const j = await res.json()
  up = res.ok
  ok(`在跑（${BASE}）`)
  const dev = j.devices?.[0]
  if (dev) ok(`设备 ${dev.name}，显存 ${Math.round(dev.vram_total / 1024 / 1024 / 1024)}G`)
} catch {
  bad('没在跑 —— 要本地出图先启动：' + PY + ' main.py --listen 127.0.0.1 --port 8188')
}
line()

// --- 模型 ---
line('模型目录（' + COMFY + '\\models）')
const dirs = { checkpoints: 'checkpoints', 'unet（千问链）': 'unet', 'text_encoders': 'text_encoders', vae: 'vae', lora: 'lora' }
const counts = {}
for (const [label, sub] of Object.entries(dirs)) {
  const r = countFiles(join(COMFY, 'models', sub))
  counts[sub] = r.files
  if (!r.exists) bad(`${label}：目录不存在`)
  else if (!r.files.length) bad(`${label}：空`)
  else ok(`${label}：${r.files.length} 个 — ${r.files.slice(0, 6).join('、')}`)
}
if (counts.checkpoints.length) {
  line()
  line('  checkpoints 明细（小于 0.5G 的八成是坏的）')
  for (const f of counts.checkpoints) {
    const size = humanSize(statSync(join(COMFY, 'models', 'checkpoints', f)).size)
    line(`    ${size.padStart(5)}  ${f}`)
  }
}
line()

// --- 出图两条路 ---
line('出图链路')
const qwenReady = counts.unet.length > 0 && counts.text_encoders.length > 0 && counts.vae.length > 0
const cloudKey = join(hostRoot(), 'config', 'dashscope.key')
const cloudReady = existsSync(cloudKey)
if (cloudReady) ok('云端百炼（万相）：有 key，走 out/qwen_draw.py —— 优先用这条')
else bad('云端百炼：缺 key（config/dashscope.key）')
if (qwenReady) ok('本地千问插件：目录齐，draw_image 可用')
else bad('本地千问插件：unet/clip/vae 有空的，draw_image 会报缺权重，别调')
if (counts.checkpoints.length) ok('本地 SD1.5：可用（写 workflow 提交 /prompt）')
else bad('本地 SD1.5：没 checkpoint')
line()

// --- 环境 ---
line('环境')
if (existsSync(PY)) ok('python：' + PY)
else bad('python 不在：' + PY)
if (existsSync(join(COMFY, 'main.py'))) ok('ComfyUI：' + COMFY)
else bad('ComfyUI 不在：' + COMFY)
ok('出图产物目录：' + OUT + (existsSync(OUT) ? '' : '（还不存在）'))
if (deep && existsSync(PY)) {
  try {
    const v = execFileSync(PY, ['-c', 'import torch, torchvision; print(torch.__version__, torchvision.__version__, torch.cuda.is_available())'], { encoding: 'utf8', timeout: 120000 }).trim()
    ok('torch / torchvision / cuda：' + v)
  } catch (e) {
    bad('torch 导入失败：' + String(e.message).split('\n')[0])
  }
} else {
  line('  · 想看 torch 版本加 --deep')
}
line()

// --- 结论 ---
line('结论')
const verdict = []
if (!up) verdict.push('ComfyUI 没开（要本地出图才需要）')
if (cloudReady) verdict.push('云端百炼可用')
if (!qwenReady) verdict.push('别用 draw_image（本地千问缺权重）')
if (counts.checkpoints.length) verdict.push('本地 SD1.5 可用')
console.log('  → ' + verdict.join('；'))

// --- 新脚本记进工具变更 ---
try {
  const root = hostRoot()
  const SEEN = join(root, 'shared', '.scan-seen.json')
  const LOG = join(root, 'shared', '工具变更.md')
  const dirs2 = [join(root, 'out'), root]
  const seen = existsSync(SEEN) ? JSON.parse(readFileSync(SEEN, 'utf8')) : {}
  const fresh = []
  for (const d of dirs2) {
    if (!existsSync(d)) continue
    for (const f of readdirSync(d)) {
      if (!/\.(py|mjs|ps1)$/i.test(f)) continue
      const key = join(d, f).toLowerCase()
      if (seen[key]) continue
      seen[key] = Date.now()
      const name = d.endsWith('out') ? 'out/' + f : f
      const purpose = guessPurpose(join(d, f)) || '（文件头没写说明，用文件名猜：' + f.replace(/\.\w+$/, '') + '）'
      fresh.push({ name, purpose })
    }
  }
  writeFileSync(SEEN, JSON.stringify(seen, null, 0))
  if (fresh.length && existsSync(LOG)) {
    const day = new Date().toISOString().slice(0, 10)
    appendFileSync(
      LOG,
      fresh.map((x) => `- ${day} · 新增脚本 · ${x.name} · 用途：${x.purpose} · 状态：待验证\n`).join('')
    )
    line()
    line('新脚本已记进 shared/工具变更.md：' + fresh.slice(0, 6).map((x) => x.name).join('、'))
  }
} catch (e) {
  bad('记脚本变更失败：' + String(e.message).split('\n')[0])
}

// --- 新插件也记一行 ---
try {
  const root = hostRoot()
  const PLUG = join(os.homedir(), '.dsh', 'plugins')
  const LOG = join(root, 'shared', '工具变更.md')
  const SEENP = join(root, 'shared', '.scan-seen-plugins.json')
  const seen = existsSync(SEENP) ? JSON.parse(readFileSync(SEENP, 'utf8')) : {}
  const fresh = []
  if (existsSync(PLUG)) {
    for (const d of readdirSync(PLUG)) {
      const pj = join(PLUG, d, 'package.json')
      if (!existsSync(pj) || seen[d]) continue
      let desc = ''
      try {
        const j = JSON.parse(readFileSync(pj, 'utf8'))
        desc = (j.description || '').toString().replace(/\s+/g, ' ').trim().slice(0, 50)
      } catch {}
      seen[d] = Date.now()
      fresh.push({ name: d, desc })
    }
  }
  writeFileSync(SEENP, JSON.stringify(seen, null, 0))
  if (fresh.length && existsSync(LOG)) {
    const day = new Date().toISOString().slice(0, 10)
    appendFileSync(
      LOG,
      fresh.map((x) => `- ${day} · 新增插件 · ${x.name} · 用途：${x.desc || '（插件没写简介，待补一句）'} · 状态：待验证\n`).join('')
    )
    line('新插件已记进 shared/工具变更.md：' + fresh.map((x) => x.name).join('、'))
  }
} catch (e) {
  bad('记插件变更失败：' + String(e.message).split('\n')[0])
}

// --- 实况写进根页 ---
try {
  const ROOT = join(hostRoot(), 'SHARED-STATE.md')
  if (existsSync(ROOT)) {
    const qwen = qwenReady ? '本地千问可用' : '本地千问不可用（unet/clip/vae 空）'
    const cloud = cloudReady ? '云端百炼可用（qwen_draw.py）' : '云端百炼缺 key'
    const sd = counts.checkpoints.length ? `SD1.5 ${counts.checkpoints.length} 个` : 'SD1.5 无模型'
    const comfy = up ? 'ComfyUI 在线' : 'ComfyUI 没开'
    const snap = `${cloud} · ${qwen} · ${sd} · ${comfy} · 扫描于 ${new Date().toLocaleString('zh-CN')}`
    const txt = readFileSync(ROOT, 'utf8')
    const next = txt.replace(/<!-- AUTO:BEGIN -->[\s\S]*?<!-- AUTO:END -->/, `<!-- AUTO:BEGIN -->${snap}<!-- AUTO:END -->`)
    if (next !== txt) {
      writeFileSync(ROOT, next)
      line()
      line('已把实况写进根页：' + snap)
    }
  }
} catch (e) {
  bad('写根页失败：' + String(e.message).split('\n')[0])
}
