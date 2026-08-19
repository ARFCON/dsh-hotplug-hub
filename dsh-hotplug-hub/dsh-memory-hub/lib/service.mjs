/**
 * dsh-memory-hub / lib/service.mjs — 记忆中枢服务（零 DSH 依赖，可单测）。
 *
 * MemoryHubService 继承 MemoryProtocolCore，补齐：
 *  - search()：关键词路由 → BM25 召回
 *  - commit() / suggest()：写意图 → 门 → 直写或提案
 * lib/ 内其它模块零 DSH 依赖；本模块只 import 同层模块。
 */
import { MemoryProtocolCore } from './protocol.mjs'
import { recall, queryTerms } from './bm25.mjs'
import { STRINGS, DEFAULTS, REVIEW_EVERY_TURNS } from './constants.mjs'
import { InvalidInputError } from './errors.mjs'

const ROUTE_KW_MAX = 128

/** 关键词路由：query 分词后与各路由关键词做包含关系匹配，取分最高包。 */
export function routePackId(routes, query) {
  const terms = queryTerms(String(query ?? ''))
  if (terms.length === 0) return routes.fallbackPackId ?? 'global-pack'
  let best = routes.fallbackPackId ?? 'global-pack'
  let bestScore = 0
  for (const route of (routes.routes ?? []).slice(0, ROUTE_KW_MAX)) {
    let score = 0
    for (const kw of route.keywords ?? []) {
      const k = String(kw).trim().toLowerCase()
      if (k === '') continue
      if (terms.some((term) => keywordMatch(term, k))) score += 1
    }
    if (score > bestScore) {
      bestScore = score
      best = route.packId
    }
  }
  return best
}

/**
 * 关键词单边匹配：两端长度都 ≥2 才有包含关系（防单字母 'b' 误命中 'build'）。
 * CJK 短语按子串包含匹配（'构建' 命中含它的长句）；拉丁词同样按包含。
 */
function keywordMatch(term, keyword) {
  const left = term.length
  const right = keyword.length
  if (left < 2 || right < 2) return false
  return term.includes(keyword) || keyword.includes(term)
}

export class MemoryHubService extends MemoryProtocolCore {
  /** 检索：限定包或关键词路由；BM25 + 新鲜度过滤 + 不可信声明。 */
  search(query, opts = {}) {
    const routes = this.store.readRoutes()
    const items = this.store.allEntries()
    const explicitPack = typeof opts.pack === 'string' && opts.pack !== ''
    const packId = explicitPack ? opts.pack : routePackId(routes, query)
    if (explicitPack && !this.store.hasPack(packId)) {
      return packResult([], String(query ?? ''), packId, [])
    }
    const scoped = packId ? items.filter((item) => item.packId === packId) : items
    const hits = recall(scoped, String(query ?? ''), {
      limit: opts.limit ?? this.config.searchLimit,
      includeExpired: opts.includeExpired === true,
    })
    return packResult(expandHits(hits), String(query ?? ''), packId, hits.map((hit) => hit.item))
  }

  /** 沉淀（writePolicy=auto 直写 / ask 进提案队列）；未指定 pack 时按内容关键词路由。 */
  commit(payload) {
    const packId = payload.pack ?? routePackId(this.store.readRoutes(), packText(payload.entry))
    return this.submit({ action: 'create', packId, entry: payload.entry, reason: payload.reason ?? 'memory.commit' })
  }

  /** 提案（永远进队列，绝不直写）；未指定 pack 时按内容关键词路由。 */
  suggest(payload) {
    const packId = payload.pack ?? routePackId(this.store.readRoutes(), packText(payload.entry))
    return this.submit({ action: 'create', packId, entry: payload.entry, reason: payload.reason ?? 'memory.suggest' })
  }

  // ----- L3 日志轨（M3：不注入、按需读取，project/daily 高频内容）-----

  /**
   * 追加一条日志（project/daily 高频轨，不进条目、不注入前缀）。
   * @param {{scope?: string, text: string}} payload
   */
  log(payload) {
    const text = String(payload?.text ?? '').trim()
    if (text === '') throw new InvalidInputError('log 必须带 text 正文')
    return this.store.appendLog(payload?.scope ?? 'daily', text)
  }

  /** 读取某 scope 的日志（latest 优先；date 可选 YYYY-MM-DD）。 */
  readLog(payload = {}) {
    return this.store.readLog(payload?.scope ?? 'daily', payload?.date)
  }

  listLogs(payload = {}) {
    return this.store.listLogs(payload?.scope ?? 'daily')
  }

  // ----- 回合内自我审查（M3 方案 B：每 N 次变更后提醒沉淀审查）-----

  /** 审查状态：变更计数超阈值（每 memory 写/采纳/拒/归档/恢复）→ due。 */
  reviewStatus() {
    const interval = Number.isFinite(this.config.reviewEveryTurns) ? this.config.reviewEveryTurns : REVIEW_EVERY_TURNS
    const state = this.store.readReviewState()
    const changesSince = this.changeCount - (state.markedTurns ?? 0)
    return {
      due: changesSince >= interval,
      changesSinceReview: Math.max(0, changesSince),
      reviewEveryTurns: interval,
      pendingProposals: this.store.allProposals('pending').length,
      activeEntries: this.store.allEntries().length,
      pinnedCount: this.store.allEntries().filter(({ entry }) => entry.activation === 'pinned').length,
      lastReviewedAt: state.lastReviewedAt,
      writePolicy: this.config.writePolicy,
      reviewHint:
        '若 due：在任务收尾静默执行一次记忆审查——把本轮值得长期记住的事实用 memory.suggest 提案（不要直接 commit 绕过确认）。审查完调用 memory.review_done 记录。',
    }
  }

  /** 标记一次审查已完成（持久化 lastReviewedAt + 当前变更计数，重置到期）。 */
  reviewDone() {
    this.store.writeReviewState({ lastReviewedAt: new Date().toISOString(), markedTurns: this.changeCount })
    return { reviewedAt: new Date().toISOString(), changesSinceReview: 0 }
  }
}

/** 条目内容拼成路由查询文本（title+description+body+keywords）。 */
function packText(entry) {
  if (entry === null || typeof entry !== 'object') return ''
  return [
    entry.title, entry.description, entry.body,
    Array.isArray(entry.keywords) ? entry.keywords.join(' ') : '',
  ].filter((item) => typeof item === 'string').join(' ')
}

function packResult(hits, query, packId, sourceItems) {
  return {
    query: String(query),
    pack: packId,
    hits,
    count: hits.length,
    warning: STRINGS.untrustedWarning,
  }
}

function expandHits(hits) {
  return hits.map((hit) => ({
    id: hit.item.entry.id,
    name: hit.item.entry.name,
    packId: hit.item.packId,
    title: hit.item.entry.title,
    type: hit.item.entry.type,
    scope: hit.item.entry.scope,
    revision: hit.item.entry.revision,
    freshness: hit.freshness,
    score: Math.round((hit.score ?? 0) * 100) / 100,
    matched: hit.matched,
    snippet: hit.snippet,
  }))
}
