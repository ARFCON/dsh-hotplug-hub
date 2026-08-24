/**
 * dsh-memory-hub / lib/protocol.mjs — 「dsh-memory-protocol」写语义核心（零 DSH 依赖）。
 *
 * 职责（对齐 dsh-memento MemoryProtocolCore 的工程思想，独立实现）：
 *  - 所有写路径（create/update/remove/restore）的强制点都在这里（协议层），
 *    不在工具层——模型无法绕过审批门。
 *  - MemoryHubService 继承本核心，注入 gate（index.mjs 把 writePolicy 裁决接进来）。
 *  - gate 三态：allowed=直写（auto/已确认）；queued=进提案队列（ask 默认）；
 *    rejected=拒绝（denied，Nothing written）——全部落审计。
 *  - 写前 budget 检查、subject 冲突检查、revision 快照、审计行。
 *
 * 锁与可重入：公共写方法（applyCreateOrUpdate/applyRemove/restoreArchived/
 * adopt/reject）各自持跨进程写锁；锁内逻辑拆到 *Locked 核心，供组合写流
 * （adopt = 改提案状态 + 落条目）在同一把锁内完成，杜绝嵌套自锁。
 */
import { DEFAULTS, NAME_RE, STRINGS, SUBJECT_KEY_RE } from './constants.mjs'
import {
  BudgetExceededError, InvalidInputError, NotFoundError, SubjectConflictError, WriteDeniedError,
} from './errors.mjs'
import { newMemoryId, isEntryId } from './id.mjs'
import { isExpired } from './store.mjs'

const ENUM = {
  types: ['user', 'feedback', 'project', 'reference'],
  scopes: ['global', 'project'],
  activations: ['relevant', 'pinned'],
  volatilities: ['evergreen', 'stable', 'volatile'],
}

const ACTIONS = new Set(['create', 'update', 'remove'])

function assertEnum(name, value, allowed) {
  if (value !== undefined && value !== null && value !== '' && !allowed.includes(value)) {
    throw new InvalidInputError(`${name} 非法：${String(value)}（允许 ${allowed.join('/')}）`)
  }
}

/** 快照渲染的 pinned 单行（与 index.mjs snapshotText 单一真源；预算校验用同一格式）。 */
export function pinnedLineOf(packId, entry) {
  return `- ${entry.title}${entry.description ? ` — ${entry.description}` : ''} (pack:${packId})`
}

/** 快照 pinned 区块头（含首尾换行，长度与渲染一致）。 */
const PINNED_BLOCK_HEADER = '\n\n## 常驻记忆（pinned）\n'
/** 固定提示行（渲染时的完整注入形态）。 */
const FIXED_PROMPT = `\n\n> ${STRINGS.fixedPromptLine}`
/** 校验时为动态 header（# 记忆/计数行）保留的最小空间（渲染端 header 可被钳制）。 */
const HEADER_RESERVE = 24

/**
 * @typedef {object} GateResult
 * @property {'allowed'|'queued'|'rejected'|'denied'} outcome
 * @property {'approval'|'gate'|'proposals'|'suggest'} [source]
 * @property {string} [detail]
 */
export class MemoryProtocolCore {
  /**
   * @param {object} deps
   * @param {import('./store.mjs').MemoryStore} deps.store
   * @param {{writePolicy: string, maxPendingProposals?: number, snapshotChars?: number, reviewEveryTurns?: number}} deps.config
   * @param {(payload: object, write: object) => Promise<GateResult>} deps.gate  默认门=ask→queued
   * @param {string} [deps.sourceLabel]  审计 source 标签
   * @param {(change: {seq: number, at: number, action: string, packId: string, name?: string, proposalId?: string}) => void} [deps.notify]  变更回调（M2 尾部注入）
   */
  constructor(deps) {
    this.store = deps.store
    this.config = deps.config
    this.sourceLabel = deps.sourceLabel ?? 'memory-hub'
    this.gate = deps.gate ?? (async () => ({ outcome: 'queued', source: 'proposals' }))
    this.notify = typeof deps.notify === 'function' ? deps.notify : null
    /**
     * 会话内记忆变更计数（M3 审查定级用）。种子取 review-state.totalChanges，
     * 重启后连续（H6 根治：不再从 0 重开导致 markedTurns 压制 due）。
     */
    this.changeCount = Math.max(0, Number(this.store.readReviewState().totalChanges) || 0)
    /** 尾部注入用单调序号（时间戳同毫秒会丢通知，seq 严格递增不丢）。 */
    this._changeSeq = 0
  }

