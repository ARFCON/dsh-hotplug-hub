/**
 * dsh-memory-hub / lib/webapi.mjs — /memory-hub/api JSON API（host 桥，零 DSH 依赖）。
 *
 * 纯处理器核心：入参 payload → 返回值（JSON 可序列化）。挂载与 fence 在 index.mjs。
 * 端点：stats / packs / entries / search / proposals / adopt / reject / audit / logs
 * adopt/reject 以「用户」操作者身份落审计（GUI 采纳/驳回视同用户在 /memory review 操作）。
 */
import { NotFoundError, WriteDeniedError } from './errors.mjs'

export function buildMemoryApi(service) {
  const store = service.store
  const clamp = (n, min, max, dflt) => {
    const v = Number(n)
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt
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
        const res = service.search(q, { pack: payload.pack, includeExpired: payload.includeExpired === true })
        const ids = new Set(res.hits.map((h) => h.id))
        list = list.filter((e) => ids.has(e.id))
      }
      return list.slice(0, limit).map((e) => ({
        id: e.id, name: e.name, title: e.title, type: e.type, scope: e.scope,
        activation: e.activation, revision: e.revision, packId: e.packId,
        keywords: e.keywords ?? [], updatedAt: e.updatedAt, expired: e.expiresAt ? Date.parse(e.expiresAt) < Date.now() : false,
      }))
    },

    search(payload = {}) {
      const res = service.search(String(payload.q ?? ''), {
        pack: payload.pack,
        includeExpired: payload.includeExpired === true,
        limit: clamp(payload.limit, 1, 8, 4),
      })
      return { query: res.query, pack: res.pack, hits: res.hits, count: res.count, warning: res.warning }
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
      return { scope, files: store.listLogs(scope), latest: store.readLog(scope).slice(0, 6000) }
    },

    async adopt(payload = {}) {
      if (typeof payload.packId !== 'string' || typeof payload.proposalId !== 'string') {
        throw new NotFoundError('adopt 需要 packId + proposalId')
      }
      const res = await service.adopt(payload.packId, payload.proposalId)
      return { ok: true, proposalId: payload.proposalId, result: res?.result?.id ?? res?.id ?? null }
    },

    reject(payload = {}) {
      if (typeof payload.packId !== 'string' || typeof payload.proposalId !== 'string') {
        throw new NotFoundError('reject 需要 packId + proposalId')
      }
      service.reject(payload.packId, payload.proposalId, typeof payload.reason === 'string' ? payload.reason : 'GUI 驳回')
      return { ok: true, proposalId: payload.proposalId }
    },
  }
}

/** 查询活性（非载重）。 */
export function apiErrors() {
  return { NotFoundError, WriteDeniedError }
}
