/**
 * dsh-memory-hub / lib/webapi.mjs — /memory-hub/api JSON API（host 桥，零 DSH 依赖）。
 *
 * 纯处理器核心：入参 payload → 返回值（JSON 可序列化）。挂载与 fence 在 index.mjs。
 * 端点：stats / packs / entries / search / proposals / adopt / reject / audit / logs
 *       / update / forget / restore
 * adopt/reject/update/forget/restore 以「用户」操作者身份落审计（GUI 视同用户在
 * /memory 操作）。GET 查询参数一律是字符串——布尔参数经 toBool 归一（'true'/'1'）。
 */
import { InvalidInputError, NotFoundError } from './errors.mjs'

const LOGS_LATEST_CHARS = 6000

/** GET 查询串布尔归一：'true'/'1' → true，其余 false（POST JSON body 已是布尔）。 */
function toBool(value) {
  return value === true || value === 'true' || value === '1'
}

export function buildMemoryApi(service) {
  const store = service.store
  const clamp = (n, min, max, dflt) => {
    const v = Number(n)
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt
  }
  const needString = (payload, key, what) => {
    if (typeof payload[key] !== 'string' || payload[key] === '') {
      throw new InvalidInputError(`${what} 需要 ${key}（非空字符串）`)
    }
    return payload[key]
  }

  return {
    stats() {
      return {
        hubDir: store.hubDir,
        packs: store.listPacks().length,
        activeEntries: store.allEntries().length,
        pinned: store.allEntries().filter(({ entry }) => entry.activation === 'pinned').length,
        pendingProposals: store.allProposals('pending').length,
        writePolicy: service.config.writePolicy,
        review: service.reviewStatus(),
      }
    },

    packs() {
      return store.listPacks().map((p) => ({
        memoryPackId: p.memoryPackId,
        scope: p.scope,
        keywords: p.keywords ?? [],
        entries: p.entries,
        updatedAt: p.updatedAt,
      }))
    },

    entries(payload = {}) {
      const limit = clamp(payload.limit, 1, 200, 50)
      let list = typeof payload.pack === 'string' && payload.pack !== ''
        ? store.listEntries(payload.pack).map((e) => ({ ...e, packId: payload.pack }))
        : store.allEntries().map(({ packId, entry }) => ({ ...entry, packId }))
      const q = String(payload.q ?? '').trim()
      if (q !== '') {
        const res = service.search(q, { pack: payload.pack, includeExpired: toBool(payload.includeExpired) })
        const ids = new Set(res.hits.map((h) => h.id))
        list = list.filter((e) => ids.has(e.id))
      }
      return list.slice(0, limit).map((e) => ({
        id: e.id, name: e.name, title: e.title, type: e.type, scope: e.scope,
        activation: e.activation, revision: e.revision, packId: e.packId,
        keywords: e.keywords ?? [], body: e.body ?? '', description: e.description ?? '',
        updatedAt: e.updatedAt, expired: e.expiresAt ? Date.parse(e.expiresAt) < Date.now() : false,
      }))
    },

    search(payload = {}) {
      const res = service.search(String(payload.q ?? ''), {
        pack: payload.pack,
        includeExpired: toBool(payload.includeExpired),
        limit: clamp(payload.limit, 1, 8, 4),
      })
      return { query: res.query, pack: res.pack, hits: res.hits, count: res.count, warning: res.warning }
    },

    update(payload = {}) {
      const entry = service.updateDirect(payload)
      return { ok: true, id: entry.id, revision: entry.revision, updatedAt: entry.updatedAt }
    },

    forget(payload = {}) {
      const removed = service.removeDirect(needString(payload, 'id', 'forget'))
      return { ok: true, removed: { id: removed.id, name: removed.name } }
    },

    /** 恢复归档条目（GUI「恢复」/审计回溯用；与 create/update 同一校验面）。 */
    restore(payload = {}) {
      const packId = needString(payload, 'packId', 'restore')
      const name = needString(payload, 'name', 'restore')
      const restored = service.restoreArchived(packId, name)
      return { ok: true, restored: { id: restored.id, name: restored.name, revision: restored.revision } }
    },

    proposals(payload = {}) {
      const status = typeof payload.status === 'string' ? payload.status : 'pending'
      const list = typeof payload.pack === 'string' && payload.pack !== ''
        ? store.listProposals(payload.pack, status)
        : store.allProposals(status)
      return list.slice(0, clamp(payload.limit, 1, 200, 100)).map((p) => ({
        id: p.id, kind: p.kind, packId: p.packId, status: p.status,
        title: p.entry?.title ?? p.entry?.name ?? '', reason: p.reason ?? '',
        createdAt: p.createdAt,
      }))
    },

    audit(payload = {}) {
      const limit = clamp(payload.limit, 1, 500, 50)
      const rows = store.auditList({
        limit,
        filter: typeof payload.entryId === 'string' && payload.entryId !== ''
          ? (r) => r.entryId === payload.entryId
          : undefined,
      })
      return rows.map((r) => ({ at: r.at, action: r.action, packId: r.packId, entryId: r.entryId, operator: r.operator, outcome: r.outcome, via: r.via }))
    },

    logs(payload = {}) {
      const scope = typeof payload.scope === 'string' && payload.scope !== '' ? payload.scope : 'daily'
      const text = store.readLog(scope)
      // 最新日志在文件尾部：取尾段（超长时前缀省略号提示），此前取头部 6000 字符
      // 展示的恰是最旧的行（M6）。
      const latest = text.length > LOGS_LATEST_CHARS ? `…${text.slice(-LOGS_LATEST_CHARS)}` : text
      return { scope, files: store.listLogs(scope), latest }
    },

    async adopt(payload = {}) {
      const packId = needString(payload, 'packId', 'adopt')
      const proposalId = needString(payload, 'proposalId', 'adopt')
      const res = await service.adopt(packId, proposalId)
      return { ok: true, proposalId, result: res?.result?.id ?? null }
    },

    reject(payload = {}) {
      const packId = needString(payload, 'packId', 'reject')
      const proposalId = needString(payload, 'proposalId', 'reject')
      service.reject(packId, proposalId, typeof payload.reason === 'string' ? payload.reason : 'GUI 驳回')
      return { ok: true, proposalId }
    },
  }
}