  /**
   * 统一写入口（工具/命令全部走这里）。
   * @param {object} intent {action:'create'|'update'|'remove', packId?, entry?, reason?, forceQueue?}
   * @returns {Promise<{approved: boolean, entry?: object, removed?: object, proposalId?: string}>}
   */
  async submit(intent) {
    const action = intent.action
    if (!ACTIONS.has(action)) {
      throw new InvalidInputError(`未知写动作：${String(action)}（允许 create/update/remove）`)
    }
    const packId = this.resolvePack(intent.packId)
    const entry = intent.entry ?? null
    if (entry !== null) this.validateEntryShape(entry)

    // 提案队列硬上限对全部动作生效（create/update/remove 提案同池排队）。
    this.checkPendingBudget()

    const write = { action, packId, entryId: entry?.id ?? null, reason: intent.reason ?? '' }
    const result = await this.authorize({
      action, packId, entry: entry === null ? null : { ...entry }, reason: write.reason,
      forceQueue: intent.forceQueue === true,
    }, write)

    if (result.outcome === 'allowed') {
      if (action === 'create' || action === 'update') {
        if (entry === null) throw new InvalidInputError('create/update 必须带 entry')
        return { approved: true, entry: this.applyCreateOrUpdate(packId, entry, action) }
      }
      // remove
      const id = entry?.id ?? (typeof intent.id === 'string' ? intent.id : null)
      if (id === null || !isEntryId(id)) throw new InvalidInputError('remove 必须带合法 entry.id')
      return { approved: true, removed: this.applyRemove(packId, id) }
    }

    if (result.outcome === 'queued') {
      const proposal = this.enqueueProposal(packId, { kind: action, entry, reason: write.reason })
      this._postChange({ action: 'proposal', packId, proposalId: proposal.id, name: entry?.name })
      return { approved: false, proposalId: proposal.id }
    }

    throw new WriteDeniedError(
      `记忆写入未获批（${result.outcome}${result.detail ? `：${result.detail}` : ''}）`,
      { outcome: result.outcome, detail: result.detail },
    )
  }

  // ----- 门 / 审计 -----

  async authorize(payload, write) {
    const policy = this.config.writePolicy ?? 'ask'
    if (policy === 'off') {
      this.auditWrite(write.action, write.packId, write.entryId, { outcome: 'denied', source: 'gate', detail: 'writePolicy=off' })
      throw new WriteDeniedError('记忆写入已被禁用（writePolicy=off）', { policy: 'off' })
    }
    let result
    if (payload.forceQueue) {
      // FR-3：suggest 永远进队列，绝不直写（auto 也不放行）；off 已在上面整体拒绝。
      result = { outcome: 'queued', source: 'suggest' }
    } else {
      try {
        result = (await this.gate(payload, write)) ?? { outcome: 'queued', source: 'proposals' }
      } catch (error) {
        result = { outcome: 'denied', source: 'approval', detail: String(error?.message ?? error) }
      }
    }
    const ok = result.outcome === 'allowed'
    this.auditWrite(write.action, write.packId, write.entryId, {
      outcome: ok ? 'allowed' : result.outcome === 'queued' ? 'queued' : `rejected (${result.outcome})`,
      source: result.source ?? 'gate',
      detail: result.detail,
    })
    return result
  }

  auditWrite(action, packId, entryId, via, extra = {}) {
    this.store.auditAppend({
      action,
      packId: packId ?? null,
      entryId: entryId ?? null,
      operator: via.operator ?? 'agent',
      source: this.sourceLabel,
      outcome: via.outcome,
      via: via.source ?? null,
      ...extra,
    })
  }

  checkPendingBudget() {
    const limit = this.config.maxPendingProposals ?? DEFAULTS.maxPendingProposals
    const pending = this.store.allProposals('pending')
    if (pending.length >= limit) {
      throw new BudgetExceededError(
        `待确认提案已达上限（${pending.length}/${limit}），请先处理旧提案（/memory proposals → adopt/reject）。`,
        { pending: pending.length, limit },
      )
    }
  }

