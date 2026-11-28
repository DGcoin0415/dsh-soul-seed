/**
 * dsh-notify · 每日新闻
 *
 * 没有现成新闻脚本，直接取公开源（本机实测可达）：
 *   要闻：IT之家 RSS、Solidot RSS、少数派 RSS
 *   AI/DeepSeek：GitHub deepseek-ai 仓库 releases、Hacker News(Algolia) 搜 DeepSeek / AI、
 *                再从上面三个中文源里挑含 DeepSeek/AI/大模型 的条目
 *
 * 每天 newsAt（默认 08:30）推一次：当天要闻 3–5 条 + AI 那节至少 3 条，每条一句话。
 * 正文不带链接（2026-11-27 master 定），链接另存 state/last-news.json，要的时候再给。
 */
import fs from 'node:fs'
import path from 'node:path'
import { clip } from './util.mjs'
import { workspaceDir } from './config.mjs'

const TIMEOUT = 12_000

const GENERAL_FEEDS = [
  'https://www.ithome.com/rss/',
  'https://www.solidot.org/index.rss',
  'https://sspai.com/feed',
]

/** AI 专门源（中文优先，DeepSeek 报道多） */
const AI_FEEDS = [
  'https://www.qbitai.com/feed',
  'https://the-decoder.com/feed/',
]

/** 综合源里挑含 AI 的 */
const AI_MIXED_FEEDS = ['https://techcrunch.com/feed/', 'https://arstechnica.com/feed/']

const AI_KEYWORDS = [
  'deepseek',
  'deep seek',
  'dsh',
  'deepseek harness',
  'harness',
  '大模型',
  '模型',
  'openai',
  'anthropic',
  'claude',
  'gpt',
  'gemini',
  'llm',
  'aigc',
  '人工智能',
  'ai ',
  'ai，',
  'ai。',
  '智能体',
  'agent',
]

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** 正文取纯文本：先剥标签，再解实体，再剥一次（防转义过的标签残留）。 */
function textOf(s) {
  return stripTags(decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')))
}

function pick(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  const m = re.exec(block)
  return m ? m[1] : ''
}

/** 解析 RSS 2.0 / Atom。 */
export function parseFeed(xml) {
  const text = String(xml || '')
  const blocks = text.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || []
  const out = []
  for (const b of blocks) {
    const title = stripTags(pick(b, 'title'))
    if (!title) continue
    let link = stripTags(pick(b, 'link'))
    if (!link) {
      const m = /<link[^>]*href="([^"]+)"/i.exec(b)
      if (m) link = m[1]
    }
    const summary = stripTags(pick(b, 'description') || pick(b, 'summary') || pick(b, 'content'))
    const date = stripTags(pick(b, 'pubDate') || pick(b, 'updated') || pick(b, 'published') || pick(b, 'dc:date'))
    out.push({ title, link, summary, date })
  }
  return out
}

async function getText(url, accept = '*/*') {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 dsh-notify', Accept: accept },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.text()
}

async function getJson(url) {
  const text = await getText(url, 'application/json')
  return JSON.parse(text)
}

function isAi(text) {
  const s = String(text || '').toLowerCase()
  return AI_KEYWORDS.some((k) => s.includes(k))
}

function isDeepSeek(text) {
  const s = String(text || '').toLowerCase()
  return s.includes('deepseek') || s.includes('dsh') || s.includes('深度求索')
}

/** 一句话说明：摘要和标题一样就别重复（返回空）。 */
function oneLiner(item, n = 60) {
  const s = textOf(item.summary || '')
  const title = textOf(item.title || '')
  if (!s) return ''
  const clean = s.replace(/^IT之家\s*\d+\s*月\s*\d+\s*日消息[，,]?\s*/, '').trim()
  if (!clean || clean === title || title.startsWith(clean) || clean.startsWith(title)) return ''
  return clip(clean, n)
}

/** 明显是广告/钓鱼的条目别推。 */
const SPAM_RE = /no card|no limits|uncensored|free .{0,24}(api|credit|key)|crack(ed)?\b|test bank|优惠码/i

