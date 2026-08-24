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
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync, statSync, lstatSync, rmSync, readdirSync, copyFileSync,
} from 'node:fs'
import {
  MARKET_CACHE_FILE, MARKET_DETAIL_CACHE_FILE, MARKET_FILE_BUDGET_MS,
  MARKET_FILE_TIMEOUT_MS, MARKET_PAGE_SIZE, MARKET_PACK_CANDIDATES, MARKET_README_CANDIDATES,
  MARKET_TIMEOUT_MS, MARKET_MAX_PAGE, MARKET_CACHE_TTL_MS, MARKET_DETAIL_CACHE_TTL_MS,
  MARKET_MAX_BODY_CHARS, SOURCE_GITHUB, GITHUB_MIRRORS, VERSION, IS_WIN, CURL_BIN, hotplugRoot,
} from './paths.js'
import { readJson, writeJsonSafe } from './state.js'
import { runCli } from './run-cli.js'
import { parseHotpack, dshpackToHotpack } from './hotpack.js'
import {
  validateSourceRef, validateSourceRepo, validateVersion, acquireLock, releaseLock,
} from '../../vendor-shared/index.mjs'
import { join } from 'node:path'

// 跨进程缓存写锁端口（与 patch.js nodeFsPort 同源契约；detail 缓存是 read-modify-write，
// 须防两个 Node 宿主进程并发写同一 market-detail-cache.json 时互相覆盖丢条目）。
const fsPort = {
  readFileSync, writeFileSync, existsSync, mkdirSync, statSync, lstatSync, openSync,
  closeSync, fsyncSync, renameSync, unlinkSync, rmSync, readdirSync, copyFileSync,
}

/** 详情缓存写锁路径（<hotplug-hub>/market-detail-cache.lock；与 patch 四写者锁同协议）。 */
export function marketDetailLockPath() {
  return join(hotplugRoot(), 'market-detail-cache.lock')
}

export function sanitizeTopic(topic) {
  if (typeof topic !== 'string') return null
  const tokens = topic.split(/[,，\s]+/).map((s) => s.trim()).filter((s) => s !== '')
  if (tokens.length === 0 || tokens.length > 4) return null
  for (const token of tokens) {
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(token)) return null
  }
  return tokens.join(' ')
}

/**
 * 按「码点」截断字符串（审计修复）：`String.slice` 按 UTF-16 码元截断，会在代理对
 * （emoji 等增补平面字符）中间劈开，产生孤立高代理；随后 encodeURIComponent 对孤立
 * 代理抛 URIError，市场搜索（marketList）被用户查询词击穿崩溃。此处以码点为界，
 * 截断点永不落在代理对中间。
 * @param {string} s
 * @param {number} max 最大码点数
 * @returns {string}
 */
export function truncateCodePoints(s, max) {
  const str = String(s ?? '')
  if (str.length <= max) return str
  let end = 0
  let count = 0
  while (end < str.length && count < max) {
    const c = str.charCodeAt(end)
    end += (c >= 0xd800 && c <= 0xdbff && end + 1 < str.length) ? 2 : 1
    count += 1
  }
  return str.slice(0, end)
}

/**
 * 把孤立代理替换为 U+FFFD（审计修复）：截断只防「劈开」合法代理对，无法处理输入里
 * 已存在的孤立高/低代理——encodeURIComponent 仍会对孤立代理抛 URIError。Node 18 无
 * String.prototype.toWellFormed，故用等价正则（高代理后无低代理、低代理前无高代理）。
 * @param {string} s
 * @returns {string} 无孤立代理的良构字符串
 */
export function toWellFormed(s) {
  return String(s ?? '').replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD'
  )
}

