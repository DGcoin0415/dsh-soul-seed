/**
 * 顺藤（第二轮检索的种子词）。
 *
 * 思路抄自 SAG2：第一轮找到一条以后，不急着收工 —— 从它的摘要里再抽几个词，
 * 拿这些词再检索一轮，把「同一件事的另外几段」串起来。
 *
 * 只做一件事：从给定文本里挑出「值得再查一轮」的词。不碰检索本身。
 */

const STOP = new Set([
  "怎么", "什么", "在哪", "那个", "一下", "这个", "为啥", "哪里", "多少", "可以", "是不是",
  "我们", "你们", "他们", "自己", "因为", "所以", "但是", "然后", "现在", "已经", "还是",
  "就是", "一个", "没有", "这样", "那样", "时候", "问题", "地方", "东西", "事情",
  // 路径碎词 / 泛词：抽出来当种子只会召回到无关文件
  "program", "files", "users", "windows", "appdata", "microsoft", "node_modules",
  "http", "https", "www", "com", "exe", "bin", "tmp", "local", "roaming", "tencent",
  "目标", "结论", "说明", "使用", "方法", "内容", "文件", "数据", "部分", "下面", "上面"
])

/**
 * @param {string[]} texts  命中的摘要/结论文本
 * @param {string[]} exclude 已经在查询里出现过的词（不重复抽）
 * @param {{max?: number}} opts
 * @returns {string[]}
 */
export function pickSeedTerms(texts, exclude = [], { max = 4 } = {}) {
  const ex = new Set(exclude.map((s) => String(s).toLowerCase()))
  const counts = new Map()

  for (const t of texts) {
    if (!t) continue
    const s = String(t)

    // 英文标识符 / 路径 / 编号：最值得顺藤
    for (const m of s.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || []) {
      const k = m.toLowerCase()
      if (k.length < 3) continue
      if (STOP.has(k)) continue
      // 标识符（带连字符/下划线，或全大写缩写，如 UI、GPT）更值得顺
      const identifier = /[-_]/.test(m) || /^[A-Z]{2,}$/.test(m)
      counts.set(k, (counts.get(k) || 0) + (identifier ? 3 : 1))
    }

    // 中文：四字以内的高信息量片段（跳过停用词）
    for (const m of s.match(/[\u4e00-\u9fa5]{2,6}/g) || []) {
      if (STOP.has(m)) continue
      if (m.length < 2) continue
      counts.set(m, (counts.get(m) || 0) + 2)
    }
  }

  return [...counts.entries()]
    .filter(([k]) => !ex.has(k) && !STOP.has(k))
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, max)
    .map(([k]) => k)
}
