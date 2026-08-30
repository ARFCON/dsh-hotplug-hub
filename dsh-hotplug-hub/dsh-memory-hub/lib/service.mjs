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
import { InvalidInputError, NotFoundError } from './errors.mjs'

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
    return packResult(expandHits(hits), String(query ?? ''), packId)
  }

  /** 沉淀（writePolicy=auto 直写 / ask 进提案队列）；未指定 pack 时按内容关键词路由。 */
  commit(payload) {
    const packId = payload.pack ?? routePackId(this.store.readRoutes(), packText(payload.entry))
    return this.submit({ action: 'create', packId, entry: payload.entry, reason: payload.reason ?? 'memory.commit' })
  }

  /**
   * 提案（writePolicy=auto 时 AI 自动直写通过；ask 时进提案队列）。
   * forceQueue 在协议层 authorize 于 auto 模式下放行直写。
   */
  suggest(payload) {
    const packId = payload.pack ?? routePackId(this.store.readRoutes(), packText(payload.entry))
    return this.submit({ action: 'create', packId, entry: payload.entry, reason: payload.reason ?? 'memory.suggest', forceQueue: true })
  }
  /** GUI/用户直接编辑（绕过 ask 提案，操作者=user；面板编辑按钮专用）。
   *  走严格 update 模式：按 id 定位、仅覆盖显式字段、目标缺失即 NotFound。 */
  updateDirect(payload) {
    if (typeof payload?.id !== 'string' || payload.id === '') {
      throw new NotFoundError(`条目不存在：${payload?.id}`)
    }
    const found = this.store.findById(payload.id)
    if (found === null) throw new NotFoundError(`条目不存在：${payload.id}`)
    const intent = {}
    if (typeof payload.title === 'string' && payload.title.trim() !== '') intent.title = payload.title.trim().slice(0, 200)
    if (typeof payload.body === 'string') intent.body = payload.body
    if (typeof payload.description === 'string') intent.description = payload.description
    if (Array.isArray(payload.keywords)) intent.keywords = payload.keywords.map((k) => String(k).slice(0, 60))
    if (['user', 'feedback', 'project', 'reference'].includes(payload.type)) intent.type = payload.type
    // GUI 编辑 = 人工核验：lastVerifiedAt 刷新（freshness 快速通道真正可达，bm25 恒 fresh）
    const entry = this.applyCreateOrUpdate(found.packId, { id: found.entry.id, ...intent, lastVerifiedAt: new Date().toISOString() }, 'update')
    this.auditWrite('update', found.packId, entry.id, { outcome: 'allowed', source: 'user', operator: 'user' })
    return entry
  }

  /** GUI/用户直接删除（归档 + 移除活跃条目，操作者=user）。 */
  removeDirect(id) {
    const found = this.store.findById(String(id ?? ''))
    if (found === null) throw new NotFoundError(`条目不存在：${id}`)
    const removed = this.applyRemove(found.packId, found.entry.id)
    this.auditWrite('remove', found.packId, found.entry.id, { outcome: 'allowed', source: 'user' })
    return removed
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

  /**
   * 审查状态：变更计数超阈值（每 memory 写/采纳/拒/归档/恢复）→ due。
   * changeCount 以 review-state.totalChanges 为种子（跨重启连续，H6）；
   * markedTurns 钳制到 ≤ 当前计数（旧版持久化的 markedTurns 高于计数时不再压制 due）。
   * writePolicy 不对模型输出（NFR-2「模型不可见」；GUI 面板经 webapi stats 单独获取）。
   */
  reviewStatus() {
    const interval = Number.isFinite(this.config.reviewEveryTurns) ? this.config.reviewEveryTurns : REVIEW_EVERY_TURNS
    const state = this.store.readReviewState()
    // 新格式不变量：markedTurns ≤ totalChanges（reviewDone 两者同时落盘）。
    // markedTurns > totalChanges（或 totalChanges 缺失=旧格式）⟺ 旧计数纪元的
    // 不可信残留 → 归零重计（宁可提前审查，不可让虚高 markedTurns 压制 due）。
    const marked = (state.markedTurns ?? 0) <= (state.totalChanges ?? -1) ? (state.markedTurns ?? 0) : 0
    const changesSince = this.changeCount - marked
    return {
      due: changesSince >= interval,
      changesSinceReview: Math.max(0, changesSince),
      reviewEveryTurns: interval,
      pendingProposals: this.store.allProposals('pending').length,
      activeEntries: this.store.allEntries().length,
      pinnedCount: this.store.allEntries().filter(({ entry }) => entry.activation === 'pinned').length,
      lastReviewedAt: state.lastReviewedAt,
      reviewHint:
        '若 due：在任务收尾静默执行一次记忆审查——把本轮值得长期记住的事实用 memory.suggest 提案（不要直接 commit 绕过确认）。审查完调用 memory.review_done 记录。',
    }
  }

  /** 标记一次审查已完成（持久化 lastReviewedAt + 当前变更计数，重置到期）。
   *  持写锁：与并发 _postChange 的 review-state 读-改-写互斥（last-write-wins 丢计数）。 */
  reviewDone() {
    this.store.withWriteLock(() => {
      this.store.writeReviewState({ lastReviewedAt: new Date().toISOString(), markedTurns: this.changeCount, totalChanges: this.changeCount })
    })
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

function packResult(hits, query, packId) {
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
