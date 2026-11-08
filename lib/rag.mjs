// 模糊回忆：把长对话原文切块、向量化、存本地索引，按语义检索。
// 精确的东西（人设、规矩、账本）仍在文本树里，这条只管「想不起在哪提过」。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EMBED_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings'
// 向量化：默认走智谱 embedding-3（便宜、已有 key），可用 RAG_EMBED 切回 dashscope
const PROVIDERS = {
  zhipu: {
    url: 'https://open.bigmodel.cn/api/paas/v4/embeddings',
    model: 'embedding-3',
    keyName: 'zhipu',
  },
  dashscope: {
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings',
    model: 'text-embedding-v3',
    keyName: 'dashscope',
  },
}
const PREF = (process.env.RAG_EMBED || 'zhipu').trim().toLowerCase()
const EMBED_MODEL = (PROVIDERS[PREF] || PROVIDERS.zhipu).model
let usedProvider = PREF
let lastDim = 0
const CHUNK_CHARS = 600
const OVERLAP = 80
// 混检权重：向量管"意思像"，关键词管"字面上有"，合起来比单走向量稳
const W_VEC = 0.7
const W_KW = Number(process.env.RAG_W || 0.3)

export function soulDir() {
  // 这里返回的是**共享工作区**（落叶 / 全量页 / 索引都在它下面），不是灵魂数据目录。
  // 2026-11-08 修：原来读的是 DSH_SOUL_DIR —— 那是另一个意思，导致设了变量也不生效。
  const custom = process.env.DSH_SHARED_DIR || process.env.SOUL_HOME || process.env.DSH_SOUL_DIR
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

function readKey(name) {
  const candidates = [
    process.env.DSH_SOUL_DIR ? path.join(process.env.DSH_SOUL_DIR, 'image-keys.json') : '',
    path.join(os.homedir(), '.dsh', 'soul-seed', 'image-keys.json'),
    path.join(os.homedir(), '.bili-ai', 'image-keys.json'),   // 老位置
  ].filter(Boolean)
  for (const f of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (j[name]) return j[name]
    } catch {}
  }
  return process.env[name === 'zhipu' ? 'ZHIPU_API_KEY' : 'DASHSCOPE_API_KEY'] || ''
}

async function embed(texts) {
  const list = [PREF, ...Object.keys(PROVIDERS).filter((k) => k !== PREF)]
  let lastErr = null
  for (const name of list) {
    const p = PROVIDERS[name]
    if (!p) continue
    const key = readKey(p.keyName)
    if (!key) continue
    try {
      const r = await fetch(p.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: p.model, input: texts, encoding_format: 'float' }),
      })
      if (!r.ok) throw new Error(`${name} ${r.status}: ${(await r.text()).slice(0, 160)}`)
      const j = await r.json()
      if (!Array.isArray(j.data) || !j.data.length) throw new Error(name + ' 返回空 data')
      // 记一下实际用哪家（索引里会带 model 名，切了 provider 必须重建索引）
      if (j.data[0].embedding.length) lastDim = j.data[0].embedding.length
      usedProvider = name
      return j.data.map((d) => d.embedding)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('没有可用的 embedding key（image-keys.json 里要有 zhipu 或 dashscope）')
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

// 2026-11-04：向量改成二进制存，JSON 存浮点文本太占地方（703 块 1024 维 = 15 MB）
const binFile = () => path.join(indexDir(), 'index.bin')
const metaFile = () => path.join(indexDir(), 'index.meta.json')

export function loadIndex() {
  // 新格式：index.bin（Float32 连续存）+ index.meta.json（不含向量的块信息）
  try {
    if (fs.existsSync(binFile()) && fs.existsSync(metaFile())) {
      const meta = JSON.parse(fs.readFileSync(metaFile(), 'utf8'))
      const dim = Number(meta.dim) || 1024
      const buf = fs.readFileSync(binFile())
      const total = Math.floor(buf.length / 4)
      const n = Math.min(meta.chunks.length, Math.floor(total / dim))
      const flat = new Float32Array(buf.buffer, buf.byteOffset, n * dim)
      const chunks = meta.chunks.slice(0, n).map((c, i) => ({
        ...c,
        v: Array.from(flat.subarray(i * dim, (i + 1) * dim)),
      }))
      return { version: 2, model: meta.model || EMBED_MODEL, dim, chunks }
    }
  } catch {}
  // 旧格式兜底，读到了下次保存会自动转成新的
  try {
    return JSON.parse(fs.readFileSync(indexFile(), 'utf8'))
  } catch {
    return { version: 1, model: EMBED_MODEL, chunks: [] }
  }
}

