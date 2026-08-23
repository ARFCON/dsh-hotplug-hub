/**
 * lib/core/market.js — 插件包市场（真实数据源）（v5 阶段 3 自 index.js 拆出）
 *
 * 联网抓取只读公开元数据（GitHub 搜索 JSON / raw README / package.json），
 * 不携带任何凭据。
 * 安全审计修复（v5 阶段 5）：曾存在 node:https 直连兜底且 rejectUnauthorized:false
 * （"兼容本地根 CA 拦截环境"）——TLS 校验不可静默关闭（共享契约铁律）；该层已删除。
 * 抓取链现为：全局 fetch（默认校验）→ curl（schannel/系统 CA 校验）。企业 MITM 等
 * 需自定义 CA 的环境请经系统证书库 / NODE_EXTRA_CA_CERTS 配置，而非关闭校验。
 */
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import {
  MARKET_CACHE_FILE, MARKET_DETAIL_CACHE_FILE, MARKET_DETAIL_CONCURRENCY, MARKET_FILE_BUDGET_MS,
  MARKET_FILE_TIMEOUT_MS, MARKET_PAGE_SIZE, MARKET_PACK_CANDIDATES, MARKET_README_CANDIDATES,
  MARKET_TIMEOUT_MS, SOURCE_GITHUB, GITHUB_MIRRORS, VERSION, IS_WIN, CURL_BIN,
} from './paths.js'
import { readJson, writeJsonSafe } from './state.js'
import { runCli } from './run-cli.js'
import { parseHotpack, dshpackToHotpack } from './hotpack.js'
import { validateSourceRef, validateSourceRepo, validateVersion } from '../../vendor-shared/index.mjs'

export function sanitizeTopic(topic) {
  if (typeof topic !== 'string') return null
  const tokens = topic.split(/[,，\s]+/).map((s) => s.trim()).filter((s) => s !== '')
  if (tokens.length === 0 || tokens.length > 4) return null
  for (const token of tokens) {
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(token)) return null
  }
  return tokens.join(' ')
}

export function sanitizeMarketParams(params) {
  const p = params && typeof params === 'object' ? params : {}
  const topic = sanitizeTopic(p.topic ?? 'dsh-plugin')
  if (topic === null) return { ok: false, error: 'topic 只能是标签字符串（字母数字 . _ -，最长 32 字符，最多 4 个，逗号/空格分隔）' }
  const q = typeof p.q === 'string' ? p.q.trim().slice(0, 80) : ''
  const page = Math.min(Math.max(parseInt(String(p.page), 10) || 1, 1), 10)
  // 多选来源：sources = ['github', 'ghfast.top', 'gh-proxy.com', ...]；兼容旧单值 source(auto/github/mirror)
  const mirrorHosts = new Set(GITHUB_MIRRORS.map((m) => m.replace(/^https?:\/\//, '').replace(/\/+$/, '')))
  let sources = []
  if (Array.isArray(p.sources)) {
    for (const s of p.sources) {
      const v = String(s).trim()
      if (v === SOURCE_GITHUB) sources.push(SOURCE_GITHUB)
      else if (mirrorHosts.has(v)) sources.push(v)
    }
  } else if (p.source === 'github') {
    sources = [SOURCE_GITHUB]
  } else if (p.source === 'mirror') {
    sources = [...mirrorHosts]
  }
  if (sources.length === 0) sources = [SOURCE_GITHUB, ...mirrorHosts] // 默认：官方 + 全部镜像
  return { ok: true, topic, q, sources, page, refresh: p.refresh === true }
}

/**
 * GET 文本，双层兜底，只用于市场公开只读抓取（全程 TLS 校验，契约铁律）：
 *  1) 运行时全局 fetch（默认证书校验；DSH 应用进程通常已配置系统 CA / 代理）
 *  2) curl 兜底（schannel/系统 CA 校验）
 */
export async function httpGet(url, timeoutMs = MARKET_TIMEOUT_MS, extraHeaders = {}) {
  const headers = { 'User-Agent': 'dsh-hotplug-hub/' + VERSION, ...extraHeaders }
  if (typeof fetch === 'function') {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers })
      if (res.ok) return { ok: true, status: res.status, text: await res.text() }
      return { ok: false, status: res.status, text: '' }
    } catch {
      // 网络 / TLS 失败 → 继续尝试 curl
    } finally {
      clearTimeout(timer)
    }
  }
  const args = ['-fsSL', '--max-time', String(Math.ceil(timeoutMs / 1000)), '--retry', '1']
  if (IS_WIN) args.splice(1, 0, '--ssl-no-revoke')
  args.push(url)
  const result = await runCli(CURL_BIN, args, timeoutMs + 5000, { cwd: tmpdir() })
  if (result.code === 0 && result.stdout !== '') return { ok: true, status: 200, text: result.stdout }
  return { ok: false, status: 0, text: '' }
}

