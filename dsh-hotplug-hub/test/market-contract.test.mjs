// test/market-contract.test.mjs — 市场参数与条目契约第二轮审计
// （topic 空串语义 / sources 去重 / name 兜底 / 竞速 timer 卫生）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  sanitizeMarketParams, apiSearchUrls, searchMarketRepos, marketListAsync, metaEntry,
} from '../lib/core/market.js'
import { MARKET_MAX_PAGE, MARKET_PAGE_SIZE } from '../lib/core/paths.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null
let savedFetch = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
  savedFetch = globalThis.fetch
})
afterEach(() => {
  globalThis.fetch = savedFetch
  if (restoreEnv) restoreEnv()
  if (iso) iso.cleanup()
})

describe('sanitizeMarketParams：topic 空串语义（审计：空串报错 vs undefined 默认，行为不一致）', () => {
  it('topic 为空串 / 空白 → 回落默认 dsh-plugin（与 undefined 一致）', () => {
    for (const topic of ['', '   ', '\t']) {
      const r = sanitizeMarketParams({ topic })
      expect(r.ok, JSON.stringify(topic)).toBe(true)
      expect(r.topic).toBe('dsh-plugin')
    }
  })

  it('topic 非法（超长/非法字符/超 4 个）→ 仍明确报错（不静默回退）', () => {
    expect(sanitizeMarketParams({ topic: 'x'.repeat(40) }).ok).toBe(false)
    expect(sanitizeMarketParams({ topic: 'a$b' }).ok).toBe(false)
    expect(sanitizeMarketParams({ topic: 'a b c d e' }).ok).toBe(false)
  })

  it('marketListAsync：空 topic 不再报错，按默认标签搜索', async () => {
    globalThis.fetch = async (u) => {
      if (String(u).includes('search/repositories')) {
        // 空串 topic 修复后应搜默认标签
        expect(String(u)).toContain('topic%3Adsh-plugin')
        return { ok: true, status: 200, text: async () => JSON.stringify({ total_count: 0, items: [] }) }
      }
      return { ok: false, status: 404, text: async () => '' }
    }
    const r = await marketListAsync({ topic: '', sources: ['github'] })
    expect(r.ok).toBe(true)
    expect(r.entries).toHaveLength(0)
    expect(r.hasMore).toBe(false)
  })
})

describe('sanitizeMarketParams：sources 去重（审计：重复来源产生重复候选 URL）', () => {
  it('重复来源被去重（顺序保持，github 在前）', () => {
    const r = sanitizeMarketParams({ sources: ['github', 'ghfast.top', 'github', 'ghfast.top', 'ghfast.top'] })
    expect(r.sources).toEqual(['github', 'ghfast.top'])
  })

  it('apiSearchUrls：去重后候选 URL 无重复', () => {
    const urls = apiSearchUrls('dsh-plugin', '', 1, ['github', 'ghfast.top', 'github'])
    expect(new Set(urls).size).toBe(urls.length)
    expect(urls.length).toBe(2)
  })

  it('未知来源被忽略；全未知 → 回落默认（官方+全部镜像）', () => {
    const r = sanitizeMarketParams({ sources: ['evil.example.com', 'github'] })
    expect(r.sources).toEqual(['github'])
    const fallback = sanitizeMarketParams({ sources: ['evil.example.com'] })
    expect(fallback.sources[0]).toBe('github')
    expect(fallback.sources.length).toBeGreaterThan(3)
  })
})

describe('条目 name 兜底（审计：GitHub item.name 缺失时 metaEntry.name 为 undefined）', () => {
  it('searchMarketRepos：item.name 缺失 → name 回落 owner/repo', async () => {
    const payload = JSON.stringify({
      total_count: 1,
      items: [{ full_name: 'o/noname', default_branch: 'main', owner: { login: 'o' }, fork: false }],
    })
    globalThis.fetch = async (u) => (String(u).includes('search/repositories')
      ? { ok: true, status: 200, text: async () => payload }
      : { ok: false, status: 404, text: async () => '' })
    const r = await searchMarketRepos('dsh-plugin', '', 1, ['github'])
    expect(r.ok).toBe(true)
    expect(r.items[0].name).toBe('o/noname')
  })

  it('metaEntry：name 恒为字符串（缺 name 时用 repo）', () => {
    const e = metaEntry({ repo: 'o/x', ref: 'main', author: 'o', stars: 0, forks: 0, license: '', description: '', topics: [], updatedAt: '' })
    expect(typeof e.name).toBe('string')
    expect(e.name).toBe('o/x')
  })
})

describe('分页契约锁定（MARKET_MAX_PAGE 提取为常量）', () => {
  it('MARKET_MAX_PAGE / MARKET_PAGE_SIZE 常量契约', () => {
    expect(MARKET_MAX_PAGE).toBe(10)
    expect(MARKET_PAGE_SIZE).toBe(10)
    // page clamp：1..10，越界收敛
    expect(sanitizeMarketParams({ page: 0 }).page).toBe(1)
    expect(sanitizeMarketParams({ page: 11 }).page).toBe(10)
    expect(sanitizeMarketParams({ page: 'abc' }).page).toBe(1)
    expect(sanitizeMarketParams({ page: 999 }).page).toBe(10)
  })
})
