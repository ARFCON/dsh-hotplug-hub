/**
 * dsh-memory-hub / lib/bm25.mjs — CJK 感知分词 + BM25 召回打分（零依赖）。
 *
 * 迁移自 Reasonix 召回内核的要点：
 *  - QueryTerms 提取同时覆盖中文（CJK 连续段整段成词）与拉丁词（按非字母数字切分）。
 *  - BM25 使用文档频率 + 平均文档长（k1=1.2, b=0.75）；df 与 tf 同源
 *    （同一 termMatchesToken 匹配口径）——子串命中不再拿「精确 df=0」的最大 idf。
 *  - project scope 加权（本包无 scope 差异，用 pack 加权替代：pinned 微升、expires 排除）。
 *  - freshness：过期硬排除；volatility/type 窗口内 stale 降权（× staleFactor）。
 *  - strong match 捷径：命中 ≥ strongMatchTerms 直接入选；单 term ≥ strongTermRunes 视为区分。
 *  - KeepTopRelativeScore：仅保留相对最高分 ≥ keepRelativeScore 的候选。
 *  - 字符预算（Spec §7.5）：单条 snippet ≤ snippetChars（码点安全）；命中集总预算 ≤ searchChars。
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
  const rest = String(text ?? '')
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

/** 预分词文档（df/tf 同源：同一 termMatchesToken 口径）。 */
function tokenizeFields(entry) {
  const fields = fieldTexts(entry)
  return {
    title: tokenize(fields.title),
    keywords: tokenize(fields.keywords),
    description: tokenize(fields.description),
    body: tokenize(fields.body),
  }
}

/**
 * 单个 token 的 BM25 idf（含平滑）。
 * @param {number} docFreq 含该词的文档数（按 tf 同一口径统计）
 * @param {number} totalDocs 总文档数
 */
export function idf(docFreq, totalDocs) {
  return Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5))
}

/** 单文档长度（加权 token 数）。 */
function docLengthFromTokens(tokens) {
  let sum = 0
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    sum += tokens[field].length * weight
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

/** 加权词频：Σ 字段权重 × 该字段命中 token 数。 */
function termFreq(tokens, term) {
  let tf = 0
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    tf += tokens[field].filter((token) => termMatchesToken(term, token)).length * weight
  }
  return tf
}

/**
 * 计算 BM25 分数并与召回候选项聚合。
 * @param {import('../types.js').MemoryEntry} entry
 * @param {string[]} terms 查询词
 * @param {{idf: Map<string, number>, avgLen: number}} corpus 语料统计
 * @param {{title: string[], keywords: string[], description: string[], body: string[]}} [preTokens] 预分词（缺省现算）
 * @returns {{score: number, matched: string[]}}
 */
