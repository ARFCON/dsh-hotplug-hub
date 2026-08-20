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
 *  - 原子写：临时文件 + fsync + rename；防符号链接穿越（safeJoin）。
 *  - 引用限定 project/<name>.md | global/<name>.md（防引用当文件路径）。
 *  - Mutation 单一入口：create/update/remove/restore/adopt 全部走这里，
 *    统一维护 index.json / pack.json.entries / 审计，防索引漂移。
 *  - 并发写互斥（进程内链式 promise，跨进程由原子 rename 兜底）。
 */
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  writeFileSync, openSync, closeSync, fsyncSync, statSync,
} from 'node:fs'
import { join, dirname, basename, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import {
  FILES, PACK_SCHEMA_VERSION, PACK_KEYS, SCOPES, TYPES, ACTIVATIONS,
  DEFAULTS, VOLATILITIES, NAME_RE, REF_RE, REVIEW_FILE,
} from './constants.mjs'
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.mjs'
import { newMemoryId, revisionFileName } from './id.mjs'
import {
  InvalidInputError, NotFoundError, SubjectConflictError, BudgetExceededError,
} from './errors.mjs'

// ---------- 路径与目录 ----------

/** 默认记忆中枢根：$DSH_HOME/memory-hub（无 DSH_HOME 时 ~/.dsh/memory-hub）。 */
export function defaultHubDir() {
  const env = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(env, 'memory-hub')
}

function safeJoin(root, ...parts) {
  const target = resolve(root, ...parts)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new InvalidInputError(`路径越界被拒绝：${parts.join('/')}`)
  }
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

/** 原子写文本：临时文件 + fsync + rename（Windows rename 覆盖 OK）。 */
function atomicWriteText(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  const fd = openSync(tmp, 'w')
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

/** 名 → 路径 白名单：只允许 NAME_RE 字符（防路径穿越）。 */
function assertSafeName(name, label = 'name') {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new InvalidInputError(`${label} 非法（应为 1-64 位 Unicode 字母/数字 ._-）：${String(name)}`)
  }
}

// ---------- 条目模型 ----------

/**
 * 从 frontmatter 文本构造条目对象；只读路径用（index.json 重建）。
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
    volatility: normalizeVolatility(fm.volatility, type),
    subjectKey: typeof fm.subjectKey === 'string' ? fm.subjectKey : '',
    expiresAt: typeof fm.expiresAt === 'string' ? fm.expiresAt : null,
    lastVerifiedAt: typeof fm.lastVerifiedAt === 'string' ? fm.lastVerifiedAt : null,
    keywords: normalizeKeywords(fm.keywords),
    tagged: normalizeKeywords((fm.tagged ?? []).map((tag) => String(tag).replace(/^\[?id:\s*/, '').replace(/\]?$/, ''))),
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

function normalizeVolatility(value, type) {
  if (value === undefined || value === '') return 'stable'
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

/** 序列化条目为 entries/<name>.md 全文。 */
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
  return `---\n${stringifyFrontmatter(fields)}\n---\n\n${entry.body ?? ''}`.replace(/\n?$/, '\n')
}

/** 解析条目文件全文（frontmatter + body）。不存在的文件返回 null。 */
export function deserializeEntryFile(text, name) {
  const bodyStart = text.indexOf('\n---')
  let fmText = text
  let body = ''
  if (text.startsWith('---\n')) {
    const closed = text.indexOf('\n---\n', 4)
    if (closed === -1) {
      const rawBody = text.slice(4)
      fmText = rawBody
      body = ''
    } else {
      fmText = text.slice(4, closed)
      body = text.slice(closed + 5)
    }
  }
  const fm = parseFrontmatter(fmText)
  const entry = makeEntry(name, fm)
  entry.body = String(body).replace(/^\n/, '').replace(/\n$/, '')
  return entry
}

// ---------- Store ----------

export class MemoryStore {
  /**
   * @param {string} hubDir 记忆中枢根目录。
   */
  constructor(hubDir) {
    this.hubDir = hubDir
    this.mutations = Promise.resolve()
    if (!existsSync(hubDir)) mkdirSync(hubDir, { recursive: true })
  }

  // ----- 路由 -----

  /** 读路由表；缺失时生成默认（一个 global-pack，空关键词兜底所有）。 */
  readRoutes() {
    const routes = readJson(join(this.hubDir, FILES.routes), null)
    if (routes && Array.isArray(routes.routes)) return routes
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

  /** 确保默认记忆包 global-pack 存在（首次启动种子）。 */
  ensureDefaultPack() {
    const routes = this.readRoutes()
    for (const candidate of [routes.fallbackPackId, 'global-pack']) {
      if (candidate && !this.hasPack(candidate)) {
        this.createPack({ memoryPackId: candidate, scope: 'global' })
      }
    }
    return this
  }

  // ----- 记忆包 -----

  /** 记忆包目录绝对路径。 */
  packDir(packId) {
    assertSafeName(packId, 'memoryPackId')
    return safeJoin(this.hubDir, packId)
  }

  hasPack(packId) {
    return existsSync(join(this.packDir(packId), FILES.pack))
  }

  /** 读包清单；不存在返回 null。 */
  readPack(packId) {
    if (typeof packId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(packId)) return null
    const manifest = readJson(join(this.packDir(packId), FILES.pack), null)
    if (manifest === null) return null
    return manifest
  }

  listPackIds() {
    try {
      return readdirSync(this.hubDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(this.hubDir, entry.name, FILES.pack)))
        .map((entry) => entry.name)
        .sort()
    } catch {
      return []
    }
  }