  enqueueProposal(packId, { kind, entry, reason }) {
    // proposalMaxChars：提案单条字符上限（entry 序列化 + reason），超限拒绝不截断（失败要大声）。
    const size = JSON.stringify({ entry: entry ?? null, reason: typeof reason === 'string' ? reason : '' }).length
    if (size > DEFAULTS.proposalMaxChars) {
      throw new BudgetExceededError(
        `提案体积超限：${size} > ${DEFAULTS.proposalMaxChars} 字符（proposalMaxChars）。请精简 body/description 后重试。`,
        { chars: size, limit: DEFAULTS.proposalMaxChars },
      )
    }
    return this.store.appendProposal(packId, {
      kind,
      entry: entry === null ? null : { ...entry },
      reason: typeof reason === 'string' ? reason.slice(0, 500) : '',
    })
  }

  resolvePack(packId) {
    const actual = typeof packId === 'string' && packId !== '' ? packId : this.store.readRoutes().fallbackPackId ?? 'global-pack'
    if (!this.store.hasPack(actual)) throw new NotFoundError(`记忆包不存在：${actual}`)
    return actual
  }

  // ----- 落盘（被门放行后） -----

  /** 变更计数 + 持久化 + 通知（尾部注入回调；协议层单一入口，不依赖 DSH）。 */
  _postChange(change) {
    this.changeCount += 1
    this._changeSeq += 1
    try {
      this.store.bumpReviewTotal(this.changeCount)
    } catch { /* 计数持久化失败不阻断写主流程（review 定级退化为本进程内计数） */ }
    this.notify?.({ seq: this._changeSeq, at: Date.now(), ...change })
  }

  /**
   * pinned 预算校验（M2）：按快照渲染的【精确】行格式估算（pinnedLineOf 单一真源），
   * 含区块头与固定提示行——写时校验与渲染端口径一致，"通过校验仍被截断"不再可能。
   * 更新场景排除自身（同名），避免更新自己时误判。
   */
  validatePinnedBudget(packId, entry) {
    if (entry === null || typeof entry !== 'object' || entry.activation !== 'pinned') return
    const budget = Number.isFinite(this.config.snapshotChars) ? this.config.snapshotChars : DEFAULTS.snapshotChars
    const lineLen = (e, p) => pinnedLineOf(p, e).length + 1
    const others = this.store.allEntries()
      .filter(({ entry: e }) => e.activation === 'pinned' && !isExpired(e))
      .filter(({ packId: p, entry: e }) => !(p === packId && e.name === entry.name))
    const current = others.reduce((sum, { packId: p, entry: e }) => sum + lineLen(e, p), 0)
    const total = current + lineLen(entry, packId) + PINNED_BLOCK_HEADER.length + FIXED_PROMPT.length + 8 + HEADER_RESERVE
    if (total > budget) {
      throw new BudgetExceededError(
        `pinned 预算超限：常驻记忆估算 ${total} 字符 > ${budget}（snapshotChars）。${STRINGS.pinnedBudgetHint}`,
        { chars: total, budget },
      )
    }
  }

  /**
   * 创建或更新条目（公共入口：持跨进程写锁）。
   * @param {string} packId
   * @param {object} entry 写意图
   * @param {'create'|'update'} mode create=同名合并更新（文档语义）；update=按 id 严格定位（缺失即 NotFound）
   */
  applyCreateOrUpdate(packId, entry, mode = 'create') {
    return this.store.withWriteLock(() => this._applyCreateOrUpdateLocked(packId, entry, mode))
  }

