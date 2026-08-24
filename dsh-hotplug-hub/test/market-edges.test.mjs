// test/market-edges.test.mjs — 市场边缘矩阵：净化 / id 单射 / URL 构造 / README 提取 /
// 竞速语义（404 确定性 / 全失败等待 / 预算到期 / 败者取消）/ 响应体上限 / 缓存写失败容忍 /
// marketDetail 参数回退。全程 fetch 桩（零真实网络）+ 隔离 DSH_HOME（零真实 ~/.dsh 写入）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync } from 'node:fs'
import {
  sanitizeDetailMeta, sanitizeTopic, sanitizeMarketParams, packIdOf, apiSearchUrls, rawFileUrls,
  looksLikeNav, extractIntro, extractInstall, httpGet, raceFetch, raceFiles,
  marketListAsync, marketDetailAsync, toWellFormed,
} from '../lib/core/market.js'
import { MARKET_CACHE_FILE, MARKET_MAX_BODY_CHARS } from '../lib/core/paths.js'
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

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

describe('sanitizeDetailMeta（类型白名单 + 码点安全截断）', () => {
  it('对象 stars → 0、非字符串 name/author → 空串、非数字 forks → 0', () => {
    const r = sanitizeDetailMeta({
      name: 42, author: { evil: true }, stars: { $gt: 1 }, forks: 'not-a-number',
      license: true, description: { x: 1 }, updatedAt: ['array'],
      topics: 'not-an-array',
    })
    expect(r.name).toBe('')
    expect(r.author).toBe('')
    expect(r.stars).toBe(0)
    expect(r.forks).toBe(0)
    expect(r.license).toBe('')
    expect(r.description).toBe('')
    expect(r.updatedAt).toBe('')
    expect(r.topics).toEqual([])
  })

  it('topics：非字符串剔除、至多 12 个', () => {
    const topics = []
    for (let i = 0; i < 15; i++) topics.push('t' + i)
    topics.splice(3, 0, 123, null, { x: 1 }) // 混入非字符串
    const r = sanitizeDetailMeta({ topics })
    expect(r.topics).toHaveLength(12)
    for (const t of r.topics) expect(typeof t).toBe('string')
    expect(r.topics).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11'])
  })

  it('topics 截断码点安全：30 个 emoji → 24 个完整 emoji（代理对不劈开）', () => {
    const emoji = '😀'
    const r = sanitizeDetailMeta({ topics: [emoji.repeat(30), 'x'.repeat(40)] })
    expect(Array.from(r.topics[0])).toHaveLength(24)
    expect(Array.from(r.topics[0]).every((c) => c === emoji)).toBe(true)
    // 良构性：无孤立代理（toWellFormed 等价校验，Node 18 无原生方法故用 lib 导出）
    expect(toWellFormed(r.topics[0])).toBe(r.topics[0])
    expect(r.topics[1]).toBe('x'.repeat(24))
  })

  it('字符串字段 trim + 截断（name 120 / description 300 码点）', () => {
    const r = sanitizeDetailMeta({ name: '  ' + 'n'.repeat(500), description: 'd'.repeat(1000) })
    expect(r.name).toBe('n'.repeat(120))
    expect(r.description).toBe('d'.repeat(300))
  })
})

describe('packIdOf（单射 / 小写 / ≤64 / 长名截断）', () => {
  it('单射与稳定性：a-b/c vs a/b-c 不同；同输入同输出；小写；≤64；8 位 hash 后缀', () => {
    const id1 = packIdOf('a-b/c')
    const id2 = packIdOf('a/b-c')
    expect(id1).not.toBe(id2)
    expect(packIdOf('a-b/c')).toBe(id1) // 稳定
    expect(packIdOf('Owner/Repo')).toBe(packIdOf('owner/repo')) // 小写归一
    for (const id of [id1, id2, packIdOf('ARFCON/dsh-hotplug-hub')]) {
      expect(id).toMatch(/^[a-z0-9._-]+$/) // 小写字符集
      expect(id.length).toBeLessThanOrEqual(64)
      expect(id).toMatch(/-[0-9a-f]{8}$/) // sha1 短哈希后缀
    }
  })

  it('长 repo（base>55）截断后仍以 hash 后缀保持可区分', () => {
    const long1 = packIdOf('a'.repeat(60) + '/y')
    const long2 = packIdOf('a'.repeat(60) + '/z')
    // 截断只砍 base 前缀，hash 由完整 repo 派生 → 不同仓库不同 id
    expect(long1).not.toBe(long2)
    expect(long1.startsWith('pack.' + 'a'.repeat(50))).toBe(true)
    expect(long1.length).toBeLessThanOrEqual(64)
    expect(long2.length).toBeLessThanOrEqual(64)
  })
})

