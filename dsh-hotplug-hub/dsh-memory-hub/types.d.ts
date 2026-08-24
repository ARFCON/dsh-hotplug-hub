/**
 * dsh-memory-hub — 类型契约（与 lib/provider 声明合并）。
 *
 * 本插件向宿主发布 `ctx.memory` 服务（MemoryHubService，extends MemoryProtocolCore）。
 * 声明合并到 DSH 的 Context，让下游（其它插件/宿主代码）拿到类型。
 * 仅做类型面：MemoryHubService 的运行时实现见 lib/index.mjs。
 */
import type { Context } from '@deepseek-ai/cordis'

export interface MemoryEntry {
  id: string
  revision: number
  createdAt: string
  updatedAt: string
  name: string
  title: string
  description: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  scope: 'global' | 'project'
  activation: 'relevant' | 'pinned'
  /** '' = 未指定（新鲜窗口按 type 取，Spec §7.4）。 */
  volatility: 'evergreen' | 'stable' | 'volatile' | ''
  subjectKey: string
  expiresAt: string | null
  lastVerifiedAt: string | null
  keywords: string[]
  tagged: string[]
  body: string
  /** 仅归档副本携带。 */
  archivedAt?: string
}

export interface MemoryPack {
  memoryPackId: string
  scope: 'global' | 'project'
  schemaVersion: number
  keywords: string[]
  entries: number
  createdAt?: string
  updatedAt?: string
}

export interface MemoryProposal {
  id: string
  packId: string
  status: 'pending' | 'adopted' | 'rejected'
  kind: 'create' | 'update' | 'remove'
  entry: MemoryEntry | null
  reason: string
  createdAt: string
  resolvedAt?: string | null
  result?: unknown
}

export interface SearchHit {
  id: string
  name: string
  packId: string
  title: string
  type: string
  scope: string
  revision: number
  freshness: 'fresh' | 'stale' | 'expired'
  score: number
  matched: string[]
  snippet: string
}

export interface SearchResult {
  query: string
  pack: string
  hits: SearchHit[]
  count: number
  warning: string
}

export interface MemoryHubService {
  search(query: string, opts?: { pack?: string; limit?: number; includeExpired?: boolean }): SearchResult
  commit(payload: { pack?: string; entry: Partial<MemoryEntry>; reason?: string }): Promise<{ approved: boolean; entry?: MemoryEntry; proposalId?: string }>
  suggest(payload: { pack?: string; entry: Partial<MemoryEntry>; reason?: string }): Promise<{ approved: boolean; proposalId?: string }>
  submit(intent: { action: 'create' | 'update' | 'remove'; packId?: string; entry?: unknown; reason?: string; forceQueue?: boolean }): Promise<{ approved: boolean; entry?: MemoryEntry; removed?: { id: string; name: string }; proposalId?: string }>
  /** mode='update' 按 id 严格定位（缺失 NotFound 不复活）；create 同名=合并更新。 */
  applyCreateOrUpdate(packId: string, entry: Partial<MemoryEntry> & { id?: string }, mode?: 'create' | 'update'): MemoryEntry
  applyRemove(packId: string, id: string): { id: string; name: string }
  /** 恢复归档条目（与 create/update 同一校验面：subject 冲突 + pinned 预算）。 */
  restoreArchived(packId: string, name: string): MemoryEntry
  adopt(packId: string, proposalId: string): Promise<{ adopted: string; result?: unknown }>
  reject(packId: string, proposalId: string, reason?: string): { rejected: string }
  /** GUI/用户直接编辑（绕过 ask 提案，操作者=user；面板编辑按钮专用）。 */
  updateDirect(payload: { id: string; title?: string; body?: string; description?: string; keywords?: string[]; type?: 'user' | 'feedback' | 'project' | 'reference' }): MemoryEntry
  /** GUI/用户直接删除（归档 + 移除活跃条目，操作者=user）。 */
  removeDirect(id: string): { id: string; name: string }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory?: MemoryHubService
  }
}

export {}