  _applyCreateOrUpdateLocked(packId, entry, mode) {
    if (mode === 'update') {
      // update 语义：按 id 定位既有条目，仅覆盖显式提供的字段；目标缺失（已归档/
      // 损坏/竞态删除）→ NotFoundError，绝不以 create 分支复活（revision 回跳 +
      // 活跃/归档双态）。id 必须合法且在本包内。
      if (!isEntryId(entry?.id)) throw new InvalidInputError('update 必须带合法 entry.id')
      const found = this.store.findById(entry.id)
      if (found === null || found.packId !== packId) {
        throw new NotFoundError(`条目不存在：${entry.id}（pack ${packId}；可能已被归档或删除）`)
      }
      const next = this.mergeEntry(found.entry, entry)
      // 合并终态校验：直连 applyCreateOrUpdate 的调用方（不经 submit 的预校验）
      // 也不能把非法枚举/subjectKey 落盘（否则该条目下次读取即被当损坏文件跳过）
      this.validateEntryShape(next)
      this.validatePinnedBudget(packId, next)
      // 同条目自身持有的 subjectKey 会被 holder 的 id 比对豁免；变更到他人持有者则抛冲突
      this.assertSubjectFree(packId, next)
      this.store.snapshotRevision(packId, found.entry)
      this.store.writeEntryFile(packId, next)
      this.store.rebuildIndex(packId)
      this.store.syncPackCount(packId)
      this._postChange({ action: 'update', packId, name: next.name })
      return next
    }
    // create 语义：同名 = 更新（revision+1，文档化行为）；否则新建。
    const normalized = this.normalizeEntry(entry)
    this.validateEntryShape(normalized)
    if (this.store.hasEntry(packId, normalized.name)) {
      // 同名 = 更新（revision+1）。与 update 同一合并语义：以【原始意图】合并
      // （未提供的字段保留 prev；normalizeEntry 的默认值只用于全新建）。
      // subjectKey 变更时同样要校验冲突：把条目从旧 subjectKey 挪到已被他人
      // 持有的新 subjectKey 会制造"一 subject 两活跃值"。
      const prev = this.store.readEntry(packId, normalized.name)
      if (prev === null) {
        throw new NotFoundError(`条目文件无法解析：${normalized.name}（pack ${packId}；文件可能损坏，请修复或删除后再写）`)
      }
      const next = this.mergeEntry(prev, entry)
      this.validateEntryShape(next)
      this.validatePinnedBudget(packId, next)
      this.assertSubjectFree(packId, next)
      this.store.snapshotRevision(packId, prev)
      this.store.writeEntryFile(packId, next)
      this.store.rebuildIndex(packId)
      this.store.syncPackCount(packId)
      this._postChange({ action: 'update', packId, name: next.name })
      return next
    }
    this.validatePinnedBudget(packId, normalized)
    this.assertSubjectFree(packId, normalized)
    this.store.writeEntryFile(packId, normalized)
    this.store.rebuildIndex(packId)
    this.store.syncPackCount(packId)
    this._postChange({ action: 'create', packId, name: normalized.name })
    return normalized
  }

  applyRemove(packId, id) {
    return this.store.withWriteLock(() => this._applyRemoveLocked(packId, id))
  }

  _applyRemoveLocked(packId, id) {
    const found = this.store.findById(id)
    if (found === null || found.packId !== packId) throw new NotFoundError(`条目不存在：${id}（pack ${packId}）`)
    this.store.snapshotRevision(found.packId, found.entry)
    this.store.archiveEntry(found.packId, found.entry)
    this.store.deleteEntryFile(found.packId, found.entry.name)
    this.store.rebuildIndex(packId)
    this.store.syncPackCount(packId)
    this._postChange({ action: 'remove', packId, name: found.entry.name })
    return { id: found.entry.id, name: found.entry.name }
  }

  /**
   * 更新合并：仅覆盖写意图里【显式提供】的字段，其余一律保留 prev。
   * （normalizeEntry 的 eager 默认值只用于 create；update 走这里，彻底消除
   * "默认值碰巧非空 → ?? 回退失效 → activation/subjectKey/expiresAt 被擦除"。）
   * name/id/createdAt 不可变（filename/身份/历史锚点）。
   */
  mergeEntry(prev, intent) {
    const now = new Date().toISOString()
    const provided = (v) => v !== undefined
    const titleProvided = typeof intent.title === 'string' && intent.title.trim() !== ''
    return {
      ...prev,
      updatedAt: now,
      revision: prev.revision + 1,
      title: titleProvided ? intent.title.trim().slice(0, 200) : prev.title,
      description: provided(intent.description)
        ? (typeof intent.description === 'string' ? intent.description.slice(0, 500) : '')
        : prev.description,
      body: provided(intent.body)
        ? (typeof intent.body === 'string' ? intent.body : '')
        : prev.body,
      type: provided(intent.type) && intent.type !== '' ? intent.type : prev.type,
      scope: provided(intent.scope) && intent.scope !== '' ? intent.scope : prev.scope,
      activation: provided(intent.activation) && intent.activation !== '' ? intent.activation : prev.activation,
      volatility: intent.volatility === undefined ? prev.volatility : (intent.volatility === '' ? '' : intent.volatility),
      subjectKey: provided(intent.subjectKey) ? (typeof intent.subjectKey === 'string' ? intent.subjectKey : '') : prev.subjectKey,
      expiresAt: provided(intent.expiresAt)
        ? (typeof intent.expiresAt === 'string' && intent.expiresAt !== '' ? intent.expiresAt : null)
        : prev.expiresAt,
      // lastVerifiedAt 仅人工核验路径（GUI updateDirect）显式提供；AI 路径不置 → 保留 prev
      lastVerifiedAt: typeof intent.lastVerifiedAt === 'string' && intent.lastVerifiedAt !== ''
        ? intent.lastVerifiedAt
        : (prev.lastVerifiedAt ?? null),
      keywords: Array.isArray(intent.keywords)
        ? intent.keywords.filter((k) => typeof k === 'string').map((k) => k.trim()).filter(Boolean).slice(0, 24)
        : prev.keywords,
      tagged: prev.tagged ?? [],
      archivedAt: undefined,
    }
  }