/** 从成功响应的 url 提取域名（如 api.github.com / ghfast.top），用作"来源"展示。 */
export function hostOf(url) {
  try { return new URL(url).host } catch { return '' }
}

/**
 * 多通道竞速：官方与镜像 URL 同时发起请求，取第一个成功响应（"哪个快用哪个"）。
 * 仅用于市场检索（searchMarketRepos）等公开只读抓取；不改变 404 短路语义。
 */
export async function raceFetch(urls, timeoutMs = MARKET_TIMEOUT_MS, extraHeaders = {}, budgetMs = 0) {
  if (!Array.isArray(urls) || urls.length === 0) return { ok: false, text: '' }
  if (budgetMs > 0) {
    const budget = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, status: 0, text: '', budget: true }), budgetMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    return Promise.race([raceFetch(urls, timeoutMs, extraHeaders, 0), budget])
  }
  return new Promise((resolve) => {
    let settled = false
    let failures = 0
    for (const url of urls) {
      httpGet(url, timeoutMs, extraHeaders).then((res) => {
        if (settled) return
        if (res.ok) { settled = true; resolve({ ...res, url, raced: true }); return }
        failures += 1
        if (failures === urls.length) resolve({ ok: false, status: res.status, url, text: '' })
      }).catch(() => {
        if (settled) return
        failures += 1
        if (failures === urls.length) resolve({ ok: false, status: 0, url, text: '' })
      })
    }
  })
}

/**
 * 按候选 URL（README/package.json/hotpack 等原始文件）全并发测速，取第一个「确定性结论」。
 * 确定性结论 = 成功(200) 或 明确不存在(404/403/410)。
 * 这样文件存在→官方 200 立即返回（最快通道获胜）；文件不存在→官方 404 立即跳过该候选，
 * 不会因某些镜像通道 curl 挂起而空等 ~30s（这是市场加载慢的根因）。
 * 仅当通道普遍是「网络失败」（fetch/https/curl 全抛错，无 HTTP 状态）时才等全部通道结算兜底。
 */
export async function raceFiles(urls, timeoutMs, extraHeaders, budgetMs = 0) {
  if (!Array.isArray(urls) || urls.length === 0) return { ok: false, status: 0, text: '' }
  // 总预算：到期立即结算当前最优结果，防止某镜像通道的 curl 兜底挂满拖慢整页
  if (budgetMs > 0) {
    const budget = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, status: 0, text: '', budget: true }), budgetMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    return Promise.race([raceFiles(urls, timeoutMs, extraHeaders, 0), budget])
  }
  return new Promise((resolve) => {
    let settled = false
    let failures = 0
    let firstFail = null
    const done = (res) => { if (!settled) { settled = true; resolve(res) } }
    for (const url of urls) {
      httpGet(url, timeoutMs, extraHeaders).then((res) => {
        if (settled) return
        if (res.ok) { done({ ...res, url, raced: true }); return }
        // 确定性「不存在」→ 立即结算，不空等镜像。仅 404/403/410 视为确定性；
        // 429（限流）/400/401 等非「不存在」不得提前结算，否则会丢弃镜像的合法 200。
        if (res.status === 404 || res.status === 403 || res.status === 410) { done({ ...res, url, raced: false }); return }
        if (!firstFail) firstFail = res
        failures += 1
        if (failures === urls.length) done({ ok: false, status: firstFail ? firstFail.status : 0, url: firstFail ? firstFail.url : '', text: '' })
      }).catch(() => {
        if (settled) return
        failures += 1
        if (failures === urls.length) done({ ok: false, status: firstFail ? firstFail.status : 0, url: firstFail ? firstFail.url : '', text: '' })
      })
    }
  })
}

