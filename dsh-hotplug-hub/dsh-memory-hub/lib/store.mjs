/**
 * dsh-memory-hub / lib/store.mjs — 记忆中枢存储引擎（零依赖，node:fs）。
 *
 * 布局（<hubDir> 默认 $DSH_HOME 或 ~/.dsh 下 memory-hub/）：
 *   routes.json                    关键词路由表（F4）
 *   <memoryPackId>/
 *     pack.json                    记忆包清单（memoryPackId/scope/schemaVersion/keywords/entries）
 *     entries/<name>.md            一事实一文件（frontmatter + body）
 *     index.json                   检索索引镜像（可重建，非权威）
 *     .revisions/<id>/NNN.md       条目历史版本（写前 snapshot）
 *     .archive/<name>.md           遗忘归档（带 archivedAt 元数据）
 *     .proposals/NNNN.json         待确认提案队列（JSON）
 *   .audit.jsonl                   全局审计账本（滚动）
 *
 * 设计要点（迁移自 Reasonix / memento / memory-evolve）：
 *  - 原子写：临时文件 + fsync + rename；防符号链接穿越（safeJoin = 词法边界
 *    + vendor-shared realpath 校验，junction/symlink 越界一律拒绝）。
 *  - 引用限定 project/<name>.md | global/<name>.md（防引用当文件路径）。
 *  - Mutation 单一入口：create/update/remove/restore/adopt 全部走这里，
 *    统一维护 index.json / pack.json.entries / 审计，防索引漂移。
 *  - 并发写互斥（进程内链式 promise，跨进程由文件锁 + 原子 rename 兜底）。
 *  - 读路径故障隔离：单条损坏/手改坏的条目文件只影响自身（跳过 + 大声告警），
 *    绝不放大为整个 hub 读/写全灭（写路径 rebuildIndex 同样只扫健康条目）。
 */
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync,
  writeFileSync, openSync, closeSync, fsyncSync, ftruncateSync, writeSync, statSync, symlinkSync,
  realpathSync, lstatSync,
} from 'node:fs'
import { join, dirname, basename, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { resolveDshRoot, acquireLock, releaseLock, assertWithinRealpath, checkWindowsSafeName } from '../vendor-shared/index.mjs'
import {
  FILES, PACK_SCHEMA_VERSION, PACK_KEYS, SCOPES, TYPES, ACTIVATIONS,
  DEFAULTS, VOLATILITIES, NAME_RE, REF_RE, REVIEW_FILE, PACK_ID_RE,
} from './constants.mjs'
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.mjs'
import { newMemoryId, revisionFileName } from './id.mjs'
import {
  InvalidInputError, NotFoundError, MemoryHubError,
} from './errors.mjs'

// ---------- 路径与目录 ----------

// M-40 / R-v5-14（v5 阶段 4）：记忆根 = resolveDshRoot()/memory-hub（单一真源；
// 优先级 DSH_HOTPLUG_ROOT > DSH_HOME > ~/.dsh；DSH_HOME 即 .dsh 域目录）
const MEMORY_DIR_NAME = 'memory-hub'

/** 默认记忆中枢根：resolveDshRoot()/memory-hub。 */
export function defaultHubDir() {
  const root = resolveDshRoot(process.env)
  return join(root.dshRoot, MEMORY_DIR_NAME)
}

const nodeFsPort = {
  readFileSync, writeFileSync, existsSync, mkdirSync, statSync, openSync, closeSync,
  fsyncSync, ftruncateSync, writeSync, unlinkSync, rmSync, readdirSync, symlinkSync,
  realpathSync,
}

/** realpath 校验结果缓存（path→ok）：entries 反复寻址时避免每读一文件做祖先爬升+realpath。
 *  残余窗口：校验通过后目标被替换为指向根外的 symlink 不会被察觉（需本机 hub 目录
 *  写权限方可实施，届时攻击者已可直接改文件——纵深防御定位，可接受）。 */
const SAFE_JOIN_CACHE = new Map()
const SAFE_JOIN_CACHE_MAX = 4096

function safeJoin(root, ...parts) {
  const target = resolve(root, ...parts)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new InvalidInputError(`路径越界被拒绝：${parts.join('/')}`)
  }
  if (SAFE_JOIN_CACHE.has(target)) return target
  // realpath 双保险：词法通过但真实位置在根外（junction/symlink 中段被替换）→ 拒绝。
  // 根或目标尚不存在时经「最深已存在祖先」解析（vendor-shared C-1 契约）。
  const r = assertWithinRealpath(nodeFsPort, root, target)
  if (!r.ok) {
    throw new InvalidInputError(`路径越界被拒绝（realpath）：${parts.join('/')}（${r.error.message}）`)
  }
  if (SAFE_JOIN_CACHE.size >= SAFE_JOIN_CACHE_MAX) SAFE_JOIN_CACHE.clear()
  SAFE_JOIN_CACHE.set(target, true)
  return target
}