function looksSpam(item) {
  const s = `${item.title || ''} ${item.link || ''}`
  if (SPAM_RE.test(s)) return true
  if (/demonroute|\.top(\/|$)|\.xyz(\/|$)/i.test(String(item.link || ''))) return true
  return false
}

async function loadGeneral() {
  const rows = []
  const feeds = await Promise.all(
    GENERAL_FEEDS.map(async (feed) => {
      try {
        const xml = await getText(feed)
        return parseFeed(xml).slice(0, 8).map((it) => ({ ...it, feed }))
      } catch {
        return []
      }
    }),
  )
  // 各源先各取 2 条再轮转，别让一个源把版面占满
  for (let i = 0; i < 8; i++) {
    for (const list of feeds) {
      if (list[i]) rows.push(list[i])
    }
  }
  return rows
}

async function loadAi() {
  const rows = []
  const since = Math.floor((Date.now() - 5 * 24 * 3600_000) / 1000)
  // 0) AI 专门源 + 综合源里含 AI 的
  const feedRows = await Promise.all(
    AI_FEEDS.map(async (feed) => {
      try {
        const xml = await getText(feed)
        return parseFeed(xml).slice(0, 8).map((it) => ({ ...it, feed, ai: true }))
      } catch {
        return []
      }
    }),
  )
  for (const list of feedRows) rows.push(...list)
  const mixed = await Promise.all(
    AI_MIXED_FEEDS.map(async (feed) => {
      try {
        const xml = await getText(feed)
        return parseFeed(xml)
          .filter((it) => isAi(it.title))
          .slice(0, 5)
          .map((it) => ({ ...it, feed, ai: true }))
      } catch {
        return []
      }
    }),
  )
  for (const list of mixed) rows.push(...list)
  // 1) DeepSeek 官方仓库 releases（近 14 天的才算新）
  for (const repo of ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'deepseek-ai/DeepSeek-Prover-V2']) {
    try {
      const list = await getJson(`https://api.github.com/repos/${repo}/releases?per_page=3`)
      for (const r of Array.isArray(list) ? list.slice(0, 2) : []) {
        const at = Date.parse(r.published_at || '')
        if (!Number.isFinite(at) || Date.now() - at > 14 * 24 * 3600_000) continue
        rows.push({
          title: `${repo.split('/')[1]} 新发版 ${r.tag_name || ''}`.trim(),
          link: r.html_url || '',
          summary: textOf(String(r.body || r.name || '').split('\n').filter(Boolean).slice(0, 2).join(' ')),
          date: r.published_at || '',
          feed: 'github',
          ai: true,
        })
      }
    } catch {}
  }
  // 2) Hacker News 近 5 天关于 DeepSeek / AI 的帖子（按时间倒序，别拿老热门）
  for (const q of ['DeepSeek', 'DeepSeek Harness', 'AI model', 'LLM']) {
    try {
      const data = await getJson(
        `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=5&numericFilters=created_at_i>${since}`,
      )
      for (const h of Array.isArray(data?.hits) ? data.hits.slice(0, 3) : []) {
        if (!h?.title) continue
        if (Number(h.points) < 5) continue
        rows.push({
          title: h.title,
          link: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          summary: `HN 热帖 · ${h.points || 0} 分 · ${h.num_comments || 0} 条评论`,
          date: h.created_at || '',
          feed: 'hn',
          ai: true,
        })
      }
    } catch {}
  }
  return rows
}

/**
 * 组一份当天新闻。
 * @returns {Promise<{text:string, general:number, ai:number, ok:boolean, errors:string[]}>}
 */
