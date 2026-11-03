// 模糊回忆：把长对话原文切块、向量化、存本地索引，按语义检索。
// 精确的东西（人设、规矩、账本）仍在文本树里，这条只管「想不起在哪提过」。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EMBED_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings'
const EMBED_MODEL = 'text-embedding-v3'
const CHUNK_CHARS = 600
const OVERLAP = 80

export function soulDir() {
  const custom = process.env.SOUL_SEED_ROOT
  return custom && custom.trim() ? path.resolve(custom.trim()) : path.join(os.homedir(), '.bili-ai')
}
export const longDir = () => path.join(soulDir(), 'shared', '长文')
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
  const files = fs.readdirSync(longDir()).filter((f) => f.endsWith('.md'))
  const idx = loadIndex()
  const known = new Set(idx.chunks.map((c) => c.id))
  const fresh = []
  for (const f of files) {
    const text = fs.readFileSync(path.join(longDir(), f), 'utf8')
    chunkText(text).forEach((chunk, n) => {
      const id = `${f}#${n}`
      if (!known.has(id)) fresh.push({ id, file: f, text: chunk })
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

/** 语义检索。 */
export async function recall(query, topK = 5) {
  const idx = loadIndex()
  if (!idx.chunks.length) return { hits: [], note: '索引是空的，先跑一次 rag-index' }
  const [qv] = await embed([query])
  const scored = idx.chunks.map((c) => ({ ...c, score: dot(qv, c.v) }))
  scored.sort((a, b) => b.score - a.score)
  return {
    hits: scored.slice(0, topK).map(({ text, file, score }) => ({ text, file, score: Number(score.toFixed(3)) })),
  }
}

