/**
 * dsh-memory-hub / lib/protocol.mjs — 「dsh-memory-protocol」写语义核心（零 DSH 依赖）。
 *
 * 职责（对齐 dsh-memento MemoryProtocolCore 的工程思想，独立实现）：
 *  - 所有写路径（create/update/remove/restore）的强制点都在这里（协议层），
 *    不在工具层——模型无法绕过审批门。
 *  - MemoryHubService 继承本核心，注入 gate（index.mjs 把 writePolicy 裁决接进来）。
 *  - gate 三态：allowed=直写（auto/已确认）；queued=进提案队列（ask 默认）；
 *    rejected=拒绝（denied，Nothing written）——全部落审计。
 *  - 写前 budget 检查、subject 冲突检查、name 唯一化、revision 快照、审计行。
 */
import { DEFAULTS, NAME_RE, STRINGS } from './constants.mjs'
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

function assertEnum(name, value, allowed) {
  if (value !== undefined && value !== null && !allowed.includes(value)) {
    throw new InvalidInputError(`${name} 非法：${String(value)}（允许 ${allowed.join('/')}）`)
  }
}

/**
 * @typedef {object} GateResult
 * @property {'allowed'|'queued'|'rejected'|'denied'} outcome
 * @property {'approval'|'gate'|'proposals'} [source]
 * @property {string} [detail]
 */

export class MemoryProtocolCore {
  /**
   * @param {object} deps
   * @param {import('./store.mjs').MemoryStore} deps.store
   * @param {{writePolicy: string, maxPendingProposals?: number, snapshotChars?: number, reviewEveryTurns?: number}} deps.config
   * @param {(payload: object, write: object) => Promise<GateResult>} deps.gate  默认门=ask→queued
   * @param {string} [deps.sourceLabel]  审计 source 标签
   * @param {(change: {action: string, packId: string, name?: string, proposalId?: string}) => void} [deps.notify]  变更回调（M2 尾部注入）
   */
  constructor(deps) {
    this.store = deps.store
    this.config = deps.config
    this.sourceLabel = deps.sourceLabel ?? 'memory-hub'
    this.gate = deps.gate ?? (async () => ({ outcome: 'queued', source: 'proposals' }))
    this.notify = typeof deps.notify === 'function' ? deps.notify : null
    /** 会话内记忆变更计数（M3 审查定级用；跨 restarts 以 review-state.json 存 lastReviewedAt）。 */
    this.changeCount = 0
  }

  /**
   * 统一写入口（工具/命令全部走这里）。
   * @param {object} intent {action:'create'|'update'|'remove', packId?, entry?, reason?}
   * @returns {Promise<{approved: boolean, entry?: object, removed?: object, proposalId?: string}>}
   */
  async submit(intent) {
    const action = intent.action
    const packId = this.resolvePack(intent.packId)
    const entry = intent.entry ?? null
    if (entry !== null) this.validateEntryShape(entry)

    if (action === 'create' || action === 'update') {
      this.checkPendingBudget()
    }

    const write = { action, packId, entryId: entry?.id ?? null, reason: intent.reason ?? '' }
    const result = await this.authorize({
      action, packId, entry: entry === null ? null : { ...entry }, reason: write.reason,
    }, write)

    if (result.outcome === 'allowed') {
      if (action === 'create' || action === 'update') {
        if (entry === null) throw new InvalidInputError('create/update 必须带 entry')
        return { approved: true, entry: this.applyCreateOrUpdate(packId, entry) }
      }
      if (action === 'remove') {
        const id = entry?.id ?? (typeof intent.id === 'string' ? intent.id : null)
        if (id === null || !isEntryId(id)) throw new InvalidInputError('remove 必须带合法 entry.id')
        return { approved: true, removed: this.applyRemove(packId, id) }
      }
      throw new InvalidInputError(`未知写动作：${action}`)
    }

    if (result.outcome === 'queued') {
      const proposal = this.enqueueProposal(packId, { kind: action, entry, reason: write.reason })
      this._postChange({ action: 'proposal', packId, proposalId: proposal.id, name: entry?.title })
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
    try {
      result = (await this.gate(payload, write)) ?? { outcome: 'queued', source: 'proposals' }
    } catch (error) {
      result = { outcome: 'denied', source: 'approval', detail: String(error?.message ?? error) }
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
      operator: 'agent',
      source: this.sourceLabel,
      outcome: via.outcome,
      via: via.source,
      ...extra,
    })
  }

