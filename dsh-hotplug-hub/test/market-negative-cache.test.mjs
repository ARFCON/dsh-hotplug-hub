// test/market-negative-cache.test.mjs — 详情缓存不落「瞬时失败」负结果（缓存卫生审计）
//
// 背景：marketDetailAsync 的 fetchRepoDetail 一旦抛错（网络瞬断/超时），构造的
// importable:false 条目会被原样写入 detail 缓存并持有 1 小时 TTL——一次网络抖动
// 让仓库在市场里「不可导入」一小时（refresh 前不可恢复）。
// 契约：只有「确定性结论」进缓存（抓取完成的条目，包括合法的「不是包」判定）；
// 抓取过程抛错（瞬时故障）→ 本次返回失败条目但不落缓存，下次调用重抓。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { marketDetailAsync } from '../lib/core/market.js'
import { MARKET_DETAIL_CACHE_FILE as CACHE_FN } from '../lib/core/paths.js'
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

function cacheText() {
  const f = CACHE_FN()
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

describe('详情缓存不负缓存瞬时失败', () => {
  it('网络全挂（fetch 抛错→curl 缺席→全部 status 0）→ 返回不可导入但不写缓存（inconclusive）', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNRESET') }
    const r = await marketDetailAsync({ repo: 'o/flaky', ref: 'main' })
    expect(r.ok).toBe(true)
    expect(r.entry.importable).toBe(false)
    expect(r.entry.inconclusive).toBe(true)
    expect(cacheText()).not.toContain('o/flaky')
  })

  it('瞬断后网络恢复 → 同一仓库立即能拿到正常详情（证明未负缓存）', async () => {
    globalThis.fetch = async () => { throw new Error('timeout') }
    await marketDetailAsync({ repo: 'o/recover', ref: 'main' })
    // 网络恢复：package.json 可得 → 单插件兜底 manifest 生成
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('package.json')) {
        return { ok: true, status: 200, text: async () => '{"name":"pkg-r","version":"1.0.0"}' }
      }
      return { ok: false, status: 404, text: async () => '' }
    }
    const r2 = await marketDetailAsync({ repo: 'o/recover', ref: 'main' })
    expect(r2.ok).toBe(true)
    expect(r2.entry.importable).toBe(true)
    expect(r2.entry.npmName).toBe('pkg-r')
  })

  it('确定性「不是包」（全部 404，抓取完成）→ 允许进缓存（合法负结论）', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '' })
    const r = await marketDetailAsync({ repo: 'o/notapack', ref: 'main' })
    expect(r.ok).toBe(true)
    expect(r.entry.importable).toBe(false)
    expect(cacheText()).toContain('o/notapack')
  })

  it('正常详情进缓存（回归）：第二次调用 cached:true', async () => {
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('package.json')) {
        return { ok: true, status: 200, text: async () => '{"name":"pkg-x","version":"2.0.0"}' }
      }
      return { ok: false, status: 404, text: async () => '' }
    }
    const r1 = await marketDetailAsync({ repo: 'o/normal', ref: 'main' })
    expect(r1.cached).toBe(false)
    const r2 = await marketDetailAsync({ repo: 'o/normal', ref: 'main' })
    expect(r2.cached).toBe(true)
    expect(r2.entry.importable).toBe(true)
  })
})
