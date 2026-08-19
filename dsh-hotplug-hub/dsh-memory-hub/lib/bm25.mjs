/**
 * dsh-memory-hub / lib/bm25.mjs — CJK 感知分词 + BM25 召回打分（零依赖）。
 *
 * 迁移自 Reasonix 召回内核的要点：
 *  - QueryTerms 提取同时覆盖中文（CJK 连续段整段成词）与拉丁词（按非字母数字切分）。
 *  - BM25 使用文档频率 + 平均文档长（k1=1.2, b=0.75）。
 *  - project scope 加权（本包无 scope 差异，用 pack 加权替代：pinned 微升、expires 排除）。
 *  - freshness：过期硬排除；volatility/type 窗口内 stale 降权（× staleFactor）。
 *  - strong match 捷径：命中 ≥ strongMatchTerms 直接入选；单 term ≥ strongTermRunes 视为区分。
 *  - KeepTopRelativeScore：仅保留相对最高分 ≥ keepRelativeScore 的候选。
 */
import { DEFAULTS, TYPE_FRESHNESS, VOLATILITIES } from './constants.mjs'
import { isExpired } from './store.mjs'

/** CJK 连续段（含假名/谚文）整段成词。 */
const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/
/** 拉丁/数字词。 */
const LATIN_RE = /[A-Za-z0-9_]+/g
/** 被抑制的热身语（自动召回不浪费上下文，参考 Reasonix genericRecallQuery）。 */
const STOPWORDS = new Set([
  'continue', 'please', 'go', 'on', 'next', 'ok', 'okay', 'yes', 'no',
  '继续', '好的', '好', '是', '否', '下一步', '接着', '嗯', '哦',
])

/**
 * 对文本做 CJK+拉丁混合分词，返回唯一 token 列表。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  /** @type {string[]} */
  const tokens = []
  const seen = new Set()
  let rest = String(text ?? '')
  // 拉丁/数字词
  let match
  const latinRe = new RegExp(LATIN_RE.source, 'g')
  while ((match = latinRe.exec(rest)) !== null) {
    const word = match[0].toLowerCase()
    if (!seen.has(word) && !STOPWORDS.has(word)) {
      seen.add(word)
      tokens.push(word)
    }
  }
  // 去拉丁词后，把剩余中文连续段成词
  const stripped = rest.replace(LATIN_RE, ' ')
  let cjkMatch
  const cjkRe = new RegExp(CJK_RE.source, 'g')
  while ((cjkMatch = cjkRe.exec(stripped)) !== null) {
    const chunk = cjkMatch[0]
    if (!seen.has(chunk) && !STOPWORDS.has(chunk)) {
      seen.add(chunk)
      tokens.push(chunk)
    }
  }
  return tokens
}

/** 查询提取：对 query 分词返回唯一词（同样去掉停止词）。 */
export function queryTerms(query) {
  return tokenize(query)
}

/**
 * 字段加权归一：不同字段对最终分的贡献权重。
 */
const FIELD_WEIGHTS = { title: 3, keywords: 3, description: 2, body: 1 }

/** 把条目的可检索文本装进带权字段映射。 */
function fieldTexts(entry) {
  return {
    title: entry.title ?? '',
    keywords: (entry.keywords ?? []).join(' '),
    description: entry.description ?? '',
    body: entry.body ?? '',
  }
}

/**
 * 单个 token 的 BM25 idf（含平滑）。
 * @param {number} docFreq 含该词的文档数
 * @param {number} totalDocs 总文档数
 */
export function idf(docFreq, totalDocs) {
  return Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5))
}

/** 单文档长度（加权 token 白体）。 */
function docLength(entry) {
  let sum = 0
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    sum += tokenize(fieldTexts(entry)[field]).length * weight
  }
  return Math.max(sum, 1)
}

/** 术语与文档 token 的匹配：等值，或 CJK 术语与整段 token 互为子串（中文整段成词后子段也能命中）。 */
function termMatchesToken(term, token) {
  if (term === token) return true
  const cjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/
  if (!cjk.test(term) || !cjk.test(token)) return false
  return token.includes(term) || term.includes(token)
}

/**
 * 计算 BM25 分数并与召回候选项聚合。
 * @param {import('../types.js').MemoryEntry} entry
 * @param {string[]} terms 查询词
 * @param {{idf: Map<string, number>, avgLen: number}} corpus 语料统计
 * @returns {{score: number, matched: string[]}}
 */