export function scoreEntry(entry, terms, corpus, preTokens) {
  const tokens = preTokens ?? tokenizeFields(entry)
  const idfMap = corpus.idf
  const avgLen = corpus.avgLen
  const dl = docLengthFromTokens(tokens)
  const k1 = 1.2
  const b = 0.75
  let score = 0
  /** @type {string[]} */
  const matched = []
  const termSet = new Set(terms)
  for (const term of termSet) {
    const tf = termFreq(tokens, term)
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
  const ref = Date.parse(entry.updatedAt ?? '') || Date.parse(entry.createdAt ?? '') || Date.now()
  const window = freshnessWindow(entry)
  const days = (Date.now() - ref) / 86_400_000
  if (days <= window.fresh) return 'fresh'
  if (days <= window.current) return 'stale'
  // 超出 current 窗口：三档模型（fresh/stale/expired）里的过期档——recall 硬排除。
  return 'expired'
}

function freshnessWindow(entry) {
  if (entry.volatility && VOLATILITIES[entry.volatility]) {
    return { fresh: VOLATILITIES[entry.volatility][0], current: VOLATILITIES[entry.volatility][1] }
  }
  // volatility 缺省（''）→ 按 type 取窗口（Spec §7.4「volatility 缺省时按 type 取」）
  const f = TYPE_FRESHNESS[entry.type] ?? [30, 180]
  return { fresh: f[0], current: f[1] }
}

/**
 * 按 UTF-16 code unit 截断但绝不在代理对中间切断（emoji/astral 字符不产生孤立代理）。
 */
export function truncateCodePoints(s, max) {
  if (s.length <= max) return s
  let i = max
  if (i > 0) {
    const c = s.charCodeAt(i - 1)
    if (c >= 0xd800 && c <= 0xdbff) i -= 1
  }
  return s.slice(0, i)
}

/**
 * 召回主入口（纯函数）：返回排序后的命中们。
 * @param {Array<{packId: string, entry: import('../types.js').MemoryEntry}>} items
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {number} [opts.maxChars] 命中集总字符预算（默认 searchChars）
 * @param {boolean} [opts.includeExpired]
 * @returns {Array<{item: {packId: string, entry: import('../types.js').MemoryEntry}, score: number, matched: string[], freshness: string, snippet: string}>}
 */
export function recall(items, query, opts = {}) {
  const limit = Math.min(opts.limit ?? DEFAULTS.searchLimit, DEFAULTS.searchLimitMax)
  const maxChars = opts.maxChars ?? DEFAULTS.searchChars
  const includeExpired = opts.includeExpired === true
  const terms = queryTerms(query)
  if (terms.length === 0) return []

  // 语料统计（df/tf 同源：均按 termMatchesToken 口径统计，预分词只算一次）
  const docs = items.map((item) => {
    const tokens = tokenizeFields(item.entry)
    return { item, tokens }
  })
  const totalDocs = docs.length
  /** @type {Map<string, number>} */
  const docFreq = new Map()
  for (const term of terms) {
    let df = 0
    for (const doc of docs) {
      if (termFreq(doc.tokens, term) > 0) df += 1
    }
    docFreq.set(term, df)
  }
  const idfMap = new Map()
  for (const term of terms) idfMap.set(term, idf(docFreq.get(term) ?? 0, totalDocs))
  let lenSum = 0
  for (const doc of docs) lenSum += docLengthFromTokens(doc.tokens)
  const avgLen = Math.max(lenSum / Math.max(totalDocs, 1), 1)
  const corpus = { idf: idfMap, avgLen }

  /** @type {Array<{item, score, matched, freshness, snippet}>} */
  const ranked = []
  for (const doc of docs) {
    const f = freshnessOf(doc.item.entry)
    if (f === 'expired' && !includeExpired) continue
    const { score, matched } = scoreEntry(doc.item.entry, terms, corpus, doc.tokens)
    if (score <= 0 && matched.length === 0) continue
    let effective = score
    if (f === 'stale') effective *= DEFAULTS.staleFactor
    const strong =
      matched.length >= DEFAULTS.strongMatchTerms ||
      matched.some((term) => term.length >= DEFAULTS.strongTermRunes)
    ranked.push({ item: doc.item, score: effective, matched, freshness: f, snippet: snippet(doc.item.entry) })
    if (strong) ranked.at(-1).score += 1 // 强匹配捷径
  }

  // KeepTopRelativeScore：保留相对最高分 ≥ 系数 的候选（截断低分噪声）
  ranked.sort((a, b) => b.score - a.score)
  const top = ranked.length > 0 ? ranked[0].score : 0
  const kept = ranked.filter((row) => top <= 0 || row.score >= top * DEFAULTS.keepRelativeScore)
  return applyCharBudget(kept.slice(0, limit), maxChars)
}

/**
 * 字符预算（Spec §7.5）：单条 snippet ≤ snippetChars（构造时已裁）；命中集
 * 总量 ≤ maxChars——开销按 expandHits 实际输出的全字段估算（title/name/id/
 * matched/固定元数据），超出部分从低分尾部丢弃，首条命中独超预算时裁其
 * snippet（保条目在场，绝不静默丢光）。
 */
function applyCharBudget(hits, maxChars) {
  /** @type {typeof hits} */
  const out = []
  let used = 0
  for (const hit of hits) {
    const entry = hit.item.entry
    const matchedLen = (hit.matched ?? []).join('').length
    const overhead = String(entry.title ?? '').length + String(entry.name ?? '').length
      + 20 /* id: mem-<16hex> */ + 32 /* type/scope/revision/freshness/score/标点 */ + matchedLen + 16 /* matched 数组括号/逗号 */
    const room = maxChars - used - overhead
    if (room <= 0) {
      if (out.length === 0) {
        out.push({ ...hit, snippet: truncateCodePoints(hit.snippet, Math.max(0, maxChars - overhead)) })
      }
      break
    }
    const clipped = hit.snippet.length > room ? { ...hit, snippet: truncateCodePoints(hit.snippet, room) } : hit
    out.push(clipped)
    used += overhead + clipped.snippet.length
  }
  return out
}

/** snippet 构造：description 优先，body 归一空白后裁到 snippetChars（含省略号、码点安全）。 */
function snippet(entry) {
  let text = entry.description && entry.description !== ''
    ? entry.description
    : String(entry.body ?? '').replace(/\s+/g, ' ').trim()
  if (text.length > DEFAULTS.snippetChars) text = truncateCodePoints(text, DEFAULTS.snippetChars - 1) + '…'
  return text
}