describe('apiSearchUrls / rawFileUrls（URL 编码与去重）', () => {
  it('多 token topic（a b）→「topic:a topic:b」；q/topic 均经 encodeURIComponent（%3A / %20 / + 拼接）', () => {
    const valid = sanitizeMarketParams({ topic: 'a b', q: 'x y', sources: ['github'] })
    expect(valid.ok).toBe(true)
    expect(valid.topic).toBe('a b')
    const urls = apiSearchUrls(valid.topic, valid.q, 2, valid.sources)
    expect(urls[0]).toContain('q=topic%3Aa%20topic%3Ab+x%20y')
    expect(urls[0]).toContain('&page=2')
    expect(urls[0]).toContain('per_page=10')
  })

  it('非 ASCII topic 在 sanitizeTopic/sanitizeMarketParams 层被拒（不进 URL）；page clamp 在上游', () => {
    expect(sanitizeTopic('中文插件')).toBeNull()
    expect(sanitizeTopic('dsh-😀')).toBeNull()
    expect(sanitizeMarketParams({ topic: '中文' }).ok).toBe(false)
    // page 上游 clamp 到 MARKET_MAX_PAGE；URL 层不做 clamp（用哪个 page 就拼哪个）
    expect(sanitizeMarketParams({ page: 999 }).page).toBe(10)
    expect(sanitizeMarketParams({ page: 'abc' }).page).toBe(1)
    expect(apiSearchUrls('t', '', 11, ['github'])[0]).toContain('page=11')
  })

  it('rawFileUrls：镜像前缀形状 + 重复来源去重（不产生重复候选 URL）', () => {
    const urls = rawFileUrls('o/r', 'main', 'README.md', ['github', 'ghfast.top', 'github', 'ghfast.top/'])
    expect(urls).toEqual([
      'https://raw.githubusercontent.com/o/r/main/README.md',
      'https://ghfast.top/https://raw.githubusercontent.com/o/r/main/README.md',
    ])
  })
})

describe('extractIntro / looksLikeNav / extractInstall（README 提取边缘）', () => {
  it('extractIntro：空 / null → 空串', () => {
    expect(extractIntro('')).toBe('')
    expect(extractIntro(null)).toBe('')
    expect(extractIntro(undefined)).toBe('')
  })

  it('extractIntro：纯导航 README（English/中文/多语言链接）→ 兜底返回去链接后的首段（中文）', () => {
    const navOnly = '# R\n\n[English](README.md) 中文\n\n[简体中文](README.zh-CN.md)\n\n[日本語](README.ja.md)'
    // 实际行为：首循环跳过导航段后无正文 → 兜底循环返回首个非空清洗段（链接剥离、仅剩 '中文'）
    expect(extractIntro(navOnly)).toBe('中文')
  })

  it('extractIntro：HTML 标签剥离 + 空白折叠', () => {
    expect(extractIntro('# T\n\n<p>Hello <b>world</b>!</p>')).toBe('Hello world !')
  })

  it('extractIntro：超 280 截断并以省略号结尾', () => {
    const out = extractIntro('# T\n\n' + 'x'.repeat(300))
    expect(out.length).toBe(281)
    expect(out.endsWith('…')).toBe(true)
  })

  it('looksLikeNav：正样本（语言切换短段）/ 负样本（空、长文本、无关键词短段）', () => {
    expect(looksLikeNav('[English](README.md) 中文')).toBe(true)
    expect(looksLikeNav('English | 简体中文')).toBe(true)
    expect(looksLikeNav('日本語へ')).toBe(true)
    expect(looksLikeNav('')).toBe(false)
    expect(looksLikeNav('This sentence is long enough to be a real intro paragraph!')).toBe(false)
    expect(looksLikeNav('hello world')).toBe(false) // 短但无语言关键词
  })

  it('extractInstall：标题变体（### Installation / ## 快速开始 / ## 安装方法）', () => {
    expect(extractInstall('# T\n\n### Installation\nnpm i a\n\n## 其他\nz')).toBe('npm i a')
    expect(extractInstall('# T\n\n## 快速开始\npnpm i b\n\n## 其他\nz')).toBe('pnpm i b')
    expect(extractInstall('# T\n\n## 安装方法\nyarn add c\n\n## 其他\nz')).toBe('yarn add c')
  })

  it('extractInstall：单井号 # 安装 不在识别范围（#{2,4}）→ 空串', () => {
    expect(extractInstall('# T\n\n# 安装\nnpm i x')).toBe('')
  })

  it('extractInstall：CRLF 归一（无 \\r 残留）+ 代码围栏剥离（语言标记保留为正文行）', () => {
    const text = '# T\r\n\r\n## 安装\r\n\r\n```bash\r\nnpm i x\r\n```\r\n\r\n## 使用\r\nz\r\n'
    const out = extractInstall(text)
    expect(out).not.toContain('\r')
    expect(out).not.toContain('```')
    expect(out).toBe('bash\nnpm i x')
  })

  it('extractInstall：1200 上限截断以 \\n… 结尾', () => {
    const out = extractInstall('# T\n\n## 安装\n' + 'a'.repeat(1300) + '\n\n## 使用\nz')
    expect(out.length).toBe(1202) // 1200 + '\n…'
    expect(out.startsWith('a'.repeat(100))).toBe(true)
    expect(out.endsWith('\n…')).toBe(true)
  })
})