  checkPendingBudget() {
    const limit = this.config.maxPendingProposals ?? DEFAULTS.maxPendingProposals
    const pending = this.store.allProposals('pending')
    if (pending.length >= limit) {
      throw new BudgetExceededError(
        `待确认提案已达上限（${pending.length}/${limit}），请先处理旧提案（memory review）。`,
        { pending: pending.length, limit },
      )
    }
  }

  enqueueProposal(packId, { kind, entry, reason }) {
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

  /** 变更计数 + 通知（尾部注入回调；协议层单一入口，不依赖 DSH）。 */
  _postChange(change) {
    this.changeCount += 1
    this.notify?.({ at: Date.now(), ...change })
  }

  /**
   * pinned 预算校验（M2）：若该条目 activation=pinned，估算入前缀字符，
   * 超 snapshotChars 抛 BUDGET_EXCEEDED（提示常驻规则进指令文件）。
   * 更新场景排除自身（同名），避免更新自己时误判。
   */
  validatePinnedBudget(packId, entry) {
    if (entry === null || typeof entry !== 'object' || entry.activation !== 'pinned') return
    const budget = Number.isFinite(this.config.snapshotChars) ? this.config.snapshotChars : DEFAULTS.snapshotChars
    const pad = DEFAULTS.pinnedEstimatePad
    const est = (e) => String(e.title ?? '').length + String(e.description ?? '').length + pad
    const current = this.store.allEntries()
      .filter(({ entry: e }) => e.activation === 'pinned' && !isExpired(e))
      .filter(({ packId: p, entry: e }) => !(p === packId && e.name === entry.name))
      .reduce((sum, { entry: e }) => sum + est(e), 0)
    const total = current + est(entry)
    if (total > budget) {
      throw new BudgetExceededError(
        `pinned 预算超限：常驻记忆估算 ${total} 字符 > ${budget}（snapshotChars）。${STRINGS.pinnedBudgetHint}`,
        { chars: total, budget },
      )
    }
  }

  applyCreateOrUpdate(packId, entry) {
    const normalized = this.normalizeEntry(entry)
    this.validateEntryShape(normalized)
    if (this.store.hasEntry(packId, normalized.name)) {
      // 同名 = 更新（revision+1），subject 冲突检查跳过（同条目）
      const prev = this.store.readEntry(packId, normalized.name)
      const now = new Date().toISOString()
      this.store.snapshotRevision(packId, prev)
      const next = {
        ...prev,
        updatedAt: now,
        revision: prev.revision + 1,
        title: normalized.title ?? prev.title,
        description: normalized.description ?? prev.description,
        type: normalized.type ?? prev.type,
        scope: normalized.scope ?? prev.scope,
        activation: normalized.activation ?? prev.activation,
        volatility: normalized.volatility ?? prev.volatility,
        subjectKey: normalized.subjectKey ?? prev.subjectKey,
        expiresAt: normalized.expiresAt ?? prev.expiresAt,
        keywords: normalized.keywords ?? prev.keywords,
        body: normalized.body ?? prev.body,
        want: undefined,
      }
      this.validatePinnedBudget(packId, next)
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

  /** 统一条目规范化（补默认、校验）；生成 id/name/timestamps。 */
  normalizeEntry(input) {
    const now = new Date().toISOString()
    const name = typeof input.name === 'string' && NAME_RE.test(input.name)
      ? input.name
      : slugify(typeof input.title === 'string' ? input.title : 'untitled')
    return {
      id: isEntryId(input.id) ? input.id : newMemoryId(),
      revision: 1,
      createdAt: now,
      updatedAt: now,
      name,
      title: (typeof input.title === 'string' && input.title.trim() !== '') ? input.title.trim().slice(0, 200) : name,
      description: typeof input.description === 'string' ? input.description.slice(0, 500) : '',
      type: input.type ?? 'project',
      scope: input.scope ?? 'global',
      activation: input.activation ?? 'relevant',
      volatility: input.volatility ?? 'stable',
      subjectKey: typeof input.subjectKey === 'string' ? input.subjectKey : '',
      expiresAt: typeof input.expiresAt === 'string' && input.expiresAt !== '' ? input.expiresAt : null,
      lastVerifiedAt: null,
      keywords: Array.isArray(input.keywords) ? input.keywords.filter((k) => typeof k === 'string').slice(0, 24) : [],
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

  async adopt(packId, proposalId) {
    const proposal = this.store.listProposals(packId, 'any').find((p) => p.id === proposalId)
    if (proposal === undefined) throw new NotFoundError(`提案不存在：${proposalId}`)
    if (proposal.status !== 'pending') throw new InvalidInputError(`提案状态为 ${proposal.status}，不能重复采纳`)
    let result
    try {
      if (proposal.kind === 'create' || proposal.kind === 'update') {
        result = this.applyCreateOrUpdate(packId, proposal.entry)
      } else if (proposal.kind === 'remove') {
        if (!isEntryId(proposal.entry?.id)) throw new InvalidInputError('remove 提案缺少合法 entry.id')
        result = this.applyRemove(packId, proposal.entry.id)
      } else {
        throw new InvalidInputError(`未知提案类型：${proposal.kind}`)
      }
    } catch (error) {
      this.store.setProposalStatus(packId, proposalId, 'rejected', { reason: String(error?.message ?? error) })
      this.store.auditAppend({ action: 'adopt', packId, proposalId, operator: 'user', outcome: 'failed', detail: String(error?.message ?? error) })
      throw error
    }
    this.store.setProposalStatus(packId, proposalId, 'adopted', { entryId: result?.id ?? null })
    this.store.auditAppend({ action: 'adopt', packId, proposalId, operator: 'user', outcome: 'ok', detail: `entry ${result?.id}` })
    return { adopted: proposalId, result }
  }

  reject(packId, proposalId, reason) {
    this.store.setProposalStatus(packId, proposalId, 'rejected', { reason: reason ?? '' })
    this.store.auditAppend({ action: 'reject', packId, proposalId, operator: 'user', outcome: 'ok', detail: reason })
    this._postChange({ action: 'reject', packId, proposalId })
  }

  restoreArchived(packId, name) {
    const archived = this.store.listArchived(packId).find((item) => item.entry.name === name)
    if (archived === undefined) throw new NotFoundError(`归档条目不存在：${name}（pack ${packId}）`)
    if (this.store.hasEntry(packId, name)) throw new InvalidInputError(`条目 ${name} 已存在，恢复前需先 remove`)
    const restored = {
      ...archived.entry,
      updatedAt: new Date().toISOString(),
      archivedAt: undefined,
      revision: this.store.listRevisions(packId, archived.entry.id).length + 1,
    }
    this.store.writeEntryFile(packId, restored)
    this.store.rebuildIndex(packId)
    this.store.syncPackCount(packId)
    this.store.auditAppend({ action: 'restore', packId, entryId: restored.id, operator: 'user', outcome: 'ok' })
    this._postChange({ action: 'restore', packId, name: restored.name })
    return restored
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
  const src = String(title ?? '').trim()
  return 'm-' + (src === '' ? 'untitled' : src).slice(0, 62)
}
