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
  volatility: 'evergreen' | 'stable' | 'volatile'
  subjectKey: string
  expiresAt: string | null
  lastVerifiedAt: string | null
  keywords: string[]
  tagged: string[]
  body: string
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
  submit(intent: { action: 'create' | 'update' | 'remove'; packId?: string; entry?: unknown; reason?: string }): Promise<{ approved: boolean; entry?: MemoryEntry; removed?: { id: string; name: string }; proposalId?: string }>
  adopt(packId: string, proposalId: string): Promise<{ adopted: string; result?: unknown }>
  reject(packId: string, proposalId: string, reason?: string): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory?: MemoryHubService
  }
}

export {}