describe('raceFiles / raceFetch / httpGet（fetch 桩竞速语义）', () => {
  it('raceFiles：官方 404 确定性立即结算（镜像 300ms 后才 200 也不采纳），耗时 < 600ms（审查修复：放宽上限防重载 CI 抖动）', async () => {
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('official')) return { ok: false, status: 404, text: async () => '' }
      await delay(300)
      return { ok: true, status: 200, text: async () => 'mirror-ok' }
    }
    const t0 = Date.now()
    const r = await raceFiles(['https://official/f', 'https://mirror/f'], 5000)
    const elapsed = Date.now() - t0
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
    expect(elapsed).toBeLessThan(600)
  })

  it('raceFiles：全部 500（非确定性失败）→ 等全部通道结算再返回（status=500）', async () => {
    globalThis.fetch = async (url) => {
      await delay(String(url).includes('slow') ? 150 : 20)
      return { ok: false, status: 500, text: async () => '' }
    }
    const t0 = Date.now()
    const r = await raceFiles(['https://fast/f', 'https://slow/f'], 5000)
    const elapsed = Date.now() - t0
    expect(r.ok).toBe(false)
    expect(r.status).toBe(500)
    expect(elapsed).toBeGreaterThanOrEqual(100) // 没有被首个 500 提前结算
  })

  it('raceFiles：预算到期（budgetMs=50，全部挂起）→ {ok:false, budget:true}', async () => {
    globalThis.fetch = () => new Promise(() => {}) // 永不返回
    const t0 = Date.now()
    const r = await raceFiles(['https://a/f', 'https://b/f'], 5000, undefined, 50)
    expect(r.ok).toBe(false)
    expect(r.budget).toBe(true)
    expect(Date.now() - t0).toBeLessThan(400)
  })

  it('raceFetch：首个成功胜出（即使慢通道随后也 200），败者 fetch 收到 abort', async () => {
    const seen = []
    globalThis.fetch = async (url, opts) => {
      const u = String(url)
      seen.push({ url: u, signal: opts && opts.signal })
      if (u.includes('fast')) {
        await delay(10)
        return { ok: true, status: 200, text: async () => 'fast-ok' }
      }
      await delay(200)
      return { ok: true, status: 200, text: async () => 'slow-ok' }
    }
    const r = await raceFetch(['https://fast/x', 'https://slow/x'], 5000)
    expect(r.ok).toBe(true)
    expect(r.raced).toBe(true)
    expect(r.url).toBe('https://fast/x')
    expect(r.text).toBe('fast-ok')
    const slow = seen.find((s) => s.url.includes('slow'))
    expect(slow.signal).toBeTruthy()
    expect(slow.signal.aborted).toBe(true)
  })

  it('httpGet：非 2xx → {ok:false, status}；2xx 超上限按码点截断（emoji 边界不劈开）', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '' })
    const bad = await httpGet('https://a/x', 1000)
    expect(bad.ok).toBe(false)
    expect(bad.status).toBe(503)
    expect(bad.text).toBe('')
    // 499999 个 ASCII + 2 个 emoji = 500001 码点 → 截到 500000（末尾恰为完整 emoji）
    const emoji = '😀'
    const body = 'x'.repeat(MARKET_MAX_BODY_CHARS - 1) + emoji + emoji
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => body })
    const r = await httpGet('https://a/big', 2000)
    expect(r.ok).toBe(true)
    expect(Array.from(r.text)).toHaveLength(MARKET_MAX_BODY_CHARS)
    expect(r.text.endsWith(emoji)).toBe(true)
    expect(toWellFormed(r.text)).toBe(r.text) // 无孤立代理
    expect(() => encodeURIComponent(r.text)).not.toThrow()
  })
})