/** 把「来源集合」（['github', 'ghfast.top', ...]）映射为候选 URL 列表；github 指官方原始 URL。 */
export function candidatesFromSources(sources, officialUrl) {
  const out = []
  for (const s of sources) {
    if (s === SOURCE_GITHUB) {
      out.push(officialUrl)
    } else {
      const host = String(s).replace(/^https?:\/\//, '').replace(/\/+$/, '')
      out.push('https://' + host + '/' + officialUrl)
    }
  }
  return out
}

export function apiSearchUrls(topic, q, page, sources) {
  const topicQuery = topic.split(' ').map((t) => 'topic:' + t).join(' ')
  const query = 'q=' + encodeURIComponent(topicQuery) + (q !== '' ? '+' + encodeURIComponent(q) : '') +
    '&sort=stars&order=desc&per_page=' + MARKET_PAGE_SIZE + '&page=' + page
  return candidatesFromSources(sources, 'https://api.github.com/search/repositories?' + query)
}

export function rawFileUrls(repo, ref, path, sources) {
  return candidatesFromSources(sources, 'https://raw.githubusercontent.com/' + repo + '/' + ref + '/' + path)
}

export async function searchMarketRepos(topic, q, page, sources) {
  // 选中的来源通道同时发起，取第一个成功响应（"哪个快用哪个"）
  const res = await raceFetch(apiSearchUrls(topic, q, page, sources), 20000, { Accept: 'application/vnd.github+json' }, 15000)
  // 审计修复：原 'HTTP ' + (res.status ?? 0) || '网络请求失败' 因 + 优先级高于 ||，
  // 后半段为永不可达死代码，网络失败（status=0）时错误地显示 "HTTP 0"。
  if (!res.ok) return { ok: false, error: res.status ? 'HTTP ' + res.status : '网络请求失败' }
  try {
    const json = JSON.parse(res.text)
    if (!Array.isArray(json.items)) return { ok: false, error: json.message ?? '响应结构异常' }
    const items = json.items
      .filter((item) => item.fork !== true)
      .slice(0, MARKET_PAGE_SIZE)
      .map((item) => ({
        repo: item.full_name,
        ref: item.default_branch ?? 'main',
        name: item.name,
        author: (item.owner && item.owner.login) || String(item.full_name || '').split('/')[0],
        stars: item.stargazers_count ?? 0,
        forks: item.forks_count ?? 0,
        license: (item.license && item.license.spdx_id) || '',
        description: item.description ?? '',
        topics: Array.isArray(item.topics) ? item.topics.slice(0, 12) : [],
        updatedAt: item.updated_at ?? '',
      }))
    return { ok: true, total: json.total_count ?? items.length, items, url: res.url, fetchedVia: hostOf(res.url) }
  } catch (error) {
    return { ok: false, error: String(error.message ?? error) }
  }
}

/** 语言切换 / 导航类短段（如 "[English](README.md) 中文"），不作为介绍。 */
export function looksLikeNav(para) {
  const t = para.replace(/<[^>]+>/g, ' ').replace(/\[[^\]]*\]\([^)]*\)/g, ' ').replace(/[|·\-—=>]/g, ' ').replace(/\s+/g, ' ').trim()
  if (t === '' || t.length >= 30) return false
  return /English|中文|한국어|日本語|简体|繁體|Deutsch|Français|Español/i.test(t)
}

export function extractIntro(readmeText) {
  const text = String(readmeText ?? '').replace(/^\uFEFF/, '')
  const body = text.replace(/^#{1,6}\s+.*$/m, '').trim()
  const paras = body.split(/\n\s*\n/).map((s) => s.trim()).filter((s) => s !== '')
  const clean = (p) => p
    .replace(/<[^>]+>/g, ' ')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#*_`>[\]|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  for (const p of paras) {
    const t = clean(p)
    if (t === '' || looksLikeNav(p)) continue
    return t.length > 280 ? t.slice(0, 280) + '…' : t
  }
  for (const p of paras) {
    const t = clean(p)
    if (t !== '') return t.length > 280 ? t.slice(0, 280) + '…' : t
  }
  return ''
}