export function saveIndex(idx) {
  fs.mkdirSync(indexDir(), { recursive: true })
  const dim = Number(idx.dim) || idx.chunks[0]?.v?.length || 1024
  const n = idx.chunks.length
  const buf = Buffer.alloc(n * dim * 4)
  const flat = new Float32Array(buf.buffer, buf.byteOffset, n * dim)
  const chunks = idx.chunks.map((c, i) => {
    const v = c.v || []
    for (let k = 0; k < dim; k++) flat[i * dim + k] = Number(v[k]) || 0
    const { v: _drop, ...rest } = c
    return rest
  })
  // Windows 上目标文件偶尔被别的进程占着，rename 会 EPERM；重试几次，不行就复制覆盖
  const put = (from, to) => {
    for (let i = 0; i < 5; i++) {
      try {
        fs.renameSync(from, to)
        return
      } catch {
        try {
          fs.copyFileSync(from, to)
          fs.unlinkSync(from)
          return
        } catch {
          const until = Date.now() + 200
          while (Date.now() < until) {}
        }
      }
    }
    throw new Error(`写不进索引：${to}`)
  }
  const metaTmp = metaFile() + '.tmp'
  fs.writeFileSync(metaTmp, JSON.stringify({ version: 2, model: idx.model, dim, chunks }), 'utf8')
  put(metaTmp, metaFile())
  const binTmp = binFile() + '.tmp'
  fs.writeFileSync(binTmp, buf)
  put(binTmp, binFile())
  // 旧 JSON 不再用，删掉省地方
  try {
    if (fs.existsSync(indexFile())) fs.unlinkSync(indexFile())
  } catch {}
}

/**
 * 把 shared/长文 下所有 .md 建进索引（已建过的按内容哈希跳过）。
 * 只留最近 N 天：默认 90，用 SOUL_RAG_DAYS 调；更早的块直接不进索引，也不会留在里面。
 */
