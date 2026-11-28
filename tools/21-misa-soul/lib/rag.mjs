// 模糊回忆：把长对话原文切块、向量化、存本地索引，按语义检索。
// 精确的东西（人设、规矩、账本）仍在文本树里，这条只管「想不起在哪提过」。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 向量化：智谱优先（便宜、有额度），dashscope 兜底，本地 Ollama 再兜一层；RAG_EMBED 可改顺序
const PROVIDERS = {
  zhipu: {
    url: 'https://open.bigmodel.cn/api/paas/v4/embeddings',
    model: 'embedding-3',
    keyName: 'zhipu',
    env: 'ZHIPU_KEY',
  },
  dashscope: {
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings',
    model: 'text-embedding-v3',
    keyName: 'dashscope',
    env: 'DASHSCOPE_API_KEY',
  },
  local: {
    url: 'http://127.0.0.1:11434/v1/embeddings',
    model: 'bge-m3',
    keyName: 'local',
    env: '',
  },
}
const PREF = (process.env.RAG_EMBED || 'local').trim().toLowerCase()
const EMBED_MODEL = (PROVIDERS[PREF] || PROVIDERS.zhipu).model
let usedProvider = PREF
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

function readKey(keyName) {
  if (keyName === 'local') return 'ollama' // 本机 Ollama 不校验 key，给个占位
  const candidates = [path.join(os.homedir(), '.bili-ai', 'image-keys.json')]
  for (const f of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (j[keyName]) return j[keyName]
    } catch {}
  }
  const p = PROVIDERS[keyName]
  return (p && process.env[p.env]) || ''
}

async function embed(texts) {
  // 一家挂了自动换下一家，全挂了才报错
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
  // 新格式：index.bin + index.meta.json（不含向量的块信息）
  //   v2 = Float32 连续存；v3 = int8 量化（每块一个 float32 缩放系数 + dim 个 int8）
  //   2026-11-24 master 让瘦身：1581 块 × 1024 维，Float32 要 6.2MB，int8 只要 1.6MB。
  try {
    if (fs.existsSync(binFile()) && fs.existsSync(metaFile())) {
      const meta = JSON.parse(fs.readFileSync(metaFile(), 'utf8'))
      const dim = Number(meta.dim) || 1024
      const buf = fs.readFileSync(binFile())
      const quant = Number(meta.version) >= 3 && meta.quant === 'i8'
      if (quant) {
        const n = Math.min(meta.chunks.length, Math.floor((buf.length - 0) / (dim + 4)))
        const hdr = 0
        const qBase = n * 4
        const chunks = meta.chunks.slice(0, n).map((c, i) => {
          const scale = buf.readFloatLE(hdr + i * 4) || 0
          const v = new Array(dim)
          const off = qBase + i * dim
          for (let k = 0; k < dim; k++) v[k] = buf.readInt8(off + k) * scale
          return { ...c, v }
        })
        return { version: 3, model: meta.model || EMBED_MODEL, dim, chunks }
      }
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
  // v3：每块算一个 maxAbs，缩到 int8（-127..127），重建时乘回来。
  const buf = Buffer.alloc(n * 4 + n * dim)
  const chunks = idx.chunks.map((c, i) => {
    const v = c.v || []
    let maxAbs = 0
    for (let k = 0; k < dim; k++) {
      const x = Math.abs(Number(v[k]) || 0)
      if (x > maxAbs) maxAbs = x
    }
    const scale = maxAbs > 0 ? maxAbs / 127 : 0
    buf.writeFloatLE(scale, i * 4)
    const off = n * 4 + i * dim
    for (let k = 0; k < dim; k++) {
      const q = scale ? Math.max(-127, Math.min(127, Math.round((Number(v[k]) || 0) / scale))) : 0
      buf.writeInt8(q, off + k)
    }
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
  fs.writeFileSync(metaTmp, JSON.stringify({ version: 3, quant: 'i8', model: idx.model, dim, chunks }), 'utf8')
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
  // 原话库：每回合原样存的对话，检索时一起进候选
  const originDir = path.join(soulDir(), 'shared', '原话')
  if (fs.existsSync(originDir)) {
    for (const f of fs.readdirSync(originDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))) {
      if (fileDay(f) < cutoff) continue
      sources.push({ name: `原话/${f}`, full: path.join(originDir, f) })
    }
  }
  const loaded = loadIndex()
  // provider 变了（维度不同），旧向量全作废，整份重建，不能新旧掺着算
  const stale = loaded.model && loaded.model !== EMBED_MODEL
  if (stale) log(`索引是 ${loaded.model} 建的，现在是 ${EMBED_MODEL}，整份重建`)
  // 过期的块直接剪掉，不然索引只涨不减
  const kept = stale ? [] : loaded.chunks.filter((c) => fileDay(String(c.file || '')) >= cutoff)
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

// 问法扩展：同一个事实，换个问法也得捞得着
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
  ['分页', ['page-archive', '翻转页', '定时页']],
  ['工具分组', ['tool_gate', 'tool-groups']],
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

/** 按整句做术语映射：多字词（工具分组）不会被二元组切出来，得单独对原文匹配。 */
export function expandQuery(query, tokenSet) {
  const out = expandTokens(tokenSet)
  const q = String(query)
  for (const [k, vs] of QUERY_EXPAND) if (q.includes(k)) for (const v of vs) out.add(v)
  return out
}

const dot = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]
  return s
}

/** 低分兜底用的重排：只在检索明显没底的时候调一次智谱 rerank。 */
async function tryRerank(query, candidates) {
  const key = readKey('zhipu')
  if (!key || !candidates.length) return null
  try {
    const r = await fetch('https://open.bigmodel.cn/api/paas/v4/rerank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'rerank',
        query,
        documents: candidates.map((c) => String(c.text).slice(0, 300)),
        top_n: Math.min(8, candidates.length),
      }),
    })
    if (!r.ok) return null
    const j = await r.json()
    const rows = Array.isArray(j.results) ? j.results : []
    if (!rows.length) return null
    return rows.map((x) => ({ ...candidates[x.index], score: Number(Number(x.relevance_score).toFixed(3)), reranked: true }))
  } catch {
    return null
  }
}

