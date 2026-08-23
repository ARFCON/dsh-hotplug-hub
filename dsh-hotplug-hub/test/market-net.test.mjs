// test/market-net.test.mjs — 市场网络层（全局 fetch 桩）：竞速 / 探测 / 搜索 / 详情 / 缓存
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  httpGet, raceFetch, raceFiles, searchMarketRepos, fetchRepoDetailFiles,
  applyRepoDetailFiles, fetchRepoDetail, marketListAsync, marketDetailAsync, sanitizeMarketParams,
} from '../lib/core/market.js'
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

function stubFetch(routes) {
  // routes: [{ match: (url) => bool, status, text }]
  globalThis.fetch = async (url) => {
    const hit = routes.find((r) => r.match(String(url)))
    if (!hit) return { ok: false, status: 404, text: async () => '' }
    return { ok: hit.status === 200, status: hit.status, text: async () => hit.text }
  }
}

describe('httpGet（fetch 优先）', () => {
  it('200 返回文本；404 返回失败；网络错误回落 https/curl（桩抛错 → 失败）', async () => {
    stubFetch([{ match: () => true, status: 200, text: 'hello' }])
    const r = await httpGet('https://api.github.com/x', 1000)
    expect(r.ok).toBe(true)
    expect(r.text).toBe('hello')
  })

  it('fetch 抛错 → 失败（不崩溃）', async () => {
    globalThis.fetch = async () => { throw new Error('net down') }
    const r = await httpGet('https://api.github.com/x', 500)
    expect(r.ok).toBe(false)
  })
})

describe('raceFetch / raceFiles', () => {
  it('raceFetch：首个成功即结算', async () => {
    stubFetch([{ match: (u) => u.includes('mirror'), status: 200, text: 'ok-mirror' }])
    const r = await raceFetch(['https://a/x', 'https://mirror/x'], 1000)
    expect(r.ok).toBe(true)
    expect(r.text).toBe('ok-mirror')
    expect(r.raced).toBe(true)
  })

  it('raceFetch：全失败 → 失败 + url；空数组 → 失败', async () => {
    stubFetch([])
    const r = await raceFetch(['https://a/x', 'https://b/x'], 1000)
    expect(r.ok).toBe(false)
    expect(r.url).toBeTruthy()
    const empty = await raceFetch([], 1000)
    expect(empty.ok).toBe(false)
  })

  it('raceFiles：404 确定性结算（不等镜像）', async () => {
    stubFetch([{ match: () => true, status: 404, text: '' }])
    const r = await raceFiles(['https://a/f'], 1000)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
  })

  it('budget 到期结算（budget:true）', async () => {
    globalThis.fetch = () => new Promise(() => {}) // 永不返回
    const r = await raceFetch(['https://a/x'], 5000, {}, 100)
    expect(r.budget).toBe(true)
  })

  it('raceFiles：429 限流不算确定性不存在，镜像 200 仍可胜出（审计修复）', async () => {
    // 官方 429 先结算；旧代码 status<500 会把它当「不存在」立即结束、丢弃镜像 200
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('official')) return { ok: false, status: 429, text: async () => '' }
      await new Promise((r) => setTimeout(r, 20))
      return { ok: true, status: 200, text: async () => 'mirror-ok' }
    }
    const r = await raceFiles(['https://official/f', 'https://mirror/f'], 1000)
    expect(r.ok).toBe(true)
    expect(r.text).toBe('mirror-ok')
  })
})