export async function buildIndex({ log = () => {} } = {}) {
  fs.mkdirSync(longDir(), { recursive: true })
  const keepDays = Number(process.env.SOUL_RAG_DAYS || 90)
  const cutoff = Date.now() - keepDays * 86400000
  const fileDay = (name) => {
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(name)
    return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00`) : Infinity
  }
  // 落叶 + 12 小时分页：分页才是完整记录，光建落叶会漏掉最近的对话
  const pagesDir = path.join(soulDir(), 'shared', '全量', '页')
  const sources = []
  for (const f of fs.readdirSync(longDir()).filter((f) => f.endsWith('.md'))) {
    if (fileDay(f) < cutoff) continue
    sources.push({ name: f, full: path.join(longDir(), f) })
  }
  if (fs.existsSync(pagesDir)) {
    for (const f of fs.readdirSync(pagesDir).filter((f) => /^\d{4}-\d{2}-\d{2}-(AM|PM)\.md$/.test(f))) {
      if (fileDay(f) < cutoff) continue
      sources.push({ name: `页/${f}`, full: path.join(pagesDir, f) })
    }
  }
  const loaded = loadIndex()
  // 过期的块直接剪掉，不然索引只涨不减
  const kept = loaded.chunks.filter((c) => fileDay(String(c.file || '')) >= cutoff)
  const idx = { ...loaded, chunks: kept }
  if (kept.length !== loaded.chunks.length) log(`剪掉过期块 ${loaded.chunks.length - kept.length} 个（保留 ${keepDays} 天）`)
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

// ── 问法扩展：同一个事实，换个问法也得捞得着（2026-11-08 从 memory-find 下沉过来）
// 之前只写在命令行工具里，评测/面板走 recall() 就享受不到 —— 这是个真的架构错。
export const QUERY_EXPAND = new Map([
  ['全名', ['名字', '叫', '称呼', '姓名']],
  ['名字', ['全名', '叫', '称呼']],
  ['多大', ['岁', '年龄', '年纪']],
  ['年龄', ['岁', '多大', '年纪']],
  ['生日', ['月', '日', '过生', '出生']],
  ['住哪', ['住', '区', '地址', '合租']],
  ['做什么', ['工作', '职业', '上班', '客服']],
  ['欠', ['还', '欠着', '剩', '记着']],
  ['答应', ['说好', '约定', '算一个']],
  ['矛盾', ['对不上', '前后', '改口', '说过']],
  ['对不上', ['矛盾', '前后', '改口']],
])

// 这类问法要把散落的几处拼起来，召回给多一点
export const NEEDS_MORE = /矛盾|对不上|前后|改口|理一下|整理|汇总|都有哪些|几件|哪些事|回忆|跟进|后来|进展/

export function expandTokens(tokens) {
  const out = new Set(tokens)
  for (const tk of tokens) {
    const extra = QUERY_EXPAND.get(tk)
    if (extra) for (const e of extra) out.add(e)
  }
  return out
}

/** 语义检索（混检：向量 + 关键词）。HYBRID=0 时退回纯向量，方便对比。 */
/** 问法扩展与自动多召都在这里面，不用调用方再管。 */
export async function recall(query, topK = 5) {
  const idx = loadIndex()
  if (!idx.chunks.length) return { hits: [], note: '索引是空的，先跑一次 rag-index' }
  const [qv] = await embed([query])
  const qtBase = tokens(query)
  const qt = expandTokens(qtBase)
  const hybrid = process.env.HYBRID !== '0'

  // idf：稀有的词（奶油、覃玲）比通用词（今天、说）重要得多。
  // 没有这一步，长块会被自己的长度稀释，具体事实就排不上来。
  const df = new Map()
  const chunkToks = idx.chunks.map((c) => tokens(c.text))
  for (const set of chunkToks) for (const tk of set) df.set(tk, (df.get(tk) || 0) + 1)
  const N = idx.chunks.length || 1
  const idf = (tk) => Math.log(1 + N / (1 + (df.get(tk) || 0)))
  const wantMore = NEEDS_MORE.test(String(query))
  const kWant = wantMore ? Math.max(topK, 12) : topK
  const scored = idx.chunks.map((c, ci) => {
    const vec = dot(qv, c.v)
    let kw = 0
    if (hybrid && qt.size) {
      const ct = chunkToks[ci] || tokens(c.text)
      let hit = 0
      for (const t of qt) if (ct.has(t)) hit += idf(t) * (/^[a-z0-9_.-]{4,}$/.test(t) ? 2 : 1)
      kw = hit / Math.sqrt(Math.max(1, qtBase.size))
    }
    return { ...c, vec: Number(vec.toFixed(3)), kw: Number(kw.toFixed(3)), score: hybrid ? vec * W_VEC + kw * W_KW : vec }
  })
  scored.sort((a, b) => b.score - a.score)

  // 稀有词直查：像「奶油」「覃玲」这种在整份历史里只出现几处的词，
  // 只要问题里提到了，含它的块就必须进候选 —— 语义相似度会漏掉它们。
  const rareHits = []
  const rareToks = [...qt].filter((tk) => {
    const d = df.get(tk) || 0
    return d > 0 && d <= Math.max(8, Math.ceil(N * 0.05)) && tk.length >= 2
  })
  if (rareToks.length) {
    const seen = new Set()
    for (const [ci, set] of chunkToks.entries()) {
      let sum = 0
      let hit = 0
      for (const tk of rareToks) if (set.has(tk)) { sum += idf(tk); hit++ }
      if (hit) {
        const c = idx.chunks[ci]
        if (c) {
          seen.add(c.id)
          const matched = rareToks.filter((tk) => set.has(tk))
          const best = Math.max(...matched.map((tk) => idf(tk)))
          rareHits.push({ ...c, vec: 0, kw: Number(sum.toFixed(3)), score: Number(best.toFixed(3)), rare: matched.slice(0, 4) })
        }
      }
    }
    rareHits.sort((a, b) => b.score - a.score)
    // 尺度不同：向量 0.3~0.9、稀有词 1~4，混在一起排会把无关块顶上去。
    // 所以不改主排序，只把最该看的 3 块「插」到前面（第 2~4 位）。
    const top = scored.slice(0, kWant)
    for (const rh of rareHits.slice(0, 3)) {
      if (top.some((s) => s.id === rh.id)) continue
      top.splice(Math.min(top.length, 1 + top.filter((s) => s.rare).length), 0, rh)
    }
    return {
      hits: top.map(({ text, file, score, vec, kw, dates, who, rare }) => ({
        text,
        file,
        score: Number(Number(score).toFixed(3)),
        vec,
        kw,
        dates: dates || [],
        who: who || [],
        rare: rare || [],
      })),
      note: rareToks.length ? '含稀有词直查：' + rareToks.slice(0, 4).join('、') : undefined,
    }
  }

  return {
    hits: scored.slice(0, kWant).map(({ text, file, score, vec, kw, dates, who }) => ({
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