/** 语义检索（混检：向量 + 关键词）。HYBRID=0 时退回纯向量，方便对比。 */
async function recallRaw(query, topK = 5) {
  const idx = loadIndex()
  if (!idx.chunks.length) return { hits: [], note: '索引是空的，先跑一次 rag-index' }
  // 索引是按哪个模型建的就得用哪个查：换了 provider、维度不同，混着算全是错数
  if (idx.model && idx.model !== EMBED_MODEL) {
    return { hits: [], note: `索引是 ${idx.model} 建的，现在是 ${EMBED_MODEL}，先跑一次 rag-index 重建` }
  }
  const [qv] = await embed([query])
  const qtBase = tokens(query)
  const qt = expandQuery(query, qtBase)
  const hybrid = process.env.HYBRID !== '0'

  // idf：稀有的词比通用词重要得多；没有这一步，长块会被自己的长度稀释
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
      kw = hit / Math.sqrt(Math.max(1, ct.size)) / Math.sqrt(Math.max(1, qtBase.size))
    }
    return { ...c, vec: Number(vec.toFixed(3)), kw: Number(kw.toFixed(3)), score: hybrid ? vec * W_VEC + kw * W_KW : vec }
  })
  scored.sort((a, b) => b.score - a.score)
  // 低分兜底：top1 分低、前三又几乎没区分度，说明这次检索没底，才调一次重排；
  // 平常不调，省延迟也省重排的钱。
  const top1 = scored[0]
  const top3 = scored[Math.min(2, scored.length - 1)]
  if (hybrid && top1 && top1.score < 0.45 && top1.score - (top3?.score || 0) < 0.02) {
    const rr = await tryRerank(query, scored.slice(0, 20))
    if (rr && rr.length) {
      return {
        hits: rr.slice(0, kWant).map(({ text, file, score, dates, who, vec, kw }) => ({
          text,
          file,
          score,
          vec: vec || 0,
          kw: kw || 0,
          dates: dates || [],
          who: who || [],
        })),
        note: '低分触发重排',
      }
    }
  }
  // 稀有词直查：只出现一两处的词（tool_gate、page-archive 这类），问题里提了就基本是正解，
  // 向量分往往被长块稀释挤不上去，所以直接在 hybrid 模式下把它们顶到前三位。
  if (hybrid) {
    const rareToks = [...qt].filter((tk) => {
      const d = df.get(tk) || 0
      return d > 0 && d <= 2 && tk.length >= 4
    })
    if (rareToks.length) {
      const top = scored.slice(0, kWant)
      const found = []
      for (let ci = 0; ci < chunkToks.length; ci++) {
        const set = chunkToks[ci]
        const matched = rareToks.filter((tk) => set.has(tk))
        if (!matched.length) continue
        const c = idx.chunks[ci]
        if (!c) continue
        const best = Math.max(...matched.map((tk) => idf(tk)))
        found.push({ ...c, vec: 0, kw: 0, score: Number(best.toFixed(3)), rare: matched.slice(0, 3) })
      }
      found.sort((a, b) => b.score - a.score)
      for (const f of found.slice(0, 2)) {
        if (top.some((s) => s.id === f.id)) continue
        top.splice(Math.min(2, top.length), 0, f)
      }
      if (found.length) {
        return {
          hits: top.slice(0, kWant).map(({ text, file, score, vec, kw, dates, who, rare }) => ({
            text, file, score: Number(Number(score).toFixed(3)), vec, kw,
            dates: dates || [], who: who || [], rare: rare || [],
          })),
          note: '含稀有词直查：' + rareToks.slice(0, 4).join('、'),
        }
      }
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

// ------------------------------------------------- 时间衰减（2026-11-27 master 定）
// 老记忆不该跟新记忆平分秋色：越旧排名越靠后，但只降权、不删除、不硬砍。
// SOUL_RAG_DECAY=0 时整段跳过，打分跟以前一模一样。
const DECAY_ON = String(process.env.SOUL_RAG_DECAY ?? '').trim() !== '0'
const DECAY_HALF_LIFE_DAYS = 90 // 半衰期：90 天系数掉一半
const DECAY_FLOOR = 0.6 // 下限：最旧也只打六折
const DECAY_EXPIRED = 0.3 // 显式过期：再乘 0.3
const DAY_MS = 86400000

/** 从文本里抠出所有认得出的日期（本地零点时间戳）；认不出就给空数组，不抛错。 */
function datesIn(text) {
  const out = []
  let s = ''
  try {
    s = String(text ?? '')
  } catch {
    return out
  }
  if (!s) return out
  const y = new Date().getFullYear()
  const push = (yy, mm, dd) => {
    const Y = Number(yy)
    const M = Number(mm)
    const D = Number(dd)
    if (!(M >= 1 && M <= 12 && D >= 1 && D <= 31)) return
    const t = new Date(Y, M - 1, D)
    // 2 月 31 日这种假日期直接丢
    if (t.getFullYear() !== Y || t.getMonth() !== M - 1 || t.getDate() !== D) return
    out.push(t.getTime())
  }
  try {
    // 全日期：2026-11-26 / 2026/11/26
    for (const m of s.matchAll(/(?<!\d)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/g)) push(m[1], m[2], m[3])
    // 短日期：11-26（补当前年）。先把全日期抹掉，免得 2026-11-26 的尾巴被再算一遍
    const rest = s.replace(/(?<!\d)\d{4}[-/]\d{1,2}[-/]\d{1,2}(?!\d)/g, ' ')
    for (const m of rest.matchAll(/(?<!\d)(\d{1,2})[-/](\d{1,2})(?!\d)/g)) push(y, m[1], m[2])
  } catch {}
  return out
}

/** 一条 hit 的最新日期：优先块正文里解析出来的（取最大那个），再退 dates 字段和文件名。 */
function latestDateOf(hit) {
  if (!hit) return null
  const inText = datesIn(hit.text)
  if (inText.length) return Math.max(...inText)
  const extra = [Array.isArray(hit.dates) ? hit.dates.join(' ') : '', hit.file || ''].join(' ')
  const inExtra = datesIn(extra)
  return inExtra.length ? Math.max(...inExtra) : null
}

/** 显式过期标记：「过期 / 已过期」或「有效至 2026-01-01」且日期已过。否定的（不过期）不算。 */
function isExpired(text) {
  let s = ''
  try {
    s = String(text ?? '')
  } catch {
    return false
  }
  if (!s) return false
  try {
    // 逐个「过期」看前三个字里有没有否定词：不过期 / 不要过期 / 还没过期 / 别过期 都不算
    const re = /过期/g
    let m
    while ((m = re.exec(s))) {
      const before = s.slice(Math.max(0, m.index - 3), m.index)
      if (/[不没未别勿]/.test(before)) continue
      return true
    }
  } catch {}
  try {
    for (const m of s.matchAll(/有效[日至期限至]*[：:\s]*(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g)) {
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
      if (Number.isFinite(t) && t < Date.now()) return true
    }
  } catch {}
  return false
}

/** 算一条 hit 的衰减系数：1 = 没衰减。天数解析不出来就按 1 走。 */
function decayOf(hit) {
  try {
    const t = latestDateOf(hit)
    if (t == null) return 1
    const days = Math.max(0, (Date.now() - t) / DAY_MS)
    let factor = Math.pow(0.5, days / DECAY_HALF_LIFE_DAYS)
    if (!Number.isFinite(factor)) return 1
    if (factor < DECAY_FLOOR) factor = DECAY_FLOOR
    if (isExpired(hit && hit.text)) factor *= DECAY_EXPIRED
    return factor
  } catch {
    return 1
  }
}

/** 给 hits 打分乘衰减系数再重排；任何一步出错都原样退回，绝不把检索搞挂。 */
function applyDecay(hits) {
  if (!Array.isArray(hits)) return hits
  try {
    const out = hits.map((h) => {
      try {
        if (!h) return h
        const factor = decayOf(h)
        const score = Number(h.score)
        if (!Number.isFinite(score)) return { ...h, decay: 1 }
        return { ...h, score: Number((score * factor).toFixed(3)), decay: Number(Number(factor).toFixed(3)) }
      } catch {
        return h
      }
    })
    out.sort((a, b) => (Number(b?.score) || 0) - (Number(a?.score) || 0))
    return out
  } catch {
    return hits
  }
}

/**
 * 输出层措辞归一：历史原文里常把另一条会话说成「微信侧 / QQ 侧」，
 * 吐给模型前换成「那条会话（还是咱）」，免得把它当成别人。
 * 只改返回给调用方的字符串，源文件一个字不改；幂等，跑两遍结果一样。
 */
export function softenChannelWords(input) {
  let out = String(input ?? '')
  out = out.replace(/微信侧/g, '微信那条会话（还是咱）')
  out = out.replace(/QQ\s?侧/g, 'QQ 那条会话（还是咱）')
  return out
}

/** 语义检索（对外）：先跑原检索，再把命中文本里的渠道称呼归一。 */
export async function recall(query, topK = 5) {
  const r = await recallRaw(query, topK)
  if (r && Array.isArray(r.hits)) {
    r.hits = r.hits.map((h) => (h && typeof h.text === 'string' ? { ...h, text: softenChannelWords(h.text) } : h))
    // 时间衰减只动排序和分数（外加一个 decay 字段），条数和返回结构不变
    if (DECAY_ON) r.hits = applyDecay(r.hits)
  }
  return r
}