describe('searchMarketRepos', () => {
  it('searchMarketRepos：解析 items（fork 过滤 + 字段映射）', async () => {
    const payload = JSON.stringify({
      total_count: 2,
      items: [
        { full_name: 'o/a', default_branch: 'main', owner: { login: 'o' }, stargazers_count: 10, forks_count: 2, license: { spdx_id: 'MIT' }, description: 'd', topics: ['t'], updated_at: '2026-01-01', fork: false },
        { full_name: 'o/b', default_branch: 'dev', name: 'b', fork: true },
      ],
    })
    stubFetch([{ match: (u) => u.includes('search/repositories'), status: 200, text: payload }])
    const r = await searchMarketRepos('dsh-plugin', '', 1, ['github'])
    expect(r.ok).toBe(true)
    expect(r.items).toHaveLength(1)
    expect(r.items[0].repo).toBe('o/a')
    expect(r.total).toBe(2)
  })

  it('searchMarketRepos：响应结构异常 → 错误', async () => {
    stubFetch([{ match: () => true, status: 200, text: '{"message":"rate limited"}' }])
    const r = await searchMarketRepos('dsh-plugin', '', 1, ['github'])
    expect(r.ok).toBe(false)
  })

  it('searchMarketRepos：HTTP 错误 → "HTTP <status>"；网络失败(status=0) → "网络请求失败"（审计修复：运算符优先级死代码）', async () => {
    // status=404：确定性结算 → 错误消息应为 HTTP 404
    stubFetch([{ match: () => true, status: 404, text: '' }])
    const r404 = await searchMarketRepos('dsh-plugin', '', 1, ['github'])
    expect(r404.ok).toBe(false)
    expect(r404.error).toBe('HTTP 404')
    // status=0：网络层失败（curl 兜底也失败）→ 错误消息应为「网络请求失败」而非「HTTP 0」
    stubFetch([{ match: () => true, status: 0, text: '' }])
    const r0 = await searchMarketRepos('dsh-plugin', '', 1, ['github'])
    expect(r0.ok).toBe(false)
    expect(r0.error).toBe('网络请求失败')
  })
})

