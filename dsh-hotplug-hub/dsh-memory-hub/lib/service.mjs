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
import { STRINGS } from './constants.mjs'

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
      if (terms.some((term) => term.includes(k) || k.includes(term))) score += 1
    }
    if (score > bestScore) {
      bestScore = score
      best = route.packId
    }
  }
  return best
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

  /** 沉淀（writePolicy=auto 直写 / ask 进提案队列）。 */
  commit(payload) {
    const packId = payload.pack ?? this.store.readRoutes().fallbackPackId ?? 'global-pack'
    return this.submit({ action: 'create', packId, entry: payload.entry, reason: payload.reason ?? 'memory.commit' })
  }

  /** 提案（永远进队列，绝不直写）。 */
  suggest(payload) {
    const packId = payload.pack ?? this.store.readRoutes().fallbackPackId ?? 'global-pack'
    return this.submit({ action: 'create', packId, entry: payload.entry, reason: payload.reason ?? 'memory.suggest' })
  }
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