  listPacks() {
    return this.listPackIds().map((id) => this.readPack(id)).filter(Boolean)
  }

  /** 创建记忆包（写入 pack.json + 目录结构）。 */
  createPack({ memoryPackId, scope = 'global', keywords = [], schemaVersion = PACK_SCHEMA_VERSION }) {
    assertSafeName(memoryPackId, 'memoryPackId')
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

  /** 读条目全文。 */
  readEntry(packId, name) {
    const text = this.tryReadEntryText(packId, name)
    return text === null ? null : deserializeEntryFile(text, name)
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

  /** 列出某包的条目（按 name 排序）。 */
  listEntries(packId) {
    const dir = safeJoin(this.packDir(packId), FILES.entriesDir)
    let names
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.md'))
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
    return names.filter((name) => /^\d+\.md$/.test(name)).sort().map((name) => Number(name.slice(0, -3)))
  }

  archiveEntry(packId, entry) {
    const path = safeJoin(this.packDir(packId), FILES.archiveDir, `${entry.name}.md`)
    const archived = { ...entry, archivedAt: new Date().toISOString() }
    atomicWriteText(path, serializeEntry(archived))
  }

  listArchived(packId) {
    const dir = safeJoin(this.packDir(packId), FILES.archiveDir)
    let names
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.md'))
    } catch {
      return []
    }
    return names.map((name) => {
      const text = readFileSync(join(dir, name), 'utf8')
      const entry = deserializeEntryFile(text, name.slice(0, -3))
      return { packId, entry }
    }).filter((item) => item.entry !== null)
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

  /** 追加提案（maintainer 进程内 id）。 */
  appendProposal(packId, proposal) {
    const dir = this.proposalDir(packId)
    mkdirSync(dir, { recursive: true })
    const seq = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
    atomicWriteJson(join(dir, `${seq}.json`), {
      ...proposal,
      id: `p-${seq}`,
      packId,
      status: 'pending',
      createdAt: new Date().toISOString(),
    })
    return this.listProposals(packId).at(-1)
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
      .map((name) => readJson(join(dir, name), null))
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
    const names = readdirSync(dir).filter((name) => name.endsWith('.json'))
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
    // 滚动：超过阈值重命名旧账本（保留站内历史）。
    if (existsSync(path) && statSync(path).size > DEFAULTS.auditRollAfter * 200) {
      const rolled = `${path}.${Date.now()}`
      try { renameSync(path, rolled) } catch { /* 有意吞掉：尽力而为的清理，失败不影响主流程 */ }
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
      if (entry.subjectKey === subjectKey && !isExpired(entry) && entry.id !== '__probe__') {
        return { packId, holder: entry }
      }
    }
    return null
  }

  /** 尊重 subject 冲突的确定性 create 检查入口（protocol 调用）。 */
  assertSubjectFree(packId, subjectKey, exceptId = null) {
    if (typeof subjectKey !== 'string' || subjectKey === '') return
    for (const entry of this.listEntries(packId)) {
      if (entry.subjectKey === subjectKey && entry.id !== exceptId && !isExpired(entry)) {
        throw new SubjectConflictError(
          `subjectKey "${subjectKey}" 已被条目 ${entry.name}（id ${entry.id}）占用；请改用更新该条目的方式（revision+1），一 subject 一活跃值。`,
          { holderId: entry.id, holderName: entry.name },
        )
      }
    }
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
   * @param {string} scope 'daily' | 'project-<slug>' | 任意安全 slug
   * @param {string} text
   */
  appendLog(scope, text) {
    const line = `${new Date().toISOString()}  ${String(typeof text === 'string' ? text : '').trim().slice(0, 2000)}`
    const path = this.logPath(scope)
    mkdirSync(dirname(path), { recursive: true })
    const existed = existsSync(path)
    let content = line + '\n'
    if (existed) content = readFileSync(path, 'utf8') + content
    atomicWriteText(path, content)
    const lines = content.trim().split('\n').length
    return { path, line: lines, scope: this.safeScopeDir(scope) }
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

  readReviewState() {
    const path = safeJoin(this.hubDir, REVIEW_FILE)
    if (!existsSync(path)) return { lastReviewedAt: null, markedTurns: 0 }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      return {
        lastReviewedAt: typeof raw.lastReviewedAt === 'string' ? raw.lastReviewedAt : null,
        markedTurns: Number.isFinite(raw.markedTurns) ? Number(raw.markedTurns) : 0,
      }
    } catch {
      return { lastReviewedAt: null, markedTurns: 0 }
    }
  }

  writeReviewState(state) {
    atomicWriteJson(safeJoin(this.hubDir, REVIEW_FILE), state)
  }
}

/** 是否硬过期。 */
export function isExpired(entry) {
  const expires = typeof entry.expiresAt === 'string' && entry.expiresAt !== '' ? entry.expiresAt : null
  if (expires === null) return false
  const t = Date.parse(expires)
  return Number.isFinite(t) && t < Date.now()
}
