// test/market.test.mjs — 市场：参数净化 / 候选 URL / README 提取 / 包名推导
import { describe, it, expect } from 'vitest'
import {
  sanitizeTopic, sanitizeMarketParams, candidatesFromSources, apiSearchUrls, rawFileUrls,
  looksLikeNav, extractIntro, extractInstall, packIdOf, buildGithubPluginPack, hostOf,
} from '../lib/core/market.js'

describe('sanitizeTopic / sanitizeMarketParams', () => {
  it('合法 topic（含逗号/空格分隔，最多 4 个）', () => {
    expect(sanitizeTopic('dsh-plugin')).toBe('dsh-plugin')
    expect(sanitizeTopic('a,b c')).toBe('a b c')
    expect(sanitizeTopic('a,b,c,d,e')).toBeNull()
    expect(sanitizeTopic('')).toBeNull()
    expect(sanitizeTopic('a b!')).toBeNull()
    expect(sanitizeTopic(42)).toBeNull()
  })

  it('params 净化：默认 topic/page/sources', () => {
    const r = sanitizeMarketParams({})
    expect(r.ok).toBe(true)
    expect(r.topic).toBe('dsh-plugin')
    expect(r.page).toBe(1)
    expect(r.sources).toContain('github')
    expect(r.sources.length).toBe(7) // 官方 + 6 镜像
  })

  it('sources 白名单：未知来源丢弃；空 → 默认全量', () => {
    const r = sanitizeMarketParams({ sources: ['github', 'evil.example.com', 'ghfast.top'] })
    expect(r.sources).toEqual(['github', 'ghfast.top'])
    const r2 = sanitizeMarketParams({ sources: ['evil.example.com'] })
    expect(r2.sources.length).toBe(7)
  })

  it('旧单值 source 兼容：github / mirror', () => {
    expect(sanitizeMarketParams({ source: 'github' }).sources).toEqual(['github'])
    const m = sanitizeMarketParams({ source: 'mirror' })
    expect(m.sources).not.toContain('github')
    expect(m.sources.length).toBe(6)
  })

  it('topic 非法 → 明确错误', () => {
    const r = sanitizeMarketParams({ topic: 'x'.repeat(33) })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('topic')
  })
})

describe('URL 构造', () => {
  it('candidatesFromSources：官方原样 + 镜像前缀', () => {
    const urls = candidatesFromSources(['github', 'ghfast.top'], 'https://api.github.com/x')
    expect(urls).toEqual(['https://api.github.com/x', 'https://ghfast.top/https://api.github.com/x'])
  })

  it('apiSearchUrls / rawFileUrls 编码安全', () => {
    const u = apiSearchUrls('dsh-plugin', '检索词', 2, ['github'])
    expect(u[0]).toContain('q=topic%3Adsh-plugin')
    expect(u[0]).toContain('page=2')
    const raw = rawFileUrls('o/r', 'feature/x', 'README.md', ['github'])
    expect(raw[0]).toBe('https://raw.githubusercontent.com/o/r/feature/x/README.md')
  })

  it('hostOf', () => {
    expect(hostOf('https://ghfast.top/x')).toBe('ghfast.top')
    expect(hostOf('bad')).toBe('')
  })
})

describe('README 提取', () => {
  it('extractIntro：跳过头条与导航段，取首个正文段落（≤280 截断）', () => {
    const text = '# Title\n\n[English](README.md) 中文\n\n这是真正的介绍。第二句。\n\n# 安装\n...'
    expect(extractIntro(text)).toContain('这是真正的介绍')
    expect(extractIntro('')).toBe('')
    const long = '# T\n\n' + 'x'.repeat(300)
    expect(extractIntro(long).length).toBe(281) // 280 + …
  })

  it('extractInstall：取安装节（中英文标题），去代码围栏', () => {
    const text = '# T\n\n## 安装\n```bash\nnpm i x\n```\n\n## 使用\n```\ncmd\n```\n'
    const out = extractInstall(text)
    expect(out).toContain('npm i x')
    expect(out).not.toContain('```')
    expect(extractInstall('no heading')).toBe('')
  })

  it('looksLikeNav：语言切换短段判为导航', () => {
    expect(looksLikeNav('[English](README.md) 中文')).toBe(true)
    expect(looksLikeNav('这是一段足够长的普通介绍文字，超过三十个字符的阈值，因此不会被误判为导航')).toBe(false)
  })
})

describe('packIdOf / buildGithubPluginPack', () => {
  it('packIdOf：owner/repo → pack.<owner>-<repo>-<hash>（单射、≤64、无碰撞）', () => {
    const id = packIdOf('ARFCON/dsh-hotplug-hub')
    expect(id.startsWith('pack.arfcon-dsh-hotplug-hub-')).toBe(true)
    expect(id.length).toBeLessThanOrEqual(64)
    expect(packIdOf('a/b').startsWith('pack.a-b-')).toBe(true)
    expect(packIdOf('x'.repeat(80) + '/y').length).toBeLessThanOrEqual(64)
    // 审计修复：'/'→'-' 有损曾使不同仓库同 id（a-b/c 与 a/b-c → pack.a-b-c），现单射
    expect(packIdOf('a-b/c')).not.toBe(packIdOf('a/b-c'))
    expect(packIdOf('a.b/c')).not.toBe(packIdOf('a/b.c'))
    // 确定性：同输入同 id（跨导入稳定）
    expect(packIdOf('o/r')).toBe(packIdOf('o/r'))
  })

  it('buildGithubPluginPack：非法 semver 版本兜底 0.0.0（1.02.3 / 1.2.3-a..b 不再放行）', () => {
    // 审计修复：旧正则放行 '1.02.3'/'1.2.3-a..b' 后 parseHotpack 拒收 → importable=false；
    // 现严格 semver 校验，非法版本统一兜底 0.0.0
    for (const bad of ['1.02.3', '01.2.3', '1.2.3-a..b']) {
      const r = buildGithubPluginPack('o/r', 'main', 'pkg-x', bad, {})
      expect(r.ok, bad).toBe(true)
      expect(r.pack.version, bad).toBe('0.0.0')
    }
    const ok = buildGithubPluginPack('o/r', 'main', 'pkg-x', '1.2.3', {})
    expect(ok.ok).toBe(true)
    expect(ok.pack.version).toBe('1.2.3')
  })

  it('buildGithubPluginPack：单插件 manifest（tags 去重截断）', () => {
    const r = buildGithubPluginPack('o/r', 'main', 'pkg-x', '1.2.3', { name: 'R', description: 'd', topics: ['t1', 't1', 't2'] })
    expect(r.ok).toBe(true)
    expect(r.pack.plugins[0].source).toEqual({ type: 'github', repo: 'o/r', ref: 'main' })
    expect(r.pack.tags).toEqual(['t1', 't2'])
    // 非法版本兜底 0.0.0
    const r2 = buildGithubPluginPack('o/r', 'main', 'pkg-x', 'latest', {})
    expect(r2.ok).toBe(true)
    expect(r2.pack.version).toBe('0.0.0')
  })
})