  /** 统一条目规范化（create 路径：补默认、校验）；生成 id/name/timestamps。'' 视为未指定。 */
  normalizeEntry(input) {
    const now = new Date().toISOString()
    const name = typeof input.name === 'string' && NAME_RE.test(input.name)
      ? input.name
      : slugify(typeof input.title === 'string' ? input.title : 'untitled')
    const pick = (v, fallback) => (v !== undefined && v !== null && v !== '' ? v : fallback)
    return {
      id: isEntryId(input.id) ? input.id : newMemoryId(),
      revision: 1,
      createdAt: now,
      updatedAt: now,
      name,
      title: (typeof input.title === 'string' && input.title.trim() !== '') ? input.title.trim().slice(0, 200) : name,
      description: typeof input.description === 'string' ? input.description.slice(0, 500) : '',
      type: pick(input.type, 'project'),
      scope: pick(input.scope, 'global'),
      activation: pick(input.activation, 'relevant'),
      volatility: input.volatility ?? '',
      subjectKey: typeof input.subjectKey === 'string' ? input.subjectKey : '',
      expiresAt: typeof input.expiresAt === 'string' && input.expiresAt !== '' ? input.expiresAt : null,
      lastVerifiedAt: null,
      keywords: Array.isArray(input.keywords)
        ? input.keywords.filter((k) => typeof k === 'string').map((k) => k.trim()).filter(Boolean).slice(0, 24)
        : [],
      tagged: [],
      body: typeof input.body === 'string' ? input.body : '',
    }
  }

  validateEntryShape(entry) {
    if (entry === null || typeof entry !== 'object') return
    assertEnum('type', entry.type, ENUM.types)
    assertEnum('scope', entry.scope, ENUM.scopes)
    assertEnum('activation', entry.activation, ENUM.activations)
    assertEnum('volatility', entry.volatility, ENUM.volatilities)
    if (entry.subjectKey !== undefined && entry.subjectKey !== null && typeof entry.subjectKey !== 'string') {
      throw new InvalidInputError('subjectKey 必须是字符串')
    }
    if (typeof entry.subjectKey === 'string' && !SUBJECT_KEY_RE.test(entry.subjectKey)) {
      throw new InvalidInputError(`subjectKey 非法：${JSON.stringify(entry.subjectKey)}（须为小写字母数字/_- 的点分段 key 或空串）`)
    }
  }

  assertSubjectFree(packId, entry) {
    if (typeof entry.subjectKey !== 'string' || entry.subjectKey === '') return
    const holder = this.store.subjectHolder(packId, entry.subjectKey)
    if (holder !== null && holder.holder.id !== entry.id) {
      throw new SubjectConflictError(
        `subjectKey "${entry.subjectKey}" 已被条目 ${holder.holder.name}（id ${holder.holder.id}）占用；请改用更新（revision+1）而非新建。`,
        { holderId: holder.holder.id, holderName: holder.holder.name },
      )
    }
  }

  // ----- 提案采纳 / 驳回 / 恢复 -----

