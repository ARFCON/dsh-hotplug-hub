// test/market-cache.test.mjs — 市场缓存层第二轮审计（并发丢更新 / TTL / meta 净化 / FIFO）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  marketListAsync, marketDetailAsync,
} from '../lib/core/market.js'
import {
  MARKET_CACHE_FILE, MARKET_DETAIL_CACHE_FILE, MARKET_CACHE_TTL_MS, MARKET_DETAIL_CACHE_TTL_MS,
} from '../lib/core/paths.js'
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

const searchPayload = (names) => JSON.stringify({
  total_count: names.length,
  items: names.map((n) => ({
    full_name: `o/${n}`, default_branch: 'main', name: n, owner: { login: 'o' },
    stargazers_count: 1, forks_count: 0, license: { spdx_id: 'MIT' }, description: 'd',
    topics: ['dsh-plugin'], updated_at: '2026-01-01', fork: false,
  })),
})

const hotpackText = (name) => JSON.stringify({
  hotpack: '1.0', id: `pack.${name}`, name, version: '1.0.0',
  plugins: [{ id: 'p', name: `pkg-${name}`, source: { type: 'npm' }, version: '1.0.0' }],
})

/** 详情桩：任意仓库的 hotpack.json 命中，其余 404；带可控延迟确保 read 交错。 */
function stubDetailFetch(delayMs = 25) {
  globalThis.fetch = async (url) => {
    const u = String(url)
    await new Promise((r) => setTimeout(r, delayMs))
    if (u.includes('hotpack.json')) return { ok: true, status: 200, text: async () => hotpackText(u.split('/raw.githubusercontent.com/')[1]?.split('/')[1] ?? 'r') }
    return { ok: false, status: 404, text: async () => '' }
  }
}

describe('marketDetailAsync 并发缓存写（审计：read-modify-write 竞态丢更新）', () => {
  it('并发 6 个不同仓库的详情抓取 → 缓存文件保留全部 6 条（不丢更新）', async () => {
    stubDetailFetch()
    const repos = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']
    await Promise.all(repos.map((r) => marketDetailAsync({ repo: `o/${r}`, ref: 'main', sources: ['github'] })))
    const cache = JSON.parse(readFileSync(MARKET_DETAIL_CACHE_FILE(), 'utf8'))
    for (const r of repos) {
      expect(cache[`o/${r}@main`], `o/${r}@main`).toBeTruthy()
    }
  })

  it('并发抓取后 refresh 单条 → 其余条目仍在（单条重写不清空整表）', async () => {
    stubDetailFetch()
    await Promise.all(['a', 'b', 'c'].map((r) => marketDetailAsync({ repo: `o/${r}`, ref: 'main', sources: ['github'] })))
    await marketDetailAsync({ repo: 'o/a', ref: 'main', sources: ['github'], refresh: true })
    const cache = JSON.parse(readFileSync(MARKET_DETAIL_CACHE_FILE(), 'utf8'))
    expect(cache['o/a@main']).toBeTruthy()
    expect(cache['o/b@main']).toBeTruthy()
    expect(cache['o/c@main']).toBeTruthy()
  })
})