describe('fetchRepoDetail / marketListAsync（全链路桩）', () => {
  const searchPayload = JSON.stringify({
    total_count: 1,
    items: [{ full_name: 'o/r', default_branch: 'main', name: 'r', owner: { login: 'o' }, stargazers_count: 3, forks_count: 1, license: { spdx_id: 'MIT' }, description: 'desc', topics: ['dsh-plugin'], updated_at: '2026-01-01', fork: false }],
  })

  it('仓库含 hotpack.json → hasPack + manifest', async () => {
    const hp = JSON.stringify({ hotpack: '1.0', id: 'pack.r', name: 'R', version: '1.0.0', plugins: [{ id: 'p', name: 'pkg-p', source: { type: 'npm' }, version: '1.0.0' }] })
    stubFetch([
      { match: (u) => u.includes('hotpack.json'), status: 200, text: hp },
      { match: (u) => u.includes('README'), status: 200, text: '# R\n\n介绍。' },
      { match: (u) => u.includes('package.json'), status: 404, text: '' },
    ])
    const r = await fetchRepoDetail('o/r', 'main', { name: 'r', author: 'o', stars: 3 }, ['github'])
    expect(r.importable).toBe(true)
    expect(r.hasPack).toBe(true)
    expect(r.manifest.id).toBe('pack.r')
    expect(r.intro).toContain('介绍')
  })

  it('仓库只有 package.json → 兜底单插件 manifest', async () => {
    stubFetch([
      { match: (u) => u.includes('hotpack.json') || u.includes('.dshpack'), status: 404, text: '' },
      { match: (u) => u.includes('package.json'), status: 200, text: '{"name":"pkg-r","version":"1.2.3"}' },
      { match: (u) => u.includes('README'), status: 404, text: '' },
    ])
    const r = await fetchRepoDetail('o/r', 'main', { name: 'r' }, ['github'])
    expect(r.importable).toBe(true)
    expect(r.manifest.plugins[0].source.type).toBe('github')
    expect(r.npmName).toBe('pkg-r')
  })

  it('仓库不可达（全部文件确定性 404）→ importable:false（无存活探测，快速结算）', async () => {
    stubFetch([{ match: () => true, status: 404, text: '' }])
    const r = await fetchRepoDetail('o/r', 'main', { name: 'r' }, ['github'])
    expect(r.importable).toBe(false)
    expect(r.importError).toContain('未找到 package.json')
  })

  it('marketListAsync：搜索→元数据条目（详情由 marketDetail 补齐）→写缓存→refresh 重抓', async () => {
    stubFetch([
      { match: (u) => u.includes('search/repositories'), status: 200, text: searchPayload },
    ])
    const params = { topic: 'dsh-plugin', sources: ['github'], page: 1 }
    const r1 = await marketListAsync(params)
    expect(r1.ok).toBe(true)
    expect(r1.entries).toHaveLength(1)
    expect(r1.cached).toBe(false)
    // 元数据条目：detailPending=true，不携带 manifest（v0.9.7 对齐）
    expect(r1.entries[0].detailPending).toBe(true)
    expect(r1.entries[0].manifest).toBeNull()
    // 命中缓存
    const r2 = await marketListAsync(params)
    expect(r2.ok).toBe(true)
    expect(r2.cached).toBe(true)
    // refresh 重抓（cached:false）
    const r3 = await marketListAsync({ ...params, refresh: true })
    expect(r3.ok).toBe(true)
    expect(r3.cached).toBe(false)
  })

  it('marketDetailAsync：抓详情→独立缓存→refresh 重抓（400 上限滚动）', async () => {
    const hp = JSON.stringify({ hotpack: '1.0', id: 'pack.r', name: 'R', version: '1.0.0', plugins: [{ id: 'p', name: 'pkg-p', source: { type: 'npm' }, version: '1.0.0' }] })
    stubFetch([
      { match: (u) => u.includes('hotpack.json'), status: 200, text: hp },
      { match: (u) => u.includes('README'), status: 404, text: '' },
      { match: (u) => u.includes('package.json'), status: 404, text: '' },
    ])
    const d1 = await marketDetailAsync({ repo: 'o/r', ref: 'main', sources: ['github'] })
    expect(d1.ok).toBe(true)
    expect(d1.cached).toBe(false)
    expect(d1.entry.hasPack).toBe(true)
    expect(d1.entry.manifest.id).toBe('pack.r')
    // 命中独立详情缓存
    const d2 = await marketDetailAsync({ repo: 'o/r', ref: 'main', sources: ['github'] })
    expect(d2.ok).toBe(true)
    expect(d2.cached).toBe(true)
    // refresh 重抓
    const d3 = await marketDetailAsync({ repo: 'o/r', ref: 'main', sources: ['github'], refresh: true })
    expect(d3.ok).toBe(true)
    expect(d3.cached).toBe(false)
    // 非法 repo 明确错误
    const bad = await marketDetailAsync({ repo: 'not-a-repo' })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('repo')
  })

  it('marketDetailAsync：repo 校验统一到 shared（拒绝 .foo/bar、-x/y、a//b）', async () => {
    // 旧本地 REPO_RE 曾放行 .foo/bar / -x/y（无字母数字开头约束），现收敛到 validateSourceRepo
    for (const repo of ['.foo/bar', '-x/y', 'a//b', 'a/../b']) {
      const r = await marketDetailAsync({ repo })
      expect(r.ok, repo).toBe(false)
      expect(r.error, repo).toContain('repo')
    }
  })

  it('marketDetailAsync：ref 允许合法 /（feature/x 不再回退 main，契约与 validateSourceRef 一致）', async () => {
    const seen = []
    globalThis.fetch = async (url) => {
      const u = String(url)
      seen.push(u)
      if (u.includes('package.json')) return { ok: true, status: 200, text: async () => '{"name":"pkg-r","version":"1.0.0"}' }
      return { ok: false, status: 404, text: async () => '' }
    }
    const r = await marketDetailAsync({ repo: 'o/r', ref: 'feature/x', sources: ['github'] })
    expect(r.ok).toBe(true)
    expect(r.entry.importable).toBe(true)
    // ref 被原样采用（feature/x），未回退 main
    expect(seen.some((u) => u.includes('/feature/x/'))).toBe(true)
    expect(seen.some((u) => u.includes('/main/'))).toBe(false)
  })

  it('marketListAsync：非法参数明确错误', async () => {
    const r = await marketListAsync({ topic: 'x'.repeat(40) })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('topic')
  })

  it('applyRepoDetailFiles 单元：packScan 优先 + pkgRes 补充 + readme', () => {
    const entry = { npmName: null, version: null, hasPack: false, packKind: null, manifest: null, importable: true, importError: null }
    const files = {
      packScan: { name: 'hotpack.json', pack: { id: 'x', version: '2.0.0', plugins: [{ name: 'p1' }] } },
      pkgRes: { ok: true, text: '{"name":"pkg-x","version":"9.9.9"}' },
      readmeScan: { name: 'README.md', text: '# X\n\n介绍' },
    }
    applyRepoDetailFiles(entry, files, 'o/r', 'main')
    expect(entry.hasPack).toBe(true)
    expect(entry.version).toBe('2.0.0') // packScan 优先
    expect(entry.npmName).toBe('p1')
    expect(entry.intro).toContain('介绍')
  })

  it('sanitizeMarketParams 经市场入口校验', () => {
    expect(sanitizeMarketParams({ sources: ['github'], page: 'abc' }).page).toBe(1)
  })
})