  /**
   * 采纳提案：提案状态复查 + 落条目 + 状态落定在同一把写锁内完成
   * （check-then-act 竞态根治：并发双击/跨进程双采纳恰一个成功）。
   */
  async adopt(packId, proposalId) {
    return this.store.withWriteLock(() => {
      const proposal = this.store.listProposals(packId, 'any').find((p) => p.id === proposalId)
      if (proposal === undefined) throw new NotFoundError(`提案不存在：${proposalId}`)
      if (proposal.status !== 'pending') throw new InvalidInputError(`提案状态为 ${proposal.status}，不能重复采纳`)
      let result
      try {
        if (proposal.kind === 'create' || proposal.kind === 'update') {
          result = this._applyCreateOrUpdateLocked(packId, proposal.entry, proposal.kind)
        } else if (proposal.kind === 'remove') {
          if (!isEntryId(proposal.entry?.id)) throw new InvalidInputError('remove 提案缺少合法 entry.id')
          result = this._applyRemoveLocked(packId, proposal.entry.id)
        } else {
          throw new InvalidInputError(`未知提案类型：${proposal.kind}`)
        }
      } catch (error) {
        this.store.setProposalStatus(packId, proposalId, 'rejected', { reason: String(error?.message ?? error) })
        this.store.auditAppend({ action: 'adopt', packId, proposalId, operator: 'user', source: this.sourceLabel, via: 'user-action', outcome: 'failed', detail: String(error?.message ?? error) })
        throw error
      }
      this.store.setProposalStatus(packId, proposalId, 'adopted', { entryId: result?.id ?? null })
      this.store.auditAppend({ action: 'adopt', packId, proposalId, operator: 'user', source: this.sourceLabel, via: 'user-action', outcome: 'ok', detail: `entry ${result?.id}` })
      return { adopted: proposalId, result }
    })
  }

  /** 驳回提案（锁内改状态 + 审计 + 尾部通知）。 */
  reject(packId, proposalId, reason) {
    return this.store.withWriteLock(() => {
      this.store.setProposalStatus(packId, proposalId, 'rejected', { reason: reason ?? '' })
      this.store.auditAppend({ action: 'reject', packId, proposalId, operator: 'user', source: this.sourceLabel, via: 'user-action', outcome: 'ok', detail: reason })
      this._postChange({ action: 'reject', packId, proposalId })
      return { rejected: proposalId }
    })
  }

  /**
   * 恢复归档条目（公共入口：持锁）。恢复与 create/update 同一校验面：
   * subjectKey 冲突 + pinned 预算——恢复不得绕过「一 subject 一活跃值」与
   * 快照预算防线（此前 restore 直写可凭空突破两者）。
   */
  restoreArchived(packId, name) {
    return this.store.withWriteLock(() => {
      const archived = this.store.listArchived(packId).find((item) => item.entry.name === name)
      if (archived === undefined) throw new NotFoundError(`归档条目不存在：${name}（pack ${packId}）`)
      if (this.store.hasEntry(packId, name)) throw new InvalidInputError(`条目 ${name} 已存在，恢复前需先 remove`)
      const restored = {
        ...archived.entry,
        updatedAt: new Date().toISOString(),
        archivedAt: undefined,
        revision: archived.entry.revision + 1,
      }
      this.validatePinnedBudget(packId, restored)
      this.assertSubjectFree(packId, restored)
      this.store.writeEntryFile(packId, restored)
      this.store.deleteArchivedFile(packId, name)
      this.store.rebuildIndex(packId)
      this.store.syncPackCount(packId)
      this.store.auditAppend({ action: 'restore', packId, entryId: restored.id, operator: 'user', source: this.sourceLabel, via: 'user-action', outcome: 'ok' })
      this._postChange({ action: 'restore', packId, name: restored.name })
      return restored
    })
  }
}

/**
 * name 由 title 求 slug（kebab，1-64 位，Unicode 字母/数字开头）。
 * Unicode 感知：纯中文标题原样保留中文字符（Windows/文件系统友好），不再塌成 'm-'。
 */
export function slugify(title) {
  const raw = String(title ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  if (NAME_RE.test(raw)) return raw
  // raw 为空 ⟺ 标题无任何字母/数字（纯标点/emoji/符号）。此前 fallback 直接把
  // 原始标题拼到 'm-' 后，会产出含非法字符（如 'm-!!!'、'm-😀'）的 name，随后被
  // assertSafeName 拒绝而抛 InvalidInputError。统一回退为合法 'm-untitled'。
  return 'm-untitled'
}