// ---------- 工具 ----------

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** 原子写文本：随机临时名 + O_EXCL + fsync + rename（M-44：tmp 名不可预测，
 *  防符号链接预置劫持；'wx' 独占创建拒绝已存在文件）。 */
function atomicWriteText(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  const fd = openSync(tmp, 'wx')
  try {
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, path)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* 有意吞掉：尽力而为的清理，失败不影响主流程 */ }
    throw error
  }
}

function atomicWriteJson(path, value) {
  atomicWriteText(path, JSON.stringify(value, null, 2) + '\n')
}

/** 名 → 路径 白名单：只允许 NAME_RE 字符 + Windows 安全名单（防路径穿越/保留名/尾点）。 */
function assertSafeName(name, label = 'name') {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new InvalidInputError(`${label} 非法（应为 1-64 位 Unicode 字母/数字 ._-）：${String(name)}`)
  }
  const safe = checkWindowsSafeName(name, label)
  if (!safe.ok) {
    throw new InvalidInputError(safe.error.message)
  }
}

/** memoryPackId 单一校验标准（与 schema dsh-memory-protocol-v1 一致）：
 *  PACK_ID_RE + 小写 + Windows 安全名单。创建/寻址统一走这里，消除
 *  NAME_RE（允许 CJK）/PACK_ID_RE（允许大写）/schema（仅小写）三重标准漂移。 */
export function isValidPackId(packId) {
  if (typeof packId !== 'string' || !PACK_ID_RE.test(packId) || packId !== packId.toLowerCase()) {
    return false
  }
  return checkWindowsSafeName(packId, 'memoryPackId').ok
}

function assertSafePackId(packId, label = 'memoryPackId') {
  if (!isValidPackId(packId)) {
    throw new InvalidInputError(`${label} 非法（应为 1-64 位小写字母/数字 ._- 且非 Windows 保留名）：${String(packId)}`)
  }
}

// ---------- 条目模型 ----------

/**
 * 从 frontmatter 文本构造条目对象；只读路径用（index.json 重建）。
 * volatility 缺省返回 ''（=按 type 取新鲜窗口，TYPE_FRESHNESS 生效，Spec §7.4）。
 * @param {string} name
 * @param {Record<string, unknown>} fm
 */
function makeEntry(name, fm) {
  const type = normalizeType(fm.type)
  const scope = normalizeScope(fm.scope)
  return {
    id: fm.id ?? newMemoryId(),
    revision: Number.isInteger(fm.revision) && fm.revision > 0 ? fm.revision : 1,
    createdAt: typeof fm.createdAt === 'string' ? fm.createdAt : new Date().toISOString(),
    updatedAt: typeof fm.updatedAt === 'string' ? fm.updatedAt : new Date().toISOString(),
    name,
    title: typeof fm.title === 'string' ? fm.title : name,
    description: typeof fm.description === 'string' ? fm.description : '',
    type,
    scope,
    activation: normalizeActivation(fm.activation),
    volatility: normalizeVolatility(fm.volatility),
    subjectKey: typeof fm.subjectKey === 'string' ? fm.subjectKey : '',
    expiresAt: typeof fm.expiresAt === 'string' ? fm.expiresAt : null,
    lastVerifiedAt: typeof fm.lastVerifiedAt === 'string' ? fm.lastVerifiedAt : null,
    keywords: normalizeKeywords(fm.keywords),
    // tagged 手改成标量（tagged: abc）同样容忍（非数组→[]），不当作损坏文件跳过
    tagged: normalizeKeywords((Array.isArray(fm.tagged) ? fm.tagged : []).map((tag) => String(tag).replace(/^\[?id:\s*/, '').replace(/\]?$/, ''))),
    archivedAt: typeof fm.archivedAt === 'string' ? fm.archivedAt : undefined,
    body: '',
  }
}

function normalizeType(value) {
  if (value === undefined || value === '') return 'project'
  if (!TYPES.includes(value)) throw new InvalidInputError(`type 非法：${String(value)}（允许 ${TYPES.join('/')}）`)
  return value
}

function normalizeScope(value) {
  if (value === undefined || value === '') return 'global'
  if (!SCOPES.includes(value)) throw new InvalidInputError(`scope 非法：${String(value)}（允许 ${SCOPES.join('/')}）`)
  return value
}

function normalizeActivation(value) {
  if (value === undefined || value === '') return 'relevant'
  if (!ACTIVATIONS.includes(value)) throw new InvalidInputError(`activation 非法：${String(value)}`)
  return value
}