export function extractInstall(readmeText) {
  const text = String(readmeText ?? '')
  const lines = text.split('\n')
  const headingRe = /^#{2,4}\s*(安装|安装方法|安装与使用|Installation|Quick Start|快速开始|使用|Usage|Getting Started)/i
  const start = lines.findIndex((line) => headingRe.test(line))
  if (start === -1) return ''
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^#{1,6}\s+/.test(line)) break
    out.push(line)
  }
  const block = out.join('\n').replace(/```/g, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+\n/g, '\n').trim()
  return block.length > 1200 ? block.slice(0, 1200) + '\n…' : block
}

/**
 * 由仓库 owner/repo 派生包 id（`pack.<owner>-<repo>` + 8 位 sha1 短哈希后缀）。
 * 审计修复：'/'→'-' 有损——`a-b/c` 与 `a/b-c` 清洗后同为 `pack.a-b-c`，不同仓库共享
 * 一个 id（用作 packs/<id> 磁盘目录与身份键），导入即互相覆盖。追加由原 repo 派生的
 * 短哈希使映射单射（哈希随 repo 稳定，跨导入一致；PACK_ID_RE 上限 64 满足）。
 * @param {string} repo owner/repo
 * @returns {string} 包 id（≤64）
 */
export function packIdOf(repo) {
  const s = String(repo).toLowerCase()
  const base = ('pack.' + s).replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  const digest = createHash('sha1').update(s).digest('hex').slice(0, 8)
  const head = base.length <= 55 ? base : base.slice(0, 55)
  return `${head}-${digest}`
}

/** 单插件 github 源 manifest：有 package.json 但仓库本身不是包集合时兜底生成。 */
export function buildGithubPluginPack(repo, ref, npmName, version, meta) {
  const tags = [...new Set([...(meta.topics ?? []), ...(meta.keywords ?? [])])].slice(0, 12).map((t) => String(t).slice(0, 24))
  return parseHotpack(JSON.stringify({
    hotpack: '1.0',
    id: packIdOf(repo),
    name: meta.name ?? repo,
    version: typeof version === 'string' && validateVersion(version).ok ? version : '0.0.0',
    description: (meta.description ?? '').slice(0, 300),
    tags,
    plugins: [{ id: 'main', name: npmName, source: { type: 'github', repo, ref } }],
  }))
}

export async function fetchRepoDetailFiles(repo, ref, sources) {
  const raw = (name) => rawFileUrls(repo, ref, name, sources)
  // 取「第一个成功」的候选（如 README 列表里第一个命中的文件），立即结算，不等其余候选；
  // 所有候选并行发起、受总预算约束（到期立即返回 null，防慢镜像 curl 兜底挂满）。
  // 上游 v0.9.7 对齐：不再做独立存活探测——raw 通道的确定性 404 + 总预算即可快速结算。
  const fetchFirstOk = (candidateNames, budgetMs) => {
    return new Promise((resolve) => {
      let settled = false
      const done = (value) => { if (!settled) { settled = true; resolve(value) } }
      const budget = setTimeout(() => done(null), budgetMs)
      if (typeof budget.unref === 'function') budget.unref()
      let pending = candidateNames.length
      for (const name of candidateNames) {
        raceFiles(raw(name), MARKET_FILE_TIMEOUT_MS, undefined, budgetMs).then((res) => {
          if (settled) return
          if (res.ok) { done({ name, res }); return }
          pending -= 1
          if (pending === 0) done(null)
        })
      }
    })
  }
  // 三路文件抓取并行：包清单（hotpack/.dshpack）· package.json · README（候选对比）。
  const packScanTask = (async () => {
    const hit = await fetchFirstOk(MARKET_PACK_CANDIDATES, MARKET_FILE_BUDGET_MS)
    if (!hit) return null
    const parsed = hit.name === 'hotpack.json' ? parseHotpack(hit.res.text) : dshpackToHotpack(hit.res.text)
    return parsed.ok ? { name: hit.name, pack: parsed.pack } : null
  })()
  const pkgResTask = raceFiles(raw('package.json'), MARKET_FILE_TIMEOUT_MS, undefined, MARKET_FILE_BUDGET_MS)
  const readmeScanTask = (async () => {
    const hit = await fetchFirstOk(MARKET_README_CANDIDATES, MARKET_FILE_BUDGET_MS)
    if (!hit) return null
    return { name: hit.name, text: hit.res.text, url: hit.res.url }
  })()
  const [packScan, pkgRes, readmeScan] = await Promise.all([
    packScanTask,
    pkgResTask,
    readmeScanTask,
  ])
  return { alive: true, packScan, pkgRes, readmeScan }
}

export function applyRepoDetailFiles(entry, files, repo, ref) {
  const { packScan, pkgRes, readmeScan } = files
  // 1) 包 manifest：repo 本身就是包集合 → 直接作为导入对象
  if (packScan) {
    entry.hasPack = true
    entry.packKind = packScan.name
    entry.manifest = packScan.pack
    entry.version = packScan.pack.version
    if (!entry.npmName && packScan.pack.plugins[0]) entry.npmName = packScan.pack.plugins[0].name
  }
  // 2) package.json：取 npm 包名与版本（对比文件之一）
  if (pkgRes && pkgRes.ok) {
    try {
      const pkg = JSON.parse(pkgRes.text)
      if (typeof pkg.name === 'string') entry.npmName = entry.npmName ?? pkg.name
      if (typeof pkg.version === 'string') entry.version = entry.version ?? pkg.version
    } catch { /* 有意吞掉：package.json 解析失败不影响其他候选文件 */ }
  }
  // 3) README：提取介绍（首段）与安装方法（## 安装 / Installation / 快速开始 等小节）
  if (readmeScan) {
    entry.readmeUrl = 'https://github.com/' + repo + '/blob/' + ref + '/' + readmeScan.name
    entry.intro = extractIntro(readmeScan.text)
    entry.install = extractInstall(readmeScan.text)
  }
  // 4) 兜底生成单插件 manifest（github 源由中枢下载 + link，不跑脚本）
  if (!entry.manifest) {
    if (entry.npmName) {
      const built = buildGithubPluginPack(repo, ref, entry.npmName, entry.version, {
        name: entry.name, description: entry.description, topics: entry.topics,
      })
      if (built.ok) entry.manifest = built.pack
      else { entry.importable = false; entry.importError = built.error }
    } else {
      entry.importable = false
      entry.importError = '未找到 package.json 或 hotpack/.dshpack 清单，无法生成导入包'
    }
  }
  return entry
}

export async function fetchRepoDetail(repo, ref, meta, sources) {
  const entry = {
    id: packIdOf(repo),
    repo,
    ref,
    repoUrl: 'https://github.com/' + repo,
    name: meta.name || String(repo).split('/')[1],
    author: meta.author,
    stars: meta.stars,
    forks: meta.forks,
    license: meta.license,
    description: meta.description,
    topics: meta.topics,
    updatedAt: meta.updatedAt,
    npmName: null,
    version: null,
    hasPack: false,
    packKind: null,
    intro: '',
    install: '',
    readmeUrl: null,
    importable: true,
    importError: null,
    manifest: null,
  }
  const files = await fetchRepoDetailFiles(repo, ref, sources)
  if (!files.alive) {
    entry.importable = false
    entry.importError = '仓库不存在或已被删除/改名'
    return entry
  }
  applyRepoDetailFiles(entry, files, repo, ref)
  return entry
}

/** 搜索结果的「列表元数据」条目：详情尚未抓取，由 marketDetail 逐条并发补齐（上游 v0.9.7 对齐）。 */
export function metaEntry(item) {
  return {
    id: packIdOf(item.repo),
    repo: item.repo,
    ref: item.ref,
    repoUrl: 'https://github.com/' + item.repo,
    name: item.name,
    author: item.author,
    stars: item.stars,
    forks: item.forks,
    license: item.license,
    description: item.description,
    topics: item.topics,
    updatedAt: item.updatedAt,
    detailPending: true,
    importable: false,
    importError: null,
    intro: '',
    install: '',
    readmeUrl: null,
    npmName: null,
    version: null,
    hasPack: false,
    packKind: null,
    manifest: null,
  }
}

/**
 * 市场列表：只做 GitHub 标签搜索并立即返回仓库元数据（快，不抓 README/package.json）。
 * 详情由 client 对每个条目并发调用 marketDetail，谁先返回谁先展示——不再等全部结算。
 */
export async function marketListAsync(params) {
  const valid = sanitizeMarketParams(params)
  if (!valid.ok) return { ok: false, error: valid.error }
  const cacheKey = valid.topic + '|' + valid.q + '|' + valid.sources.join(',') + '|' + valid.page
  if (!valid.refresh) {
    const cache = readJson(MARKET_CACHE_FILE())
    if (cache && cache.key === cacheKey && Array.isArray(cache.entries)) {
      return { ok: true, cached: true, cachedAt: cache.cachedAt, total: cache.total, page: cache.page, sources: cache.sources, fetchedVia: cache.fetchedVia, entries: cache.entries }
    }
  }
  const search = await searchMarketRepos(valid.topic, valid.q, valid.page, valid.sources)
  if (!search.ok) return { ok: false, error: search.error }
  const entries = search.items.map(metaEntry)
  const result = { ok: true, cached: false, cachedAt: null, total: search.total, page: valid.page, sources: valid.sources, fetchedVia: search.fetchedVia, entries }
  try {
    writeJsonSafe(MARKET_CACHE_FILE(), { key: cacheKey, ...result, cachedAt: new Date().toISOString() })
  } catch { /* 有意吞掉：尽力而为的清理/读取，失败不影响主流程 */ }
  return result
}

/** 单仓库详情：抓包清单 + package.json + README，生成 manifest；带独立缓存，命中秒回。 */
export async function marketDetailAsync(params) {
  const p = params && typeof params === 'object' ? params : {}
  const repo = typeof p.repo === 'string' ? p.repo.trim() : ''
  // 审计修复：改用 vendor-shared 权威校验（validateSourceRepo/validateSourceRef）——
  // 本地 REF_RE 曾不含 '/'（H-10 起 ref 允许 feature/x，default_branch 带 '/' 时被
  // 错误回退 main）、本地 REPO_RE 曾接受 '.foo/bar' / '-x/y' 等 shared 拒绝的非法 repo，
  // 造成契约漂移。现收敛到单一真源。
  if (!validateSourceRepo(repo).ok) return { ok: false, error: 'repo 必须是 owner/repo 格式' }
  const ref = typeof p.ref === 'string' && p.ref !== '' && validateSourceRef(p.ref).ok ? p.ref : 'main'
  const sources = sanitizeMarketParams({ sources: p.sources }).sources
  const cacheKey = repo + '@' + ref
  if (p.refresh !== true) {
    const cache = readJson(MARKET_DETAIL_CACHE_FILE())
    if (cache && cache[cacheKey] && typeof cache[cacheKey] === 'object') {
      return { ok: true, cached: true, entry: cache[cacheKey] }
    }
  }
  const meta = (p.meta && typeof p.meta === 'object') ? p.meta : {}
  const base = {
    repo,
    ref,
    repoUrl: 'https://github.com/' + repo,
    name: meta.name ?? String(repo).split('/')[1] ?? repo,
    author: meta.author ?? String(repo).split('/')[0],
    stars: meta.stars ?? 0,
    forks: meta.forks ?? 0,
    license: meta.license ?? '',
    description: meta.description ?? '',
    topics: meta.topics ?? [],
    updatedAt: meta.updatedAt ?? '',
  }
  let entry
  try {
    entry = await fetchRepoDetail(repo, ref, base, sources)
  } catch (error) {
    entry = {
      ...base,
      npmName: null, version: null, hasPack: false, packKind: null,
      intro: '', install: '', readmeUrl: null,
      importable: false, importError: String(error.message ?? error), manifest: null,
    }
  }
  try {
    const cache = readJson(MARKET_DETAIL_CACHE_FILE()) || {}
    cache[cacheKey] = entry
    const keys = Object.keys(cache)
    if (keys.length > 400) {
      for (const k of keys.slice(0, keys.length - 400)) delete cache[k]
    }
    writeJsonSafe(MARKET_DETAIL_CACHE_FILE(), cache)
  } catch { /* 有意吞掉：尽力而为的清理/读取，失败不影响主流程 */ }
  return { ok: true, cached: false, entry }
}