export function sanitizeMarketParams(params) {
  const p = params && typeof params === 'object' ? params : {}
  // 审计修复：空串 / 纯空白 topic 回落默认（与 undefined 语义一致）——此前空串走
  // sanitizeTopic 报错，用户清空输入框点搜索得到错误而非默认标签，行为不一致。
  const topicRaw = typeof p.topic === 'string' && p.topic.trim() === '' ? undefined : p.topic
  const topic = sanitizeTopic(topicRaw ?? 'dsh-plugin')
  if (topic === null) return { ok: false, error: 'topic 只能是标签字符串（字母数字 . _ -，最长 32 字符，最多 4 个，逗号/空格分隔）' }
  const q = typeof p.q === 'string' ? truncateCodePoints(toWellFormed(p.q.trim()), 80) : ''
  const page = Math.min(Math.max(parseInt(String(p.page), 10) || 1, 1), MARKET_MAX_PAGE)
  // 多选来源：sources = ['github', 'ghfast.top', 'gh-proxy.com', ...]；兼容旧单值 source(auto/github/mirror)
  const mirrorHosts = new Set(GITHUB_MIRRORS.map((m) => m.replace(/^https?:\/\//, '').replace(/\/+$/, '')))
  const seen = new Set()
  let sources = []
  const push = (v) => { if (!seen.has(v)) { seen.add(v); sources.push(v) } }
  if (Array.isArray(p.sources)) {
    for (const s of p.sources) {
      const v = String(s).trim()
      if (v === SOURCE_GITHUB) push(SOURCE_GITHUB)
      else if (mirrorHosts.has(v)) push(v)
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
 * 审计修复（两通道行为对齐 + 败者取消）：
 *  - 响应体统一按 MARKET_MAX_BODY_CHARS 码点截断——此前 fetch 分支 res.text() 无上限
 *    （超大响应耗内存），curl 分支被 runCli OUTPUT_CAP=64KB 截断，同一 README 走不同
 *    通道得到不同结果（漂移）。
 *  - 新增 signal 参数：竞速结算后由胜者 abort 败者通道的 fetch（省连接与预算）。
 * @param {string} url
 * @param {number} timeoutMs
 * @param {object} extraHeaders
 * @param {AbortSignal} [signal] 外部取消信号（竞速败者取消）
 */
export async function httpGet(url, timeoutMs = MARKET_TIMEOUT_MS, extraHeaders = {}, signal = undefined) {
  const headers = { 'User-Agent': 'dsh-hotplug-hub/' + VERSION, ...extraHeaders }
  if (typeof fetch === 'function') {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    const onAbort = () => ctrl.abort()
    if (signal) {
      if (signal.aborted) ctrl.abort()
      else signal.addEventListener('abort', onAbort)
    }
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers })
      if (res.ok) return { ok: true, status: res.status, text: truncateCodePoints(await res.text(), MARKET_MAX_BODY_CHARS) }
      return { ok: false, status: res.status, text: '' }
    } catch {
      // 外部取消（竞速败者）→ 不再回落 curl（否则取消语义失效、curl 照跑）
      if (signal && signal.aborted) return { ok: false, status: 0, text: '', aborted: true }
      // 网络 / TLS 失败 → 继续尝试 curl
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }
  const args = ['-fsSL', '--max-time', String(Math.ceil(timeoutMs / 1000)), '--retry', '1']
  if (IS_WIN) args.splice(1, 0, '--ssl-no-revoke')
  // 审计修复：curl 兜底此前丢弃 extraHeaders（如搜索 API 的 Accept 头）与自定义 UA，
  // 与 fetch 分支行为不一致；现透传（header 值为常量/白名单，无用户输入，无注入面）。
  for (const [k, v] of Object.entries(headers)) {
    args.push('-H', `${k}: ${v}`)
  }
  args.push(url)
  const result = await runCli(CURL_BIN, args, timeoutMs + 5000, { cwd: tmpdir(), maxOutput: MARKET_MAX_BODY_CHARS })
  if (result.code === 0 && result.stdout !== '') return { ok: true, status: 200, text: truncateCodePoints(result.stdout, MARKET_MAX_BODY_CHARS) }
  return { ok: false, status: 0, text: '' }
}

/** 从成功响应的 url 提取域名（如 api.github.com / ghfast.top），用作"来源"展示。 */
export function hostOf(url) {
  try { return new URL(url).host } catch { return '' }
}

/**
 * 多通道竞速：官方与镜像 URL 同时发起请求，取第一个成功响应（"哪个快用哪个"）。
 * 仅用于市场检索（searchMarketRepos）等公开只读抓取；不改变 404 短路语义。
 * 审计修复（败者取消）：结算后 abort 其余通道的 fetch，不再空跑到各自超时。
 */
export async function raceFetch(urls, timeoutMs = MARKET_TIMEOUT_MS, extraHeaders = {}, budgetMs = 0, signal = undefined) {
  if (!Array.isArray(urls) || urls.length === 0) return { ok: false, text: '' }
  if (budgetMs > 0) {
    let budgetTimer = null
    // 审计修复（审查轮）：外部 signal 必须透传进内层竞速并在预算层联动——此前 budget
    // 包装丢弃 signal，fetchFirstOk 结算后的取消对主链路（详情文件抓取）完全空转。
    const ctrl = new AbortController()
    const budget = new Promise((resolve) => {
      budgetTimer = setTimeout(() => { ctrl.abort(); resolve({ ok: false, status: 0, text: '', budget: true }) }, budgetMs)
      if (typeof budgetTimer.unref === 'function') budgetTimer.unref()
    })
    if (signal) {
      if (signal.aborted) ctrl.abort()
      else signal.addEventListener('abort', () => ctrl.abort(), { once: true })
    }
    try {
      return await Promise.race([raceFetch(urls, timeoutMs, extraHeaders, 0, ctrl.signal), budget])
    } finally {
      clearTimeout(budgetTimer) // 胜出后预算 timer 不再悬挂
      ctrl.abort() // 内层竞速的败者取消（胜者已结算不受影响）
    }
  }
  return new Promise((resolve) => {
    let settled = false
    let failures = 0
    const ctrl = new AbortController()
    const finish = (value) => {
      if (settled) return
      settled = true
      ctrl.abort() // 取消败者通道（已结算的胜者不受影响）
      resolve(value)
    }
    if (signal) {
      if (signal.aborted) ctrl.abort()
      else signal.addEventListener('abort', () => ctrl.abort(), { once: true })
    }
    for (const url of urls) {
      httpGet(url, timeoutMs, extraHeaders, ctrl.signal).then((res) => {
        if (settled) return
        if (res.ok) { finish({ ...res, url, raced: true }); return }
        failures += 1
        if (failures === urls.length) finish({ ok: false, status: res.status, url, text: '' })
      }).catch(() => {
        if (settled) return
        failures += 1
        if (failures === urls.length) finish({ ok: false, status: 0, url, text: '' })
      })
    }
  })
}

/**
 * 按候选 URL（README/package.json/hotpack 等原始文件）全并发测速，取第一个「确定性结论」。
 * 确定性结论 = 成功(200) 或 明确不存在(404/410)。
 * 审计修复（403 语义）：403 从确定性列表移除——GitHub 未认证限流常以 403 返回
 * （与 429 同类），官方通道 403 时立即结算会丢弃镜像的合法 200（条目被误判
 * importable:false）。403 与 429/400/401 一样等全部通道结算兜底。
 * 文件不存在→官方 404 立即跳过该候选，不会因某些镜像通道 curl 挂起而空等 ~30s
 * （这是市场加载慢的根因）。结算后 abort 败者通道。
 */
export async function raceFiles(urls, timeoutMs, extraHeaders, budgetMs = 0, signal = undefined) {
  if (!Array.isArray(urls) || urls.length === 0) return { ok: false, status: 0, text: '' }
  // 总预算：到期立即结算当前最优结果，防止某镜像通道的 curl 兜底挂满拖慢整页
  if (budgetMs > 0) {
    let budgetTimer = null
    // 审计修复（审查轮）：同 raceFetch——外部 signal 透传 + 预算到期联动取消
    const ctrl = new AbortController()
    const budget = new Promise((resolve) => {
      budgetTimer = setTimeout(() => { ctrl.abort(); resolve({ ok: false, status: 0, text: '', budget: true }) }, budgetMs)
      if (typeof budgetTimer.unref === 'function') budgetTimer.unref()
    })
    if (signal) {
      if (signal.aborted) ctrl.abort()
      else signal.addEventListener('abort', () => ctrl.abort(), { once: true })
    }
    try {
      return await Promise.race([raceFiles(urls, timeoutMs, extraHeaders, 0, ctrl.signal), budget])
    } finally {
      clearTimeout(budgetTimer) // 胜出后预算 timer 不再悬挂
      ctrl.abort() // 内层竞速的败者取消（胜者已结算不受影响）
    }
  }
  return new Promise((resolve) => {
    let settled = false
    let failures = 0
    let firstFail = null
    const ctrl = new AbortController()
    const done = (res) => {
      if (settled) return
      settled = true
      ctrl.abort() // 取消败者通道
      resolve(res)
    }
    if (signal) {
      if (signal.aborted) ctrl.abort()
      else signal.addEventListener('abort', () => ctrl.abort(), { once: true })
    }
    for (const url of urls) {
      httpGet(url, timeoutMs, extraHeaders, ctrl.signal).then((res) => {
        if (settled) return
        if (res.ok) { done({ ...res, url, raced: true }); return }
        // 确定性「不存在」→ 立即结算，不空等镜像。仅 404/410 视为确定性；
        // 403（限流/封禁）/429/400/401 等非「不存在」不得提前结算，否则会丢弃镜像的合法 200。
        if (res.status === 404 || res.status === 410) { done({ ...res, url, raced: false }); return }
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

/** 把「来源集合」（['github', 'ghfast.top', ...]）映射为候选 URL 列表；github 指官方原始 URL。
 * 审计修复：输入去重——重复来源（如 ['github','github']）会产生重复候选 URL（双倍请求）；
 * sanitizeMarketParams 已去重，此处兜底保证导出函数直接调用时同样无重复。 */
export function candidatesFromSources(sources, officialUrl) {
  const seen = new Set()
  const out = []
  for (const s of sources) {
    const v = s === SOURCE_GITHUB ? SOURCE_GITHUB : String(s).replace(/^https?:\/\//, '').replace(/\/+$/, '')
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v === SOURCE_GITHUB ? officialUrl : 'https://' + v + '/' + officialUrl)
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
    const rawPageCount = json.items.length
    const items = json.items
      .filter((item) => item.fork !== true)
      .slice(0, MARKET_PAGE_SIZE)
      .map((item) => ({
        repo: item.full_name,
        ref: item.default_branch ?? 'main',
        // 审计修复：name 兜底——GitHub item.name 缺失时条目 name 为 undefined，
        // UI 渲染空白、marketEntryInstalled 比对失真；回落 owner/repo。
        name: item.name ?? item.full_name,
        author: (item.owner && item.owner.login) || String(item.full_name || '').split('/')[0],
        stars: item.stargazers_count ?? 0,
        forks: item.forks_count ?? 0,
        license: (item.license && item.license.spdx_id) || '',
        description: item.description ?? '',
        topics: Array.isArray(item.topics) ? item.topics.slice(0, 12) : [],
        updatedAt: item.updated_at ?? '',
      }))
    return { ok: true, total: json.total_count ?? items.length, rawPageCount, items, url: res.url, fetchedVia: hostOf(res.url) }
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
  const text = String(readmeText ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
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
  // 审计修复：CRLF 归一化为 LF——此前 split('\n') 后每行残留 '\r'，安装块输出含 \r\n。
  const text = String(readmeText ?? '').replace(/\r\n/g, '\n')
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
  // 审计修复：budget/done 后清理 timer 并 abort 全部候选的竞速（败者不空跑）。
  const fetchFirstOk = (candidateNames, budgetMs) => {
    return new Promise((resolve) => {
      let settled = false
      const ctrl = new AbortController()
      const done = (value) => {
        if (settled) return
        settled = true
        clearTimeout(budget)
        ctrl.abort()
        resolve(value)
      }
      const budget = setTimeout(() => done(null), budgetMs)
      if (typeof budget.unref === 'function') budget.unref()
      let pending = candidateNames.length
      for (const name of candidateNames) {
        raceFiles(raw(name), MARKET_FILE_TIMEOUT_MS, undefined, budgetMs, ctrl.signal).then((res) => {
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
  return { packScan, pkgRes, readmeScan }
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
  // 审计修复：删除死代码——fetchRepoDetailFiles 恒返回 {packScan,pkgRes,readmeScan}，
  // 曾经的 alive 存活探测（v0.9.7 已移除）遗留 `if (!files.alive)` 恒为 false；
  // 仓库不存在的真实判定由 applyRepoDetailFiles 兜底（无清单 → importable:false）。
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
    name: item.name ?? item.repo,
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
 * 审计修复（hasMore 契约）：此前客户端只能拿 total（GitHub total_count 动辄上千）
 * 与本地 entries.length 比对判断「加载更多」——page 被 clamp 到 MARKET_MAX_PAGE 后
 * 永远拿回末页重复数据，按钮永不消失。现由服务端给出权威 hasMore：
 *   hasMore = 本页满页 && page < MARKET_MAX_PAGE（结果耗尽 / 达到分页上限都是 false）。
 * 审计修复（TTL）：列表缓存此前只按 key 命中、无过期；cachedAt 超过
 * MARKET_CACHE_TTL_MS 视为 miss 重抓（用户手动刷新仍走 refresh 直抓）。
 */
export async function marketListAsync(params) {
  const valid = sanitizeMarketParams(params)
  if (!valid.ok) return { ok: false, error: valid.error }
  const cacheKey = valid.topic + '|' + valid.q + '|' + valid.sources.join(',') + '|' + valid.page
  if (!valid.refresh) {
    const cache = readJson(MARKET_CACHE_FILE())
    const fresh = cache && cache.key === cacheKey && Array.isArray(cache.entries)
      && typeof cache.cachedAt === 'string'
      && (Date.now() - Date.parse(cache.cachedAt)) < MARKET_CACHE_TTL_MS
    if (fresh) {
      return { ok: true, cached: true, cachedAt: cache.cachedAt, total: cache.total, page: cache.page, sources: cache.sources, fetchedVia: cache.fetchedVia, hasMore: cache.hasMore === true, entries: cache.entries }
    }
  }
  const search = await searchMarketRepos(valid.topic, valid.q, valid.page, valid.sources)
  if (!search.ok) return { ok: false, error: search.error }
  const entries = search.items.map(metaEntry)
  // 审计修复（审查轮）：满页判定用 fork 过滤前的原始页计数——某页 10 条含 fork 时
  // 过滤后 <10 会让 hasMore 误报 false（按钮提前消失，仍有剩余结果）。
  const hasMore = (search.rawPageCount ?? entries.length) >= MARKET_PAGE_SIZE && valid.page < MARKET_MAX_PAGE
  const result = { ok: true, cached: false, cachedAt: null, total: search.total, page: valid.page, sources: valid.sources, fetchedVia: search.fetchedVia, hasMore, entries }
  try {
    writeJsonSafe(MARKET_CACHE_FILE(), { key: cacheKey, ...result, cachedAt: new Date().toISOString() })
  } catch { /* 有意吞掉：尽力而为的清理/读取，失败不影响主流程 */ }
  return result
}

/** 净化客户端传入的 meta（marketDetail params.meta）：类型白名单 + 长度上限。
 * 审计修复：此前未净化直接进 entry 与缓存——stars 可为对象（UI typeof 判断静默不显示）、
 * 字符串无上限（缓存可被撑大）。净化只影响展示元数据，manifest 仍由抓取文件权威生成。 */
export function sanitizeDetailMeta(meta) {
  const str = (v, max) => (typeof v === 'string' ? truncateCodePoints(toWellFormed(v.trim()), max) : '')
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    name: str(meta.name, 120),
    author: str(meta.author, 80),
    stars: num(meta.stars),
    forks: num(meta.forks),
    license: str(meta.license, 40),
    description: str(meta.description, 300),
    topics: Array.isArray(meta.topics)
      ? meta.topics.filter((t) => typeof t === 'string').slice(0, 12).map((t) => truncateCodePoints(toWellFormed(t), 24))
      : [],
    updatedAt: str(meta.updatedAt, 40),
  }
}

/** 详情缓存条目是否仍在 TTL 内（新格式 {at, entry}；旧格式（裸 entry，无 at）视为过期重抓）。 */
function detailCacheEntryFresh(slot) {
  if (!slot || typeof slot !== 'object' || typeof slot.at !== 'string' || !slot.entry) return false
  const age = Date.now() - Date.parse(slot.at)
  return Number.isFinite(age) && age >= 0 && age < MARKET_DETAIL_CACHE_TTL_MS
}

/**
 * 单仓库详情：抓包清单 + package.json + README，生成 manifest；带独立缓存，命中秒回。
 * 审计修复（缓存写跨进程锁）：缓存是 read-modify-write（读全表→改一条→写回），
 * 单进程内事件循环天然串行，但两个 Node 宿主进程并发写同一文件时后写者覆盖前写者
 * （丢条目、缓存命中率退化）。现按 patch 四写者锁同协议加 market-detail-cache.lock。
 * 审计修复（TTL）：条目带写入时间戳，超过 MARKET_DETAIL_CACHE_TTL_MS 视为 miss 重抓
 * （README/manifest 陈旧数据不再无限期存留）；旧格式条目（无时间戳）一次性重抓升级。
 */
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
    const slot = cache && typeof cache === 'object' ? cache[cacheKey] : null
    if (detailCacheEntryFresh(slot)) {
      return { ok: true, cached: true, entry: slot.entry }
    }
  }
  const safe = sanitizeDetailMeta((p.meta && typeof p.meta === 'object') ? p.meta : {})
  const shortName = String(repo).split('/')[1] || repo
  const base = {
    repo,
    ref,
    repoUrl: 'https://github.com/' + repo,
    name: safe.name || shortName,
    author: safe.author || String(repo).split('/')[0],
    stars: safe.stars,
    forks: safe.forks,
    license: safe.license,
    description: safe.description,
    topics: safe.topics,
    updatedAt: safe.updatedAt,
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
    const lockPath = marketDetailLockPath()
    // 审计修复（审查轮）：acquireLock 是同步阻塞实现（sleepSync/Atomics.wait）——waitMs 5s
    // 会在锁竞争时冻结整个宿主 UI 进程；缓存写是亚毫秒级 read-modify-write，改单次尝试
    // （waitMs 0，拿不到就跳过写）且无需 Worker 心跳（refreshMs 0；staleMs 30s 远大于持锁时长）。
    const a = acquireLock(fsPort, lockPath, { waitMs: 0, refreshMs: 0 })
    if (a.ok) {
      try {
        const cache = readJson(MARKET_DETAIL_CACHE_FILE()) || {}
        cache[cacheKey] = { at: new Date().toISOString(), entry }
        const keys = Object.keys(cache)
        if (keys.length > 400) {
          for (const k of keys.slice(0, keys.length - 400)) delete cache[k]
        }
        writeJsonSafe(MARKET_DETAIL_CACHE_FILE(), cache)
      } finally {
        releaseLock(fsPort, lockPath, { pid: process.pid, fd: a.fd, refresh: a.refresh })
      }
    }
    // 锁获取失败：跳过本次缓存写（缓存是尽力而为的加速层，不阻塞主流程）
  } catch { /* 有意吞掉：尽力而为的清理/读取，失败不影响主流程 */ }
  return { ok: true, cached: false, entry }
}