/** ''（缺省）= 按 type 取 TYPE_FRESHNESS 窗口（Spec §7.4「volatility 缺省时按 type 取」）。 */
function normalizeVolatility(value) {
  if (value === undefined || value === '') return ''
  if (!(value in VOLATILITIES)) throw new InvalidInputError(`volatility 非法：${String(value)}`)
  return value
}

function normalizeKeywords(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .slice(0, 24)
}

/** 序列化条目为 entries/<name>.md 全文。archivedAt 仅归档副本携带（活跃条目无此字段）。 */
export function serializeEntry(entry) {
  const fields = {
    id: entry.id,
    revision: entry.revision,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    name: entry.name,
    title: entry.title,
    description: entry.description,
    type: entry.type,
    scope: entry.scope,
    activation: entry.activation,
    volatility: entry.volatility,
    subjectKey: entry.subjectKey,
    expiresAt: entry.expiresAt ?? null,
    lastVerifiedAt: entry.lastVerifiedAt ?? null,
    keywords: entry.keywords,
    tagged: (entry.tagged ?? []).map((tag) => `[id: ${tag}]`),
  }
  if (typeof entry.archivedAt === 'string' && entry.archivedAt !== '') {
    fields.archivedAt = entry.archivedAt
  }
  return `---\n${stringifyFrontmatter(fields)}\n---\n\n${entry.body ?? ''}`.replace(/\n?$/, '\n')
}

/**
 * 解析条目文件全文（frontmatter + body）。不存在的文件返回 null。
 * 容忍 CRLF 手改：统一按 \n 检测 frontmatter 闭合（我们完全控制写入端，读端
 * 归一化行尾不会引入歧义；Windows 记事本保存的条目不再毒化解析）。
 */
export function deserializeEntryFile(text, name) {
  const normalized = text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text
  let fmText = normalized
  let body = ''
  if (normalized.startsWith('---\n')) {
    const closed = normalized.indexOf('\n---\n', 4)
    if (closed === -1) {
      const rawBody = normalized.slice(4)
      fmText = rawBody
      body = ''
    } else {
      fmText = normalized.slice(4, closed)
      body = normalized.slice(closed + 5)
    }
  }
  const fm = parseFrontmatter(fmText)
  const entry = makeEntry(name, fm)
  entry.body = String(body).replace(/^\n/, '').replace(/\n$/, '')
  return entry
}

// ---------- Store ----------

// H-8（v5 阶段 4）：跨进程写锁——共享 fs/lock 文件锁协议（与 launcher/dseam/C# 契约
// 一致的 token/探活/过期语义）；锁文件 <hubDir>/.dsh-memory.lock 串行化全部写操作。
// 不可重入：公共写方法持锁后不得再嵌套调用另一个公共写方法（内部走 *Locked 核心）。
const WRITE_LOCK_FILE = '.dsh-memory.lock'
const WRITE_LOCK_WAIT_MS = 10000

/**
 * C2：旧 `memory` 目录 → `memory-hub` 迁移（软链形态，§9"不丢数据"）。
 * 仅当 hubDir 缺省名（memory-hub）且自身不存在、同级 legacy 存在时执行；
 * 链接失败（权限/平台）静默降级为新空目录（数据仍留在 legacy 路径，不删除）。
 * @param {string} hubDir 目标（memory-hub）路径
 * @returns {boolean} 是否已建链接
 */
