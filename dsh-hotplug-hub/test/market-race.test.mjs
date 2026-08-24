// test/market-race.test.mjs — 市场竞速层第二轮审计（403 语义 / 败者取消 / 响应体上限）
// 每个用例对应一次真实缺陷的根因锁定，先红后绿。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { httpGet, raceFetch, raceFiles } from '../lib/core/market.js'
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

describe('raceFiles 403 语义（审计：403 常为 GitHub 限流，不是「文件不存在」）', () => {
  it('官方 403（限流）先返回 → 不得立即结算，镜像 200 后到仍可胜出', async () => {
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('official')) return { ok: false, status: 403, text: async () => '' }
      await new Promise((r) => setTimeout(r, 20))
      return { ok: true, status: 200, text: async () => 'mirror-ok' }
    }
    const r = await raceFiles(['https://official/f', 'https://mirror/f'], 1000)
    expect(r.ok).toBe(true)
    expect(r.text).toBe('mirror-ok')
  })

  it('全部通道 403 → 等全部结算后返回失败（status=403，不吞错误）', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '' })
    const r = await raceFiles(['https://a/f', 'https://b/f'], 1000)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
  })

  it('404 / 410 仍是确定性「不存在」→ 立即结算（不被本轮回退影响）', async () => {
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('a/')) return { ok: false, status: 404, text: async () => '' }
      // b 通道永远挂起：若 404 未立即结算，测试会拖到超时
      return new Promise(() => {})
    }
    const r = await raceFiles(['https://a/f', 'https://b/f'], 1000)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)

    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('a/')) return { ok: false, status: 410, text: async () => '' }
      return new Promise(() => {})
    }
    const r2 = await raceFiles(['https://a/f', 'https://b/f'], 1000)
    expect(r2.ok).toBe(false)
    expect(r2.status).toBe(410)
  })
})

describe('竞速败者取消（审计：结算后残留请求空跑，弱网放大）', () => {
  it('raceFiles：首个成功结算后，其余通道的 fetch 收到 abort 信号', async () => {
    const signals = []
    globalThis.fetch = async (url, opts) => {
      const u = String(url)
      signals.push({ url: u, signal: opts && opts.signal })
      if (u.includes('fast')) {
        await new Promise((r) => setTimeout(r, 5))
        return { ok: true, status: 200, text: async () => 'fast-ok' }
      }
      return new Promise((resolve, reject) => {
        const s = opts && opts.signal
        if (s) s.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    const r = await raceFiles(['https://fast/f', 'https://slow1/f', 'https://slow2/f'], 5000)
    expect(r.ok).toBe(true)
    expect(r.text).toBe('fast-ok')
    // 慢通道的 signal 应已被 abort（不再占用连接/预算）
    const slowSignals = signals.filter((s) => s.url.includes('slow'))
    expect(slowSignals.length).toBe(2)
    for (const s of slowSignals) {
      expect(s.signal).toBeTruthy()
      expect(s.signal.aborted).toBe(true)
    }
  })

  it('raceFetch：首个成功结算后，其余通道的 fetch 收到 abort 信号', async () => {
    const signals = []
    globalThis.fetch = async (url, opts) => {
      const u = String(url)
      signals.push({ url: u, signal: opts && opts.signal })
      if (u.includes('fast')) {
        await new Promise((r) => setTimeout(r, 5))
        return { ok: true, status: 200, text: async () => 'fast-ok' }
      }
      return new Promise((resolve, reject) => {
        const s = opts && opts.signal
        if (s) s.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    const r = await raceFetch(['https://fast/x', 'https://slow/x'], 5000)
    expect(r.ok).toBe(true)
    const slow = signals.find((s) => s.url.includes('slow'))
    expect(slow.signal.aborted).toBe(true)
  })

  it('raceFiles（budget 包装层）：外部 signal abort / 胜出后，内层 fetch 全部被取消（审查轮回归）', async () => {
    const signals = []
    globalThis.fetch = async (url, opts) => {
      signals.push({ url: String(url), signal: opts && opts.signal })
      if (String(url).includes('fast')) {
        await new Promise((r) => setTimeout(r, 5))
        return { ok: true, status: 200, text: async () => 'fast-ok' }
      }
      return new Promise((resolve, reject) => {
        const s = opts && opts.signal
        if (s) s.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    // budget>0 走包装层（真实主链路 fetchFirstOk 的调用形态）
    const r = await raceFiles(['https://fast/f', 'https://slow1/f', 'https://slow2/f'], 5000, undefined, 8000)
    expect(r.ok).toBe(true)
    for (const s of signals.filter((x) => x.url.includes('slow'))) {
      expect(s.signal.aborted).toBe(true)
    }
    // 外部 signal 直接 abort → budget 包装层联动取消内层
    const ext = new AbortController()
    const p2 = raceFiles(['https://hang/f', 'https://hang2/f'], 5000, undefined, 8000, ext.signal)
    ext.abort()
    const r2 = await p2
    expect(r2.ok).toBe(false)
    const hangSignals = signals.filter((x) => x.url.includes('hang'))
    for (const s of hangSignals) expect(s.signal.aborted).toBe(true)
  })

  it('确定性不存在（404）结算后同样取消其余通道', async () => {
    const signals = []
    globalThis.fetch = async (url, opts) => {
      const u = String(url)
      signals.push({ url: u, signal: opts && opts.signal })
      if (u.includes('a/')) return { ok: false, status: 404, text: async () => '' }
      return new Promise((resolve, reject) => {
        const s = opts && opts.signal
        if (s) s.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    const r = await raceFiles(['https://a/f', 'https://slow/f'], 5000)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
    const slow = signals.find((s) => s.url.includes('slow'))
    expect(slow.signal.aborted).toBe(true)
  })
})

describe('httpGet 响应体上限（审计：fetch 分支无上限 / curl 分支被 64KB 截断，两通道行为漂移）', () => {
  it('fetch 分支：超上限的响应体按码点截断（防内存炸弹，与 curl 分支对齐）', async () => {
    const big = 'x'.repeat(2_000_000)
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => big })
    const r = await httpGet('https://api.github.com/big', 2000)
    expect(r.ok).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(500_000)
    expect(r.text.length).toBeGreaterThan(0)
  })

  it('fetch 分支：上限内的小响应原样返回（不截断正常 README/package.json）', async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'small-body' })
    const r = await httpGet('https://api.github.com/small', 2000)
    expect(r.text).toBe('small-body')
  })

  it('fetch 分支：截断不劈开代理对（emoji README 不产生孤立代理）', async () => {
    const big = '🐱'.repeat(400_000)
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => big })
    const r = await httpGet('https://api.github.com/emoji', 2000)
    expect(r.ok).toBe(true)
    // 按码点截断：结果长度应为偶数（全部完整代理对），无孤立代理
    expect(r.text.length % 2).toBe(0)
    expect(() => encodeURIComponent(r.text)).not.toThrow()
  })
})