describe('marketListAsync / marketDetailAsync（缓存写失败容忍 + 参数回退）', () => {
  const searchPayload = JSON.stringify({
    total_count: 1,
    items: [{
      full_name: 'o/r', default_branch: 'main', name: 'r', owner: { login: 'o' },
      stargazers_count: 1, forks_count: 0, license: null, description: 'd',
      topics: ['dsh-plugin'], updated_at: '2026-01-01', fork: false,
    }],
  })

  it('marketListAsync：缓存写失败被吞（market-cache.json 是目录 → writeJsonSafe 抛错），列表仍 ok', async () => {
    globalThis.fetch = async (u) => (String(u).includes('search/repositories')
      ? { ok: true, status: 200, text: async () => searchPayload }
      : { ok: false, status: 404, text: async () => '' })
    // 预置缓存文件为目录：readJson（EISDIR）→ null 视为 miss；writeJsonSafe 落盘失败被吞
    mkdirSync(MARKET_CACHE_FILE(), { recursive: true })
    const r = await marketListAsync({ topic: 'dsh-plugin', sources: ['github'], page: 1 })
    expect(r.ok).toBe(true)
    expect(r.cached).toBe(false)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0].repo).toBe('o/r')
    // 再来一次同样不崩（读缓存失败 → miss → 重抓）
    const r2 = await marketListAsync({ topic: 'dsh-plugin', sources: ['github'], page: 1 })
    expect(r2.ok).toBe(true)
    expect(r2.entries).toHaveLength(1)
  })

  it('marketDetailAsync：坏 repo 形状 → 明确错误', async () => {
    for (const repo of ['', 'not-a-repo', 'a//b', 42]) {
      const r = await marketDetailAsync({ repo })
      expect(r.ok, String(repo)).toBe(false)
      expect(r.error, String(repo)).toContain('repo')
    }
  })

  it('marketDetailAsync：ref 缺省回退 main；非法 ref（含空格 / 含 ..）同样回退 main', async () => {
    const seen = []
    globalThis.fetch = async (url) => {
      seen.push(String(url))
      return { ok: false, status: 404, text: async () => '' }
    }
    // 每个子案用不同 repo：404 是确定性结论会写详情缓存，同 repo 的后续调用命中缓存不再发请求
    const r1 = await marketDetailAsync({ repo: 'o/r1', sources: ['github'] }) // 未传 ref
    expect(r1.ok).toBe(true)
    expect(r1.entry.ref).toBe('main')
    expect(seen.some((u) => u.includes('/o/r1/main/'))).toBe(true)
    seen.length = 0
    const r2 = await marketDetailAsync({ repo: 'o/r2', ref: 'bad ref', sources: ['github'] })
    expect(r2.ok).toBe(true)
    expect(r2.entry.ref).toBe('main')
    expect(seen.some((u) => u.includes('/main/'))).toBe(true)
    expect(seen.some((u) => u.includes('/bad%20ref/') || u.includes('/bad ref/'))).toBe(false)
    seen.length = 0
    const r3 = await marketDetailAsync({ repo: 'o/r3', ref: 'x..y', sources: ['github'] })
    expect(r3.entry.ref).toBe('main')
    expect(seen.some((u) => u.includes('/main/'))).toBe(true)
  })
})