function linkLegacyMemoryDir(hubDir) {
  try {
    if (basename(hubDir) !== MEMORY_DIR_NAME) return false
    const parent = dirname(hubDir)
    const legacy = join(parent, 'memory')
    if (!existsSync(legacy)) return false
    mkdirSync(parent, { recursive: true })
    symlinkSync(legacy, hubDir, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    // 链接不可用：不阻断（数据保留在 legacy；hub 以新目录独立运行）。
    // catch 前提是本进程 symlinkSync 失败——即本进程没建成任何东西；此时 hubDir 若
    // 存在必是他方资产。只清理「指向本 legacy 目录的链接」（早前尝试的残留，可安全
    // 重建）；【实体目录（含 junction 形态的 hub）一律不碰】——误删他方实体目录
    // = 数据丢失（二轮复审 F7 返工：此前 isDirectory 分支会递归整删）。
    try {
      const st = lstatSync(hubDir)
      if (st.isSymbolicLink()) {
        const target = realpathSync(hubDir)
        if (target === realpathSync(legacy)) rmSync(hubDir, { force: true })
      }
    } catch { /* 忽略：清不掉就留给 mkdir/后续处理 */ }
    return false
  }
}

export class MemoryStore {
  /**
   * @param {string} hubDir 记忆中枢根目录。
   * C2（兼容性审计，§9）：构造时执行旧 `memory` 目录迁移——hubDir（memory-hub）
   * 不存在而同级 `memory` 目录存在（升级用户遗留）时，建 junction/symlink
   * memory-hub → memory：数据（含 legacy memories.jsonl）原址保留、零拷贝，
   * 新代码经 memory-hub 路径即可读写旧数据（"或软链"承诺落地）。
   */
  constructor(hubDir) {
    this.hubDir = hubDir
    /** 已告警的损坏文件（每进程每文件一次，防搜索循环刷屏）。 */
    this._corruptWarned = new Set()
    if (!existsSync(hubDir)) {
      const linked = linkLegacyMemoryDir(hubDir)
      if (!linked) mkdirSync(hubDir, { recursive: true })
    }
  }

  /**
   * H-8：跨进程写锁包裹（check+write 原子化；两进程并发同 subjectKey 时
   * 第二个在锁内重读 → 冲突拒绝）。锁失败抛 MemoryHubError('WRITE_LOCK')。
   * @template T
   * @param {() => T} fn 锁内执行（同步）
   * @returns {T}
   */
  withWriteLock(fn) {
    const lockPath = join(this.hubDir, WRITE_LOCK_FILE)
    const a = acquireLock(nodeFsPort, lockPath, { waitMs: WRITE_LOCK_WAIT_MS, refreshMs: 5000 })
    if (!a.ok) throw new MemoryHubError('WRITE_LOCK', `记忆写锁获取失败：${a.error.message}`)
    try {
      return fn()
    } finally {
      // 审计修复：传入 refresh 句柄清理心跳（Worker 线程），否则释放后仍持续写锁文件。
      releaseLock(nodeFsPort, lockPath, { pid: process.pid, fd: a.fd, refresh: a.refresh })
    }
  }

  /** 损坏文件大声告警（每文件每进程一次）+ 审计留痕一次。 */
  _reportCorrupt(kind, path, error) {
    const key = `${kind}:${path}`
    if (this._corruptWarned.has(key)) return
    this._corruptWarned.add(key)
    console.warn(`[dsh-memory-hub] ${kind}解析失败，已跳过（不阻塞其余记忆；请修复或删除该文件）：${path} — ${error?.message ?? error}`)
    try {
      this.auditAppend({ action: 'corrupt-skip', packId: null, entryId: null, operator: 'system', outcome: 'skipped', detail: `${kind} ${basename(path)}: ${String(error?.message ?? error).slice(0, 200)}` })
    } catch { /* 审计失败不再放大 */ }
  }

  /** JSON 读取：存在但损坏 → 每文件一次大声告警（console + 审计）后返回 null。 */
  _readJsonGuarded(path, what) {
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return null
    }
    try {
      return JSON.parse(text)
    } catch (error) {
      this._reportCorrupt(what, path, error)
      return null
    }
  }

  // ----- 路由 -----

  /** 读路由表；缺失时生成默认（一个 global-pack，空关键词兜底所有）。
   *  文件存在但 JSON 损坏 → 大声告警 + 降级默认（不静默吞，M7）。 */
  readRoutes() {
    const path = join(this.hubDir, FILES.routes)
    if (!existsSync(path)) return { schemaVersion: 1, routes: [], fallbackPackId: 'global-pack' }
    const parsed = this._readJsonGuarded(path, 'routes.json')
    if (parsed && Array.isArray(parsed.routes)) return parsed
    return { schemaVersion: 1, routes: [], fallbackPackId: 'global-pack' }
  }

  writeRoutes(routes) {
    atomicWriteJson(join(this.hubDir, FILES.routes), {
      ...routes,
      routes: (routes.routes ?? []).slice(0, 128),
      updatedAt: new Date().toISOString(),
    })
    return this
  }

  /** 确保默认记忆包 global-pack 存在（首次启动种子）。
   *  持写锁消除首启 TOCTOU（两进程并发建包 → 后者 benign 已存在）；
   *  fallbackPackId 非法（手改 routes）→ 告警并自愈重置为 global-pack（写回 routes），
   *  否则后续全部无 pack 写路径会永久 NotFound；锁不可得 → 告警降级（首次写时补种），
   *  绝不让插件加载失败（apply() 启动路径不得因锁竞争抛错，复审 #4）。 */
  ensureDefaultPack() {
    try {
      return this.withWriteLock(() => {
        this._ensureDefaultPackLocked()
        return this
      })
    } catch (error) {
      if (error?.code === 'WRITE_LOCK') {
        console.warn(`[dsh-memory-hub] 首启建包未获写锁（他进程持锁中），降级跳过：${error.message}`)
        return this
      }
      throw error
    }
  }

  _ensureDefaultPackLocked() {
    let routes = this.readRoutes()
    if (routes.fallbackPackId !== undefined && routes.fallbackPackId !== null && !isValidPackId(routes.fallbackPackId)) {
      this._reportCorrupt('fallbackPackId', join(this.hubDir, FILES.routes), new Error(`fallbackPackId 非法：${String(routes.fallbackPackId)}，已重置为 global-pack`))
      routes = { ...routes, fallbackPackId: 'global-pack' }
      this.writeRoutes(routes)
    }
    for (const candidate of [routes.fallbackPackId, 'global-pack']) {
      if (!candidate || this.hasPack(candidate)) continue
      if (!isValidPackId(candidate)) continue
      try {
        this.createPack({ memoryPackId: candidate, scope: 'global' })
      } catch (error) {
        // 锁内复查：已存在 = 并发良性；其余错误照抛
        if (!this.hasPack(candidate)) throw error
      }
    }
  }

  // ----- 记忆包 -----

  /** 记忆包目录绝对路径（packId 单一校验标准 = isValidPackId）。 */
  packDir(packId) {
    assertSafePackId(packId)
    return safeJoin(this.hubDir, packId)
  }

  /** 包是否存在；非法 packId 一律 false（不抛——探测语义，供 ensureDefaultPack/路由消费）。 */
  hasPack(packId) {
    try {
      return existsSync(join(this.packDir(packId), FILES.pack))
    } catch {
      return false
    }
  }

  /** 读包清单；不存在或损坏返回 null（损坏每文件一次大声告警，M7）。 */
  readPack(packId) {
    if (!isValidPackId(packId)) return null
    const path = join(this.packDir(packId), FILES.pack)
    if (!existsSync(path)) return null
    return this._readJsonGuarded(path, `pack.json(${packId})`)
  }

  listPackIds() {
    try {
      // 非法包名（旧版 CJK/大写包目录、手拷目录）过滤 + 每目录一次告警——
      // 否则 packDir 对其抛 InvalidInputError 会经 listEntries/allEntries 把
      // 整个 hub 的读写全灭（与故障隔离目标相悖的回归，复审 #1）。
      const out = []
      for (const entry of readdirSync(this.hubDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (!existsSync(join(this.hubDir, entry.name, FILES.pack))) continue
        if (!isValidPackId(entry.name)) {
          this._reportCorrupt('记忆包目录（非法 ID，已跳过）', join(this.hubDir, entry.name), new Error(`memoryPackId 非法：${entry.name}`))
          continue
        }
        out.push(entry.name)
      }
      return out.sort()
    } catch {
      return []
    }
  }

  listPacks() {
    return this.listPackIds().map((id) => this.readPack(id)).filter(Boolean)
  }

  /** 创建记忆包（写入 pack.json + 目录结构）。 */
  createPack({ memoryPackId, scope = 'global', keywords = [], schemaVersion = PACK_SCHEMA_VERSION }) {
    assertSafePackId(memoryPackId)
    if (!SCOPES.includes(scope)) throw new InvalidInputError(`scope 非法：${String(scope)}`)
    const dir = this.packDir(memoryPackId)
    if (existsSync(join(dir, FILES.pack))) {
      throw new InvalidInputError(`记忆包已存在：${memoryPackId}`)
    }
    mkdirSync(dirname(dir), { recursive: true })
    mkdirSync(join(dir, FILES.entriesDir), { recursive: true })
    mkdirSync(join(dir, FILES.revisionsDir), { recursive: true })
    mkdirSync(join(dir, FILES.archiveDir), { recursive: true })
    mkdirSync(join(dir, FILES.proposalsDir), { recursive: true })
    atomicWriteJson(join(dir, FILES.pack), {
      memoryPackId,
      scope,
      schemaVersion,
      keywords: normalizeKeywords(keywords),
      entries: 0,
      createdAt: new Date().toISOString(),
    })
    return this.readPack(memoryPackId)
  }

  privatePackPath(packId) {
    return this.packDir(packId)
  }

  // ----- 条目 -----

  entryPath(packId, name) {
    assertSafeName(name, 'name')
    return safeJoin(this.packDir(packId), FILES.entriesDir, `${name}.md`)
  }

  /** 解析给定限定引用的 (packId, name)；不存在的引用返回 null。 */
  resolveReference(ref) {
    if (typeof ref !== 'string') return null
    const match = REF_RE.exec(ref.trim())
    if (match === null) return null
    const [, scope, name] = match
    const packId = this.packIdForScope(scope)
    return this.hasEntry(packId, name) ? { packId, name } : null
  }

  /** scope → 默认记忆包（routes.fallbackPackId 或 global-pack）。 */
  packIdForScope(scope) {
    const routes = this.readRoutes()
    return routes.fallbackPackId ?? 'global-pack'
  }

  hasEntry(packId, name) {
    return existsSync(this.entryPath(packId, name))
  }

  /**
   * 读条目全文。损坏（frontmatter 坏行/非法枚举/CRLF 毒化已修）→ 大声告警一次
   * 并返回 null（故障隔离：单坏文件不再让 listEntries/allEntries/写路径全灭）。
   */
  readEntry(packId, name) {
    const text = this.tryReadEntryText(packId, name)
    if (text === null) return null
    try {
      return deserializeEntryFile(text, name)
    } catch (error) {
      this._reportCorrupt('条目', this.entryPath(packId, name), error)
      return null
    }
  }

  tryReadEntryText(packId, name) {
    const path = this.entryPath(packId, name)
    if (!existsSync(path)) return null
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }

  /** 列出某包的条目（按 name 排序；损坏文件跳过并告警）。 */
  listEntries(packId) {
    const dir = safeJoin(this.packDir(packId), FILES.entriesDir)
    let names
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.md')).sort()
    } catch {
      return []
    }
    return names.map((name) => this.readEntry(packId, name.slice(0, -3))).filter(Boolean)
  }

  /** 全中枢条目（用于离线索引/检索）。 */
  allEntries() {
    /** @type {Array<{packId: string, entry: import('../types.js').MemoryEntry}>} */
    const out = []
    for (const packId of this.listPackIds()) {
      for (const entry of this.listEntries(packId)) out.push({ packId, entry })
    }
    return out
  }

  /** 按 id 全局定位（跨包）。 */
  findById(id) {
    for (const packId of this.listPackIds()) {
      for (const entry of this.listEntries(packId)) {
        if (entry.id === id) return { packId, entry }
      }
    }
    return null
  }

  // ----- 索引镜像 -----

  rebuildIndex(packId) {
    if (!this.hasPack(packId)) return null
    const entries = this.listEntries(packId).map((entry) => ({
      id: entry.id,
      name: entry.name,
      title: entry.title,
      type: entry.type,
      activation: entry.activation,
    }))
    atomicWriteJson(join(this.packDir(packId), FILES.indexFile), {
      memoryPackId: packId,
      schemaVersion: PACK_SCHEMA_VERSION,
      entries,
      rebuiltAt: new Date().toISOString(),
    })
    return entries
  }

  /** 同步 pack.json 的 entries 计数（权威是实际文件列表）。 */
  syncPackCount(packId) {
    const manifest = this.readPack(packId)
    if (manifest === null) return
    const count = this.listEntries(packId).length
    if (manifest.entries !== count) {
      atomicWriteJson(join(this.packDir(packId), FILES.pack), { ...manifest, entries: count })
    }
  }

  // ----- revision / archive -----

  snapshotRevision(packId, entry) {
    const text = serializeEntry(entry)
    const dir = safeJoin(this.packDir(packId), FILES.revisionsDir, entry.id)
    mkdirSync(dir, { recursive: true })
    atomicWriteText(join(dir, revisionFileName(entry.revision)), text)
  }

  listRevisions(packId, id) {
    const dir = safeJoin(this.packDir(packId), FILES.revisionsDir, id)
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    // 数值排序（而非字符串排序）：revision ≥ 1000 时 "1000.md" 的字符串序会排在 "999.md" 之前，
    // 导致历史版本乱序。按整数比较保持任意 revision 数量下都单调递增。
    return names
      .filter((name) => /^\d+\.md$/.test(name))
      .sort((a, b) => Number(a.slice(0, -3)) - Number(b.slice(0, -3)))
      .map((name) => Number(name.slice(0, -3)))
  }

  archivePath(packId, name) {
    assertSafeName(name, 'name')
    return safeJoin(this.packDir(packId), FILES.archiveDir, `${name}.md`)
  }

  archiveEntry(packId, entry) {
    const path = this.archivePath(packId, entry.name)
    const archived = { ...entry, archivedAt: new Date().toISOString() }
    atomicWriteText(path, serializeEntry(archived))
  }

  /** 删除归档文件（restore 恢复后调用，避免条目同时存在于活跃集与归档集）。 */
  deleteArchivedFile(packId, name) {
    const path = this.archivePath(packId, name)
    if (existsSync(path)) rmSync(path, { force: true })
    return true
  }

  listArchived(packId) {
    const dir = safeJoin(this.packDir(packId), FILES.archiveDir)
    let names
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.md')).sort()
    } catch {
      return []
    }
    const out = []
    for (const name of names) {
      const file = join(dir, name)
      try {
        const text = readFileSync(file, 'utf8')
        const entry = deserializeEntryFile(text, name.slice(0, -3))
        out.push({ packId, entry })
      } catch (error) {
        this._reportCorrupt('归档条目', file, error)
      }
    }
    return out
  }

  /** 全部包的归档条目（供 GUI/工具跨包列出）。 */
  allArchived() {
    const out = []
    for (const packId of this.listPackIds()) out.push(...this.listArchived(packId))
    return out
  }

  /** 写入条目文件（唯一写入口：原子写）。 */
  writeEntryFile(packId, entry) {
    atomicWriteText(this.entryPath(packId, entry.name), serializeEntry(entry))
    return entry
  }

  /** 删除条目文件。 */
  deleteEntryFile(packId, name) {
    const path = this.entryPath(packId, name)
    if (existsSync(path)) rmSync(path, { force: true })
    return true
  }

  // ----- 提案队列 -----

  proposalDir(packId) {
    return safeJoin(this.packDir(packId), FILES.proposalsDir)
  }

  /** 追加提案（maintainer 进程内 id）。直接返回刚构造的记录，避免按 createdAt 排序重读可能误取同毫秒提案。 */
  appendProposal(packId, proposal) {
    const dir = this.proposalDir(packId)
    mkdirSync(dir, { recursive: true })
    const seq = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
    const record = {
      ...proposal,
      id: `p-${seq}`,
      packId,
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    atomicWriteJson(join(dir, `${seq}.json`), record)
    return record
  }

  listProposals(packId, status = 'pending') {
    const dir = this.proposalDir(packId)
    let names
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
    } catch {
      return []
    }
    return names
      .map((name) => this._readJsonGuarded(join(dir, name), `提案 ${name}`))
      .filter(Boolean)
      .filter((p) => status === 'any' || p.status === status)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  }

  /** 全部包的提案（status 过滤）。 */
  allProposals(status = 'pending') {
    /** @type {any[]} */
    const out = []
    for (const packId of this.listPackIds()) out.push(...this.listProposals(packId, status))
    return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  }

  /** 更新提案状态；写入由 adopt/reject 完成（结果以提案 JSON 记录）。 */
  setProposalStatus(packId, proposalId, status, result) {
    const dir = this.proposalDir(packId)
    let names
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.json'))
    } catch {
      // .proposals 目录缺失（旧版建包/外部建包）≡ 无提案：按不存在处理而非裸 ENOENT
      throw new NotFoundError(`提案不存在：${proposalId}`)
    }
    const file = names.find((name) => {
      const data = readJson(join(dir, name), null)
      return data && data.id === proposalId
    })
    if (!file) throw new NotFoundError(`提案不存在：${proposalId}`)
    const data = readJson(join(dir, file), {})
    atomicWriteJson(join(dir, file), {
      ...data,
      status,
      resolvedAt: new Date().toISOString(),
      result: result ?? null,
    })
  }

  // ----- 审计账本 -----

  auditAppend(row) {
    const path = join(this.hubDir, FILES.audit)
    const text = JSON.stringify({
      at: new Date().toISOString(),
      ...row,
    }) + '\n'
    // 滚动：auditRollAfter 为「行数」阈值（Spec §7.5）。先用字节预检（≈200B/行）避免
    // 每次追加都整读账本；预检命中后再精确数行，杜绝「字节数当行数」的注释漂移。
    if (existsSync(path) && statSync(path).size > DEFAULTS.auditRollAfter * 50) {
      let lineCount = 0
      try {
        lineCount = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').length
      } catch { /* 读取失败按未达阈值处理 */ }
      if (lineCount > DEFAULTS.auditRollAfter) {
        const rolled = `${path}.${Date.now()}`
        try { renameSync(path, rolled) } catch { /* 有意吞掉：尽力而为的清理，失败不影响主流程 */ }
      }
    }
    mkdirSync(dirname(path), { recursive: true })
    const fd = openSync(path, 'a')
    try {
      writeFileSync(fd, text, 'utf8')
    } finally {
      closeSync(fd)
    }
    return this
  }

  auditList({ limit = 200, filter } = {}) {
    const path = join(this.hubDir, FILES.audit)
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return []
    }
    const rows = text.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
    const filtered = typeof filter === 'function' ? rows.filter(filter) : rows
    return filtered.slice(-limit).reverse()
  }

  // ----- subject 冲突检查 -----

  /**
   * 校验 subjectKey 在 pack 内是否已被活跃条目占用。
   * @returns {null | {packId: string, holder: import('../types.js').MemoryEntry}}
   */
  subjectHolder(packId, subjectKey) {
    if (typeof subjectKey !== 'string' || subjectKey === '') return null
    for (const entry of this.listEntries(packId)) {
      if (entry.subjectKey === subjectKey && !isExpired(entry)) {
        return { packId, holder: entry }
      }
    }
    return null
  }

  // ----- L3 日志轨（M3：project/daily，不注入、按需读取；<hub>/logs/）-----

  logRoot() {
    return safeJoin(this.hubDir, 'logs')
  }

  /** scope → 安全子目录（小写字母数字 .-_，最长 48）。 */
  safeScopeDir(scope) {
    const raw = String(scope ?? 'daily').trim().toLowerCase().replace(/^[./\\]+/, '').replace(/[^a-z0-9._-]+/g, '-').slice(0, 48)
    if (raw === '') throw new InvalidInputError('日志 scope 非法（空）')
    if (raw === '.' || raw === '..' || /^\./.test(raw)) throw new InvalidInputError(`日志 scope 非法：${String(scope)}`)
    return raw
  }

  logPath(scope, date = new Date()) {
    const day = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
    return safeJoin(this.logRoot(), this.safeScopeDir(scope), `${day}.md`)
  }

  /**
   * 追加一条日志（原子写、纯追加、时间戳前缀）。返回落盘信息。
   * 新行追加在文件尾部（时间正序）；读取端需要「最新」时取尾部（webapi logs）。
   * @param {string} scope 'daily' | 'project-<slug>' | 任意安全 slug
   * @param {string} text
   */
  appendLog(scope, text) {
    // 读-改-写须持跨进程写锁：两进程并发追加时，第二个在锁内重读最新内容再写，
    // 避免 read-modify-write 竞态丢失日志行。
    return this.withWriteLock(() => {
      const line = `${new Date().toISOString()}  ${String(typeof text === 'string' ? text : '').trim().slice(0, 2000)}`
      const path = this.logPath(scope)
      mkdirSync(dirname(path), { recursive: true })
      let content = line + '\n'
      if (existsSync(path)) content = readFileSync(path, 'utf8') + content
      atomicWriteText(path, content)
      const lines = content.trim().split('\n').length
      return { path, line: lines, scope: this.safeScopeDir(scope) }
    })
  }

  /** 列出某 scope 的日志文件（按日期名倒序）。 */
  listLogs(scope) {
    const dir = safeJoin(this.logRoot(), this.safeScopeDir(scope))
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse()
  }

  readLog(scope, date) {
    const dir = safeJoin(this.logRoot(), this.safeScopeDir(scope))
    const file = /^\d{4}-\d{2}-\d{2}\.md$/.test(String(date ?? '')) ? String(date) : null
    if (file === null) {
      const files = this.listLogs(scope)
      if (files.length === 0) return ''
      return readFileSync(safeJoin(dir, files[0]), 'utf8')
    }
    const path = safeJoin(dir, file)
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }

  // ----- 审查状态（M3 方案 B：每 N 次变更后到期审查；<hub>/review-state.json）-----

  /** 读审查状态（含 totalChanges：跨重启连续的记忆变更总数，H6 根治用；
   *  字段缺失返回 null 以区分「旧格式文件」与「确为 0」）。 */
  readReviewState() {
    const path = safeJoin(this.hubDir, REVIEW_FILE)
    if (!existsSync(path)) return { lastReviewedAt: null, markedTurns: 0, totalChanges: null }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      return {
        lastReviewedAt: typeof raw.lastReviewedAt === 'string' ? raw.lastReviewedAt : null,
        markedTurns: Number.isFinite(raw.markedTurns) ? Number(raw.markedTurns) : 0,
        totalChanges: Number.isFinite(raw.totalChanges) ? Number(raw.totalChanges) : null,
      }
    } catch {
      return { lastReviewedAt: null, markedTurns: 0, totalChanges: null }
    }
  }

  writeReviewState(state) {
    atomicWriteJson(safeJoin(this.hubDir, REVIEW_FILE), state)
  }

  /**
   * 记忆变更计数 +1 并持久化（H6：重启后 changeCount 从 totalChanges 续读，
   * 「每 N 次变更后 due」跨重启成立；调用方须已持写锁或接受Last-Write语义）。
   */
  bumpReviewTotal(currentCount) {
    const state = this.readReviewState()
    // 已有更高的 totalChanges（并发实例先写）→ 保留更大值，只补 markedTurns/lastReviewedAt
    const total = Math.max(state.totalChanges ?? 0, currentCount)
    this.writeReviewState({ ...state, totalChanges: total })
    return total
  }
}

/** 是否硬过期。 */
export function isExpired(entry) {
  const expires = typeof entry.expiresAt === 'string' && entry.expiresAt !== '' ? entry.expiresAt : null
  if (expires === null) return false
  const t = Date.parse(expires)
  return Number.isFinite(t) && t < Date.now()
}