describe('marketDetailAsync meta 净化（审计：RPC 传入的 meta 未净化直写缓存）', () => {
  it('非法类型字段被净化为安全默认（stars 对象→0、巨型字符串截断、topics 非字符串剔除）', async () => {
    stubDetailFetch()
    const r = await marketDetailAsync({
      repo: 'o/m', ref: 'main', sources: ['github'],
      meta: {
        name: 'M'.repeat(5000), author: { evil: true }, stars: { $gt: 1 }, forks: 'not-a-number',
        license: 42, description: 'D'.repeat(5000), topics: ['ok', 123, null, { x: 1 }, 't'.repeat(100)],
        updatedAt: ['array'],
      },
    })
    expect(r.ok).toBe(true)
    expect(typeof r.entry.stars).toBe('number')
    expect(r.entry.stars).toBe(0)
    expect(typeof r.entry.name).toBe('string')
    expect(r.entry.name.length).toBeLessThanOrEqual(200)
    expect(typeof r.entry.description).toBe('string')
    expect(r.entry.description.length).toBeLessThanOrEqual(400)
    expect(Array.isArray(r.entry.topics)).toBe(true)
    for (const t of r.entry.topics) expect(typeof t).toBe('string')
    expect(r.entry.topics).toContain('ok')
    // 落盘的缓存同样净化（新格式 {at, entry} 包裹）
    const cache = JSON.parse(readFileSync(MARKET_DETAIL_CACHE_FILE(), 'utf8'))
    expect(typeof cache['o/m@main'].entry.stars).toBe('number')
  })
})

describe('marketDetailAsync 缓存 TTL（审计：详情缓存无过期，README/manifest 陈旧数据无限期存留）', () => {
  it('缓存命中（TTL 内）→ cached:true', async () => {
    stubDetailFetch()
    await marketDetailAsync({ repo: 'o/t', ref: 'main', sources: ['github'] })
    const r2 = await marketDetailAsync({ repo: 'o/t', ref: 'main', sources: ['github'] })
    expect(r2.cached).toBe(true)
  })

  it('超过 TTL → 视为 miss 重抓（cached:false）', async () => {
    stubDetailFetch()
    await marketDetailAsync({ repo: 'o/t2', ref: 'main', sources: ['github'] })
    // 手动把缓存时间戳拨回过去（超过 detail TTL）
    const file = MARKET_DETAIL_CACHE_FILE()
    const cache = JSON.parse(readFileSync(file, 'utf8'))
    cache['o/t2@main'].at = new Date(Date.now() - MARKET_DETAIL_CACHE_TTL_MS - 1000).toISOString()
    writeFileSync(file, JSON.stringify(cache))
    let fetched = false
    const inner = globalThis.fetch
    globalThis.fetch = async (url) => { fetched = true; return inner(url) }
    const r = await marketDetailAsync({ repo: 'o/t2', ref: 'main', sources: ['github'] })
    expect(r.cached).toBe(false)
    expect(fetched).toBe(true)
  })

  it('旧格式缓存条目（无时间戳）→ 视为过期，重抓后转为新格式', async () => {
    const file = MARKET_DETAIL_CACHE_FILE()
    mkdirSync(join(file, '..'), { recursive: true })
    // 旧格式：值就是 entry 本身（无 {at, entry} 包裹）
    writeFileSync(file, JSON.stringify({ 'o/legacy@main': { repo: 'o/legacy', ref: 'main', name: 'legacy', stars: 1 } }))
    stubDetailFetch()
    const r = await marketDetailAsync({ repo: 'o/legacy', ref: 'main', sources: ['github'] })
    expect(r.cached).toBe(false)
    const cache = JSON.parse(readFileSync(file, 'utf8'))
    expect(cache['o/legacy@main'].at).toBeTruthy()
    expect(cache['o/legacy@main'].entry).toBeTruthy()
  })
})

describe('marketDetailAsync FIFO 400 上限（审计：现有测试只测 refresh，未真测滚动）', () => {
  it('写入 403 条不同仓库 → 缓存至多 400 条且保留最新写入', async () => {
    stubDetailFetch(1)
    for (let i = 0; i < 403; i++) {
      await marketDetailAsync({ repo: `o/r${String(i).padStart(4, '0')}`, ref: 'main', sources: ['github'] })
    }
    const cache = JSON.parse(readFileSync(MARKET_DETAIL_CACHE_FILE(), 'utf8'))
    const keys = Object.keys(cache)
    expect(keys.length).toBeLessThanOrEqual(400)
    // 最新写入的 r0402 必然保留；最早的 r0000 应被淘汰
    expect(cache['o/r0402@main']).toBeTruthy()
    expect(cache['o/r0000@main']).toBeUndefined()
  })
})