export function scoreEntry(entry, terms, corpus) {
  const fields = fieldTexts(entry)
  const idfMap = corpus.idf
  const avgLen = corpus.avgLen
  const dl = docLength(entry)
  const k1 = 1.2
  const b = 0.75
  let score = 0
  /** @type {string[]} */
  const matched = []
  const termSet = new Set(terms)
  for (const term of termSet) {
    let tf = 0
    for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
      const tokens = tokenize(fields[field])
      tf += tokens.filter((token) => termMatchesToken(term, token)).length * weight
    }
    if (tf > 0) {
      const idfVal = idfMap.get(term) ?? 0
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgLen)))
      score += tfNorm * idfVal
      matched.push(term)
    }
  }
  // pinned/activation 微升；expires 已在外层排除
  if (entry.activation === 'pinned') score += 0.5
  return { score, matched }
}

/**
 * 新鲜的字节级判断：过期硬排除。
 * @param {import('../types.js').MemoryEntry} entry
 * @returns {'fresh'|'stale'|'expired'}
 */
export function freshnessOf(entry) {
  if (isExpired(entry)) return 'expired'
  if (typeof entry.lastVerifiedAt === 'string' && entry.lastVerifiedAt !== '') {
    return 'fresh'
  }
  const ref = Date.parse(entry.updatedAt ?? entry.createdAt) || Date.now()
  const window = freshnessWindow(entry)
  const days = (Date.now() - ref) / 86_400_000
  if (days <= window.fresh) return 'fresh'
  if (days <= window.current) return 'stale'
  return 'stale'
}

function freshnessWindow(entry) {
  if (entry.volatility && VOLATILITIES[entry.volatility]) {
    return { fresh: VOLATILITIES[entry.volatility][0], current: VOLATILITIES[entry.volatility][1] }
  }
  const f = TYPE_FRESHNESS[entry.type] ?? [30, 180]
  return { fresh: f[0], current: f[1] }
}

/**
 * 召回主入口（纯函数）：返回排序后的命中们。
 * @param {Array<{packId: string, entry: import('../types.js').MemoryEntry}>} items
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {number} [opts.maxChars]
 * @param {boolean} [opts.includeExpired]
 * @returns {Array<{item: {packId: string, entry: import('../types.js').MemoryEntry}, score: number, matched: string[], freshness: string, snippet: string}>}
 */
export function recall(items, query, opts = {}) {
  const limit = Math.min(opts.limit ?? DEFAULTS.searchLimit, DEFAULTS.searchLimitMax)
  const maxChars = opts.maxChars ?? DEFAULTS.searchChars
  const includeExpired = opts.includeExpired === true
  const terms = queryTerms(query)
  if (terms.length === 0) return []

  // 语料统计
  const totalDocs = items.length
  /** @type {Map<string, number>} */
  const docFreq = new Map()
  for (const { entry } of items) {
    const seen = new Set()
    for (const field of Object.keys(FIELD_WEIGHTS)) {
      for (const token of tokenize(fieldTexts(entry)[field])) seen.add(token)
    }
    for (const token of seen) docFreq.set(token, (docFreq.get(token) ?? 0) + 1)
  }
  const idfMap = new Map()
  for (const term of terms) idfMap.set(term, idf(docFreq.get(term) ?? 0, totalDocs))
  let lenSum = 0
  for (const { entry } of items) lenSum += docLength(entry)
  const avgLen = Math.max(lenSum / Math.max(totalDocs, 1), 1)
  const corpus = { idf: idfMap, avgLen }

  /** @type {Array<{item, score, matched, freshness, snippet}>} */
  const ranked = []
  for (const item of items) {
    const f = freshnessOf(item.entry)
    if (f === 'expired' && !includeExpired) continue
    const { score, matched } = scoreEntry(item.entry, terms, corpus)
    if (score <= 0 && matched.length === 0) continue
    let effective = score
    if (f === 'stale') effective *= DEFAULTS.staleFactor
    const strong =
      matched.length >= DEFAULTS.strongMatchTerms ||
      matched.some((term) => term.length >= DEFAULTS.strongTermRunes)
    ranked.push({ item, score: effective, matched, freshness: f, snippet: snippet(item.entry, maxChars) })
    if (strong) ranked.at(-1).score += 1 // 强匹配捷径
  }

  // KeepTopRelativeScore：保留相对最高分 ≥ 系数 的候选（截断低分噪声）
  ranked.sort((a, b) => b.score - a.score)
  const top = ranked.length > 0 ? ranked[0].score : 0
  const kept = ranked.filter((row) => top <= 0 || row.score >= top * DEFAULTS.keepRelativeScore)
  return kept.slice(0, limit)
}

/** snippet 构造：description 优先，body 裁到 maxChars 上下文。 */
function snippet(entry, maxChars) {
  let text = entry.description && entry.description !== ''
    ? entry.description
    : String(entry.body ?? '').replace(/\s+/g, ' ').trim()
  if (text.length > maxChars) text = text.slice(0, maxChars) + '…'
  return text
}
