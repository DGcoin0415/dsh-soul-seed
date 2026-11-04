// 模糊回忆：把长对话原文切块、向量化、存本地索引，按语义检索。
// 精确的东西（人设、规矩、账本）仍在文本树里，这条只管「想不起在哪提过」。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EMBED_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings'
const EMBED_MODEL = 'text-embedding-v3'
const CHUNK_CHARS = 600
const OVERLAP = 80
// 混检权重：向量管"意思像"，关键词管"字面上有"，合起来比单走向量稳
const W_VEC = 0.7
const W_KW = Number(process.env.RAG_W || 0.3)

export function soulDir() {
  const custom = process.env.DSH_SOUL_DIR
  return custom && custom.trim() ? path.resolve(custom.trim()) : path.join(os.homedir(), '.dsh', 'im')
}
export const longDir = () => {
  const base = path.join(soulDir(), 'shared')
  const leaves = path.join(base, '落叶')
  const legacy = path.join(base, '长文')
  if (fs.existsSync(leaves)) return leaves
  if (fs.existsSync(legacy)) return legacy
  return leaves
}
export const indexDir = () => path.join(soulDir(), 'shared', '向量')
const indexFile = () => path.join(indexDir(), 'index.json')

function readKey() {
  const candidates = [
    path.join(os.homedir(), '.bili-ai', 'image-keys.json'),
  ]
  for (const f of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (j.dashscope) return j.dashscope
    } catch {}
  }
  return process.env.DASHSCOPE_API_KEY || ''
}

async function embed(texts) {
  const key = readKey()
  if (!key) throw new Error('没有 dashscope key（~/.bili-ai/image-keys.json 里的 dashscope）')
  const r = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, encoding_format: 'float' }),
  })
  if (!r.ok) throw new Error(`embedding 失败 ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const j = await r.json()
  return j.data.map((d) => d.embedding)
}

/** 把一段长文切成块。 */
export function chunkText(text, size = CHUNK_CHARS, overlap = OVERLAP) {
  const clean = String(text).replace(/\r/g, '').trim()
  const out = []
  let i = 0
  while (i < clean.length) {
    out.push(clean.slice(i, i + size))
    if (i + size >= clean.length) break
    i += size - overlap
  }
  return out.filter((c) => c.trim().length > 40)
}

/** 从一段原文里抠出它覆盖的时间段和说话人，挂到块上，检索时能拿来过滤和提权。 */
function metaOf(chunk) {
  const dates = new Set()
  const who = new Set()
  for (const line of chunk.split('\n')) {
    const m = line.match(/^-\s*\[(\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?\]\s*([^：:]{1,12})[：:]/)
    if (m) {
      dates.add(m[1])
      who.add(m[3].trim())
    }
  }
  return { dates: [...dates], who: [...who] }
}

/** 关键词切分：中文按二元组，英文按词。用于混检的字面命中打分。 */
function tokens(s) {
  const text = String(s).toLowerCase()
  const out = new Set()
  for (const w of text.match(/[a-z0-9_./-]{2,}/g) || []) out.add(w)
  const han = text.replace(/[^\u4e00-\u9fa5]+/g, '')
  for (let i = 0; i < han.length - 1; i++) out.add(han.slice(i, i + 2))
  return out
}

export function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(indexFile(), 'utf8'))
  } catch {
    return { version: 1, model: EMBED_MODEL, chunks: [] }
  }
}

function saveIndex(idx) {
  fs.mkdirSync(indexDir(), { recursive: true })
  const tmp = indexFile() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(idx), 'utf8')
  fs.renameSync(tmp, indexFile())
}

/** 把 shared/长文 下所有 .md 建进索引（已建过的按内容哈希跳过）。 */
export async function buildIndex({ log = () => {} } = {}) {
  fs.mkdirSync(longDir(), { recursive: true })
  // 落叶 + 12 小时分页：分页才是完整记录，光建落叶会漏掉最近的对话
  const pagesDir = path.join(soulDir(), 'shared', '全量', '页')
  const sources = []
  for (const f of fs.readdirSync(longDir()).filter((f) => f.endsWith('.md'))) {
    sources.push({ name: f, full: path.join(longDir(), f) })
  }
  if (fs.existsSync(pagesDir)) {
    for (const f of fs.readdirSync(pagesDir).filter((f) => /^\d{4}-\d{2}-\d{2}-(AM|PM)\.md$/.test(f))) {
      sources.push({ name: `页/${f}`, full: path.join(pagesDir, f) })
    }
  }
  const idx = loadIndex()
  const known = new Set(idx.chunks.map((c) => c.id))
  const fresh = []
  for (const src of sources) {
    const text = fs.readFileSync(src.full, 'utf8')
    chunkText(text).forEach((chunk, n) => {
      const id = `${src.name}#${n}`
      if (!known.has(id)) fresh.push({ id, file: src.name, text: chunk, ...metaOf(chunk) })
    })
  }
  log(`待入库 ${fresh.length} 块（已有 ${idx.chunks.length}）`)
  for (let i = 0; i < fresh.length; i += 10) {
    const batch = fresh.slice(i, i + 10)
    const vectors = await embed(batch.map((b) => b.text))
    batch.forEach((b, k) => idx.chunks.push({ ...b, v: vectors[k] }))
    log(`已入库 ${Math.min(i + 10, fresh.length)}/${fresh.length}`)
  }
  idx.builtAt = new Date().toISOString()
  saveIndex(idx)
  return { total: idx.chunks.length, added: fresh.length }
}

const dot = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]
  return s
}

/** 语义检索（混检：向量 + 关键词）。HYBRID=0 时退回纯向量，方便对比。 */
export async function recall(query, topK = 5) {
  const idx = loadIndex()
  if (!idx.chunks.length) return { hits: [], note: '索引是空的，先跑一次 rag-index' }
  const [qv] = await embed([query])
  const qt = tokens(query)
  const hybrid = process.env.HYBRID !== '0'
  const scored = idx.chunks.map((c) => {
    const vec = dot(qv, c.v)
    let kw = 0
    if (hybrid && qt.size) {
      const ct = tokens(c.text)
      let hit = 0
      for (const t of qt) if (ct.has(t)) hit += /^[a-z0-9_.-]{4,}$/.test(t) ? 3 : 1
      kw = hit / Math.sqrt(ct.size || 1) / Math.sqrt(qt.size)
    }
    return { ...c, vec: Number(vec.toFixed(3)), kw: Number(kw.toFixed(3)), score: hybrid ? vec * W_VEC + kw * W_KW : vec }
  })
  scored.sort((a, b) => b.score - a.score)
  return {
    hits: scored.slice(0, topK).map(({ text, file, score, vec, kw, dates, who }) => ({
      text,
      file,
      score: Number(score.toFixed(3)),
      vec,
      kw,
      dates: dates || [],
      who: who || [],
    })),
  }
}