describe('marketListAsync 缓存 TTL 与 hasMore 契约', () => {
  const fullPage = searchPayload(Array.from({ length: 10 }, (_, i) => 'p' + i))

  it('hasMore：满页且 page<上限 → true；缓存命中后仍返回', async () => {
    globalThis.fetch = async (u) => (String(u).includes('search/repositories')
      ? { ok: true, status: 200, text: async () => fullPage }
      : { ok: false, status: 404, text: async () => '' })
    const r = await marketListAsync({ topic: 'dsh-plugin', sources: ['github'], page: 1 })
    expect(r.ok).toBe(true)
    expect(r.hasMore).toBe(true)
    const cached = await marketListAsync({ topic: 'dsh-plugin', sources: ['github'], page: 1 })
    expect(cached.cached).toBe(true)
    expect(cached.hasMore).toBe(true)
  })

  it('hasMore：某页含 fork（过滤后不足页大小）→ 仍按原始页计数为 true（审查轮修复）', async () => {
    const payload = JSON.stringify({
      total_count: 50,
      items: Array.from({ length: 10 }, (_, i) => ({
        full_name: 'o/f' + i, default_branch: 'main', name: 'f' + i, owner: { login: 'o' },
        stargazers_count: 0, forks_count: 0, license: null, description: '', topics: [],
        updated_at: '', fork: i === 9, // 最后一条是 fork → 过滤后 9 条
      })),
    })
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => payload })
    const r = await marketListAsync({ topic: 'dsh-plugin', sources: ['github'], page: 1 })
    expect(r.entries).toHaveLength(9)
    expect(r.hasMore).toBe(true) // 原始页 10 条满页，仍有更多结果
  })

  it('hasMore：不满页（结果耗尽）→ false；page 达到上限 → false', async () => {
    globalThis.fetch = async (u) => ({ ok: true, status: 200, text: async () => searchPayload(['only-one']) })
    const r = await marketListAsync({ topic: 'dsh-plugin', sources: ['github'], page: 1 })
    expect(r.hasMore).toBe(false)
    // page=10（clamp 上限）：即便满页也无更多
    globalThis.fetch = async (u) => ({ ok: true, status: 200, text: async () => fullPage })
    const r10 = await marketListAsync({ topic: 'dsh-plugin', sources: ['github'], page: 10 })
    expect(r10.hasMore).toBe(false)
    // page=99 被 clamp 到 10 → 同样 false
    const r99 = await marketListAsync({ topic: 'dsh-plugin', sources: ['github'], page: 99 })
    expect(r99.hasMore).toBe(false)
  })

  it('list 缓存超过 TTL → 重抓（cached:false）', async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => fullPage })
    await marketListAsync({ topic: 'dsh-plugin', sources: ['github'], page: 1 })
    const file = MARKET_CACHE_FILE()
    const cache = JSON.parse(readFileSync(file, 'utf8'))
    cache.cachedAt = new Date(Date.now() - MARKET_CACHE_TTL_MS - 1000).toISOString()
    writeFileSync(file, JSON.stringify(cache))
    const r = await marketListAsync({ topic: 'dsh-plugin', sources: ['github'], page: 1 })
    expect(r.cached).toBe(false)
    // 重抓后缓存文件被新时间戳覆盖
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(Date.parse(after.cachedAt)).toBeGreaterThan(Date.now() - MARKET_CACHE_TTL_MS)
  })

  it('list 缓存损坏（非 JSON）→ 静默重抓，不抛错', async () => {
    const file = MARKET_CACHE_FILE()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '{broken json')
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => fullPage })
    const r = await marketListAsync({ topic: 'dsh-plugin', sources: ['github'], page: 1 })
    expect(r.ok).toBe(true)
    expect(existsSync(file)).toBe(true)
  })
})