export async function buildDailyNews({ day, maxGeneral = 5, maxAi = 5, budget = 600 } = {}) {
  const errors = []
  const [generalRows, aiRows] = await Promise.all([
    loadGeneral().catch((e) => {
      errors.push(`要闻源失败：${e?.message || e}`)
      return []
    }),
    loadAi().catch((e) => {
      errors.push(`AI 源失败：${e?.message || e}`)
      return []
    }),
  ])

  // 去重（同标题/同链接只留一条）
  const seen = new Set()
  const uniq = (rows) =>
    rows.filter((r) => {
      const k = (r.link || r.title || '').replace(/[?#].*$/, '')
      if (!k || seen.has(k)) return false
      seen.add(k)
      return true
    })

  const allGeneral = uniq(generalRows).filter((r) => !looksSpam(r))
  // 中文源里算 AI 的：标题里就提到 AI/DeepSeek 才算（只看摘要容易误抓）
  const fromGeneralAi = allGeneral.filter((r) => isDeepSeek(r.title) || isAi(r.title))
  const plainGeneral = allGeneral.filter((r) => !(isDeepSeek(r.title) || isAi(r.title)))

  const general = plainGeneral.slice(0, maxGeneral)
  // AI 那节：DeepSeek/DSH 优先 → 中文源 → 英文源，读起来顺
  const aiUniq = uniq(aiRows).filter((r) => !looksSpam(r))
  const aiDs = aiUniq.filter((r) => isDeepSeek(`${r.title} ${r.summary}`))
  const aiRest = aiUniq.filter((r) => !isDeepSeek(`${r.title} ${r.summary}`))
  const cnRe = /qbitai|sspai|ithome|solidot|量子位|少数派|IT之家/i
  const aiPool = [
    ...aiDs,
    ...aiRest.filter((r) => cnRe.test(`${r.link} ${siteOf(r)}`)),
    ...aiRest.filter((r) => !cnRe.test(`${r.link} ${siteOf(r)}`)),
    ...fromGeneralAi.filter((r) => isDeepSeek(`${r.title} ${r.summary}`)),
    ...fromGeneralAi.filter((r) => !isDeepSeek(`${r.title} ${r.summary}`)),
  ]
  const aiSeen = new Set()
  const ai = aiPool
    .filter((r) => {
      const k = (r.link || r.title || '').replace(/[?#].*$/, '')
      if (!k || aiSeen.has(k)) return false
      aiSeen.add(k)
      return true
    })
    .slice(0, maxAi)

  const rendered = renderNews({ day, general, ai, budget })
  // 链接不进正文，单独存一份，master 要的时候直接翻
  const links = rendered.links || []
  if (links.length) {
    try {
      const dir = path.join(workspaceDir(), 'state')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'last-news.json'),
        JSON.stringify({ day, at: new Date().toISOString(), links }, null, 2),
        'utf8',
      )
    } catch {
      /* 存不下不影响推送 */
    }
  }
  return {
    text: rendered.text,
    general: rendered.generalCount,
    ai: rendered.aiCount,
    ok: general.length >= 1 || ai.length >= 1,
    errors,
    chars: rendered.text.length,
    links,
  }
}

// ---------------------------------------------------------------- 排版
/** 站点名 */
const SITE_MAP = [
  [/ithome\.com/i, 'IT之家'],
  [/solidot\.org/i, 'Solidot'],
  [/sspai\.com/i, '少数派'],
  [/qbitai\.com/i, '量子位'],
  [/the-decoder\.com/i, 'The Decoder'],
  [/techcrunch\.com/i, 'TechCrunch'],
  [/arstechnica\.com/i, 'Ars'],
  [/github\.com/i, 'GitHub'],
  [/ycombinator\.com|hn\.algolia/i, 'HN'],
]

function siteOf(item) {
  const s = `${item.link || ''} ${item.feed || ''}`
  for (const [re, name] of SITE_MAP) if (re.test(s)) return name
  try {
    return new URL(item.link).hostname.replace(/^www\./, '')
  } catch {
    return '网络'
  }
}

/** 标题：清尾巴、去重复、超 30 字截断。 */
const TITLE_TAIL_RE = [
  /\s*[（(]?(?:查看|阅读)全文[)）]?\s*$/g,
  /\s*[-—–|]\s*(?:IT之家|少数派|量子位|Solidot)\s*$/g,
  /\s*消息源\s*@[\w.-]+\s*/g,
  /\s*点击(?:查看|阅读)\s*/g,
  /\s*原文链接\s*/g,
]

function cleanTitle(item) {
  let t = textOf(item.title || '')
  for (const re of TITLE_TAIL_RE) t = t.replace(re, '')
  t = t.replace(/\s+/g, ' ').trim()
  if (t.length > 30) t = t.slice(0, 30).replace(/[，,、：:；;（(]$/, '') + '…'
  return t
}

/** 一句人话说明：砍掉导语套话、只留第一句、超 22 字截断。 */
const DESC_JUNK_RE = [
  /^IT之家\s*\d+\s*月\s*\d+\s*日消息[，,]?\s*/,
  /^据\s*[\w\u4e00-\u9fa5]{1,12}\s*报道[，,]?\s*/,
  /\s*(?:查看|阅读)全文\s*/g,
  /\s*消息源\s*@[\w.-]+\s*/g,
  /\s*(?:责任编辑|编辑|校对|来源|图源|作者)\s*[:：]\s*\S*\s*/g,
  /\s*[-—–]{2,}\s*/g,
]

function cleanDesc(item, n = 22) {
  let s = textOf(item.summary || '')
  for (const re of DESC_JUNK_RE) s = s.replace(re, '')
  s = s.replace(/\s+/g, ' ').trim()
  if (!s) return ''
  const cut = s.split(/[。！？!?]/)[0].trim()
  s = cut || s
  const title = cleanTitle(item)
  if (!s || s === title || title.startsWith(s)) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}

/**
 * 排版：每条独占一行、以「• 」开头；链接统一放最后的「链接」块。
 * 整条控制在 budget（默认 600）字以内，超了就砍条数，最少 3+3。
 */
export function renderNews({ day, general = [], ai = [], budget = 600 } = {}) {
  /** 链接长的排后面（只在超预算时当备选版面用，不改变主顺序）。 */
  const shortFirst = (list) => {
    const ds = [], rest = []
    for (const r of list) (isDeepSeek(`${r.title} ${r.summary}`) ? ds : rest).push(r)
    const byLen = (a, b) => (a.link?.length || 0) - (b.link?.length || 0)
    return [...ds, ...rest.sort(byLen)]
  }
  /** 超长链接（>80 字）往后挪，省版面。 */
  const noLongLink = (list) =>
    [...list].sort((x, y) => Number((x.link?.length || 0) > 80) - Number((y.link?.length || 0) > 80))

  const variants = [
    { g: general, a: ai },
    { g: shortFirst(general), a: shortFirst(ai) },
    { g: noLongLink(shortFirst(general)), a: noLongLink(shortFirst(ai)) },
  ]

  const build = ({ gList, aList, gCount, aCount, desc }) => {
    const gs = gList.slice(0, gCount)
    const as = aList.slice(0, aCount)
    const items = [...gs, ...as]
    const lines = [`【今日新闻 · ${day}】`, '', '要闻']
    const row = (r, idx) => {
      const title = cleanTitle(r)
      const d = desc ? cleanDesc(r) : ''
      const site = siteOf(r)
      lines.push(`• ${idx + 1} ${title}${d ? `｜${d}` : ''}｜${site}`)
    }
    gs.forEach((r, i) => row(r, i))
    lines.push('', 'AI · DeepSeek · DSH')
    as.forEach((r, i) => row(r, gs.length + i))
    if (!as.some((r) => isDeepSeek(`${r.title} ${r.summary}`))) {
      lines.push('（今天没看到 DeepSeek / DSH 的新消息）')
    }
    // 正文不排链接（2026-11-27 master 定）：要的时候另给，链接随结果带出去存一份
    return {
      text: lines.join('\n').trim(),
      generalCount: gs.length,
      aiCount: as.length,
      links: items.map((r, i) => ({ n: i + 1, title: cleanTitle(r), link: r.link || '' })),
    }
  }

  let best = null
  for (const desc of [true, false]) {
    for (const v of variants) {
      const minG = Math.min(3, v.g.length)
      const minA = Math.min(3, v.a.length)
      for (let g = Math.min(v.g.length, 5); g >= minG; g--) {
        for (let a = Math.min(v.a.length, 5); a >= minA; a--) {
          const out = build({ gList: v.g, aList: v.a, gCount: g, aCount: a, desc })
          if (!best || out.text.length < best.text.length) best = out
          if (out.text.length <= budget) return out
        }
      }
    }
  }
  return best
}
