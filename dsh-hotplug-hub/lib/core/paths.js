/**
 * lib/core/paths.js — 路径与常量（env 驱动，零副作用；DSH_HOME 语义见 CONTRACT.md）
 *
 * v5 重构（阶段 3，H-16）：自 index.js 拆出。DSH_HOME = .dsh 域目录
 * （resolveDshRoot 契约；缺省 ~/.dsh）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// v5：常量单一真源 = vendor-shared（shared-core 字节副本）
import { GITHUB_MIRRORS as SHARED_GITHUB_MIRRORS, MEMORY_DIR, resolveDshRoot } from '../../vendor-shared/index.mjs'

export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

export const IS_WIN = process.platform === 'win32'
export const CURL_BIN = IS_WIN ? 'curl.exe' : 'curl'
export const TAR_BIN = IS_WIN ? 'tar.exe' : 'tar'
export const ENSURE_TIMEOUT_MS = 5 * 60 * 1000
export const DOWNLOAD_TIMEOUT_MS = 120 * 1000
export const OUTPUT_CAP = 65536
// GitHub 官方通道 + 多个镜像站全并发测速，取第一个成功响应。
// 镜像站仅代理公开只读内容，不携带凭据、不触发写操作；官方 api.github.com / raw.githubusercontent.com 始终保留。
// GitHub 官方与镜像站。镜像站域名即「来源」标识（UI 上多选、逐个展示域名）。
// 契约主集 3 个来自 vendor-shared；以下 +3 为本产品市场实验源（R-v5-5，不进契约）
export const GITHUB_MIRRORS = [
  ...SHARED_GITHUB_MIRRORS,
  'https://mirror.ghproxy.com/',
  'https://ghproxy.cc/',
  'https://gh-proxy.net/',
]
// 官方 GitHub 的来源标识（UI 多选里与镜像域名并列）
export const SOURCE_GITHUB = 'github'

// 插件包市场（详见 lib/core/market.js）：GitHub topic 即「标签」
export const MARKET_CACHE_FILE = () => join(hotplugRoot(), 'market-cache.json')
// 单仓库详情缓存：marketDetail 逐条抓取后单独缓存，命中即秒回（上游 v0.9.7 对齐）
export const MARKET_DETAIL_CACHE_FILE = () => join(hotplugRoot(), 'market-detail-cache.json')
export const MARKET_PAGE_SIZE = 10
// 注：详情并发抓取上限由客户端 hydrateMarketDetails 自行限制（client.js MARKET_DETAIL_CONCURRENCY），
// 后端 marketDetailAsync 每个请求独立、不做并发限制，故此处不设同名常量（审计修复：删除死常量防漂移）。
export const MARKET_TIMEOUT_MS = 15000
// 单个原始文件（README/package.json/hotpack）抓取更短超时：文件通常很小，
// 官方通道几秒内即可返回；设太大会让不可达通道的 curl 兜底拖慢整页。
export const MARKET_FILE_TIMEOUT_MS = 5000
// 每个仓库全部文件抓取的「总预算」：到期立即结算当前最优，避免 curl 兜底挂满。
export const MARKET_FILE_BUDGET_MS = 8000
export const MARKET_README_CANDIDATES = ['README.zh.md', 'README.md', 'readme.md', 'README_CN.md', 'README_ZH.md', 'Readme.md', 'README.txt']
export const MARKET_PACK_CANDIDATES = ['hotpack.json', '.dshpack.json', 'dshpack.json']

// 注：market 的 repo/ref 校验统一走 vendor-shared validateSourceRepo/validateSourceRef
//（单一真源，避免本地正则与共享契约漂移——见 lib/core/market.js marketDetailAsync）。

/** DSH 根域（.dsh 目录）：resolveDshRoot 契约（优先级 DSH_HOTPLUG_ROOT > DSH_HOME > ~/.dsh）。
 *  审计修复：此前本地复刻只认 DSH_HOME、忽略最高优先级 DSH_HOTPLUG_ROOT——现收敛到
 *  vendor-shared 单一真源（与 dsh-memory-hub 一致）。 */
export function homeDir() {
  return resolveDshRoot(process.env).dshRoot
}
/** 全局记忆中枢根目录（与 dsh-memory-hub 的 MEMORY_DIR 单一真源一致）。 */
export function memoryDir() { return join(homeDir(), MEMORY_DIR) }
export function hotplugRoot() { return join(homeDir(), 'hotplug-hub') }
export function packsDir() { return join(hotplugRoot(), 'packs') }
export function storeRoot() { return join(homeDir(), 'hotplug-store') }
export function statePath() { return join(hotplugRoot(), 'state.json') }

/** 选择 profile：DSH_PROFILE 环境变量显式指定时无条件遵守（即使该 profile 尚不存在，
 *  由下游创建）；未指定时才按 desktop → web → headless 取第一个存在的。审计修复：此前把
 *  显式值塞进候选列表首位、不存在时静默回退 desktop/web/headless——用户显式指定的目标被
 *  忽略、写盘落到错误 profile。 */
export function profileName() {
  const env = typeof process.env.DSH_PROFILE === 'string' ? process.env.DSH_PROFILE.trim() : ''
  if (env !== '') return env
  for (const name of ['desktop', 'web', 'headless']) {
    if (existsSync(join(homeDir(), 'profiles', name, 'package.json'))) return name
  }
  return 'web'
}
export function profileDir() { return join(homeDir(), 'profiles', profileName()) }
export function manifestPath() { return join(profileDir(), 'package.json') }
export function patchPath() { return join(profileDir(), 'cordis.patch.yml') }
