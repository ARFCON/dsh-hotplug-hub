// test/protocol.test.mjs — 写语义核心 + 审批门 + 审计（服务层强制点）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.mjs'
import { MemoryHubService } from '../lib/service.mjs'
import { BudgetExceededError, WriteDeniedError, SubjectConflictError, NotFoundError } from '../lib/errors.mjs'

function mount({ writePolicy = 'ask', maxPendingProposals } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-hub-protocol-'))
  const store = new MemoryStore(dir)
  store.ensureDefaultPack()
  const config = { writePolicy, maxPendingProposals, snapshotChars: 2560, searchLimit: 4 }
  const gate = async () => {
    if (writePolicy === 'auto') return { outcome: 'allowed', source: 'gate' }
    if (writePolicy === 'off') return { outcome: 'rejected', source: 'gate' }
    return { outcome: 'queued', source: 'proposals' }
  }
  const service = new MemoryHubService({
    store,
    config,
    gate,
    sourceLabel: 'memory-hub',
  })
  return { dir, store, service }
}

const fact = (overrides = {}) => ({
  title: 'DSH 插件构建规则',
  description: '插件包用 dev_build_plugin 构建',
  body: '插件生产线：dev_scaffold → dev_build → dev_inject。',
  type: 'project',
  keywords: ['构建', 'build'],
  ...overrides,
})

test('ask 策略：写意图落到提案队列（不落条目）', async () => {
  const { store, service } = mount()
  const res = await service.commit({ entry: fact(), reason: '测试沉淀' })
  assert.equal(res.approved, false)
  assert.ok(res.proposalId && res.proposalId.startsWith('p-'))
  assert.equal(store.allEntries().length, 0, 'ask 不直写')
  assert.equal(store.allProposals('pending').length, 1)
  const proposal = store.allProposals('pending')[0]
  assert.equal(proposal.kind, 'create')
  assert.ok(proposal.reason.includes('测试'))
})

test('采纳提案 → 落条目 + 包计数 + 审计', async () => {
  const { store, service } = mount()
  const res = await service.commit({ entry: fact(), reason: 'r' })
  await service.adopt('global-pack', res.proposalId)
  const entries = store.allEntries()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].entry.title, 'DSH 插件构建规则')
  assert.equal(store.readPack('global-pack').entries, 1, 'pack.json entries 计数同步')
  const audits = store.auditList()
  // queued + snapshot + adopted 至少 3 行（queued 在采纳前）
  assert.ok(audits.some((r) => r.action === 'adopt' && r.outcome === 'ok'))
  assert.ok(audits.some((r) => r.outcome === 'queued'))
})

test('auto 策略：直写（approval via gate）', async () => {
  const { store, service } = mount({ writePolicy: 'auto' })
  const res = await service.commit({ entry: fact(), reason: '用户口述' })
  assert.equal(res.approved, true)
  assert.equal(store.allEntries().length, 1)
  const audits = store.auditList()
  assert.ok(audits.some((r) => r.outcome === 'allowed' && r.operator === 'agent'))
})

test('off 策略：写入整体拒绝并落 denied 审计', async () => {
  const { store, service } = mount({ writePolicy: 'off' })
  await assert.rejects(() => service.commit({ entry: fact() }), WriteDeniedError)
  assert.equal(store.allEntries().length, 0)
  assert.ok(store.auditList().some((r) => r.outcome.includes('denied') || r.outcome.includes('rejected')))
})

test('同名写入 = 更新（revision+1 + snapshot）', async () => {
  const { store, service } = mount({ writePolicy: 'auto' })
  await service.commit({ entry: fact({ name: 'rule', title: '规则 v1' }), reason: '' })
  await service.commit({ entry: fact({ name: 'rule', title: '规则 v2' }), reason: '' })
  const entries = store.allEntries()
  assert.equal(entries.length, 1, '同名不新增')
  assert.equal(entries[0].entry.title, '规则 v2')
  assert.equal(entries[0].entry.revision, 2)
  const revisions = store.listRevisions('global-pack', entries[0].entry.id)
  assert.deepEqual(revisions, [1], 'v1 已 snapshot')
})

test('subjectKey 冲突：新建被拒并指向 holder，同条更新允许', async () => {
  const { store, service } = mount({ writePolicy: 'auto' })
  await service.commit({ entry: fact({ title: 'A', subjectKey: 'pkg.mgr' }), reason: '' })
  await assert.rejects(
    () => service.commit({ entry: fact({ title: 'B', subjectKey: 'pkg.mgr' }), reason: '' }),
    (error) => error instanceof SubjectConflictError && error.details?.holderName !== undefined,
  )
  // 同一条目更新 subjectKey（name 相同=更新）
  const holder = store.findById(store.allEntries()[0].entry.id)
  await service.commit({ entry: fact({ name: holder.entry.name, title: 'A 更新', subjectKey: 'pkg.mgr' }), reason: '' })
  const entries = store.allEntries()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].entry.title, 'A 更新')
})

test('remove：归档 + revision + 条目消失；restore 恢复', async () => {
  const { store, service } = mount({ writePolicy: 'auto' })
  await service.commit({ entry: fact(), reason: '' })
  const target = store.allEntries()[0].entry
  const res = await service.submit({ action: 'remove', packId: 'global-pack', entry: { id: target.id } })
  assert.equal(res.approved, true)
  assert.equal(store.allEntries().length, 0)
  assert.equal(store.listArchived('global-pack').length, 1)
  const restored = service.restoreArchived('global-pack', target.name)
  assert.equal(store.allEntries().length, 1)
  assert.equal(restored.name, target.name)
  assert.ok(store.auditList().some((r) => r.action === 'restore'))
})

test('预算：提案队列到达上限报 BUDGET_EXCEEDED 且不截断', async () => {
  const { service } = mount({ maxPendingProposals: 2 })
  await service.commit({ entry: fact({ title: 'P1' }), reason: '' })
  await service.commit({ entry: fact({ title: 'P2' }), reason: '' })
  await assert.rejects(
    () => service.commit({ entry: fact({ title: 'P3' }), reason: '' }),
    (error) => error instanceof BudgetExceededError,
  )
})

test('search：路由 + BM25 端到端', async () => {
  const { store, service } = mount({ writePolicy: 'auto' })
  store.writeRoutes({ schemaVersion: 1, routes: [{ keywords: ['构建', 'build'], packId: 'global-pack' }], fallbackPackId: 'global-pack' })
  await service.commit({ entry: fact(), reason: '' })
  await service.commit({ entry: fact({ title: '买菜清单', body: '鸡蛋 牛奶' }), reason: '' })
  const res = service.search('构建')
  assert.equal(res.pack, 'global-pack')
  assert.ok(res.hits.length >= 1)
  assert.ok(res.hits[0].matchesList === undefined)
  const ordered = res.hits.map((h) => h.id)
  assert.ok(ordered.length >= 1)
  assert.ok(res.warning.length > 0, '带不可信声明')
})

test('search ask 未采纳条目不可见（防泄漏未批准记忆）', async () => {
  const { service } = mount()
  await service.commit({ entry: fact({ title: '未采纳秘密' }), reason: '' })
  const res = service.search('秘密')
  assert.equal(res.count, 0, '未采纳提案不参与检索')
})

test('restore/reject/not-found 边界', async () => {
  const { store, service } = mount()
  await assert.rejects(() => service.adopt('global-pack', 'p-none'), NotFoundError)
  // restoreArchived / reject 为同步抛错
  assert.throws(() => service.restoreArchived('global-pack', 'nope'), NotFoundError)
  assert.throws(() => service.reject('global-pack', 'p-none'), NotFoundError)
})
