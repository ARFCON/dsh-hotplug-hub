/**
 * dsh-memory-hub / test/update-preservation.test.mjs — update 语义字段保全（H2/S1 根治验收）。
 *
 * 此前缺陷：normalizeEntry 的 eager 默认值让 `normalized.X ?? prev.X` 回退永不生效，
 * memory.update（工具/提案采纳）每次更新都静默擦除 activation/volatility/scope/
 * subjectKey/expiresAt（pinned 降级、subject 防线失效、硬过期丢失）。
 * 根治：update 走 mergeEntry——仅覆盖显式提供的字段，其余保留 prev。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.mjs'
import { MemoryHubService } from '../lib/service.mjs'

function makeService(policy = 'auto', cfg = {}) {
  const hub = mkdtempSync(join(tmpdir(), 'dsh-mh-upd-'))
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const service = new MemoryHubService({
    store,
    config: { writePolicy: policy, ...cfg },
    gate: async () => ({ outcome: policy === 'auto' ? 'allowed' : 'queued', source: policy === 'auto' ? 'gate' : 'proposals' }),
  })
  return { hub, store, service }
}

test('update：未提供的字段全部保留（activation/subjectKey/expiresAt/volatility/scope）', async () => {
  const { hub, store, service } = makeService('auto')
  const r = await service.commit({ entry: { title: '常驻事实', body: 'v1', activation: 'pinned', subjectKey: 'user.pref.theme', expiresAt: '2099-01-01', volatility: 'evergreen', scope: 'project', type: 'user' } })
  const id = r.entry.id
  // 模拟 memory.update 工具的最小载荷（只带要改的字段）
  const res = await service.submit({ action: 'update', packId: store.listPackIds()[0], entry: { id, body: 'v2' }, reason: 'memory.update' })
  assert.equal(res.approved, true)
  const after = store.findById(id).entry
  assert.equal(after.body, 'v2', '显式字段应更新')
  assert.equal(after.activation, 'pinned', 'activation 必须保留（此前被擦成 relevant）')
  assert.equal(after.subjectKey, 'user.pref.theme', 'subjectKey 必须保留（此前被擦成空）')
  assert.equal(after.expiresAt, '2099-01-01', 'expiresAt 必须保留')
  assert.equal(after.volatility, 'evergreen', 'volatility 必须保留')
  assert.equal(after.scope, 'project', 'scope 必须保留')
  assert.equal(after.title, '常驻事实', 'title 未提供应保留')
  assert.equal(after.revision, 2, 'revision 单调 +1')
  rmSync(hub, { recursive: true, force: true })
})

test('update：显式提供字段可改（含改 pinned→relevant / 清 expiresAt）', async () => {
  const { hub, store, service } = makeService('auto')
  const r = await service.commit({ entry: { title: '改我', activation: 'pinned', expiresAt: '2099-01-01' } })
  const id = r.entry.id
  await service.submit({ action: 'update', packId: store.listPackIds()[0], entry: { id, activation: 'relevant', expiresAt: null, title: '改名后' } })
  const after = store.findById(id).entry
  assert.equal(after.activation, 'relevant', '显式提供才覆盖')
  assert.equal(after.expiresAt, null, '显式 null = 清除过期')
  assert.equal(after.title, '改名后')
  assert.equal(after.name, r.entry.name, 'name（文件名锚点）不可变')
  rmSync(hub, { recursive: true, force: true })
})

test('update（ask 门→采纳链）：提案 entry 缺省字段同样保留', async () => {
  const { hub, store } = makeService('ask')
  const svc = new MemoryHubService({ store, config: { writePolicy: 'ask' }, gate: async () => ({ outcome: 'queued', source: 'proposals' }) })
  const base = await svc.applyCreateOrUpdate('global-pack', { title: '基线', activation: 'pinned', subjectKey: 'k.v' })
  const r = await svc.submit({ action: 'update', packId: 'global-pack', entry: { id: base.id, title: '仅改标题' }, reason: 'memory.update' })
  await svc.adopt('global-pack', r.proposalId)
  const after = store.findById(base.id).entry
  assert.equal(after.activation, 'pinned', '采纳 update 提案不擦 activation')
  assert.equal(after.subjectKey, 'k.v', '采纳 update 提案不擦 subjectKey')
  assert.equal(after.title, '仅改标题')
  assert.equal(after.revision, 2)
  rmSync(hub, { recursive: true, force: true })
})

test('update：目标不存在（已归档/删除/竞态）→ NotFoundError，绝不 create 复活', async () => {
  const { hub, store, service } = makeService('auto')
  const r = await service.commit({ entry: { title: '将被删' } })
  await service.removeDirect(r.entry.id)
  await assert.rejects(
    service.submit({ action: 'update', packId: store.listPackIds()[0], entry: { id: r.entry.id, body: 'x' } }),
    (err) => err.code === 'NOT_FOUND',
  )
  assert.equal(store.findById(r.entry.id), null, '不得复活活跃条目')
  const archived = store.allArchived()
  assert.equal(archived.filter((a) => a.entry.id === r.entry.id).length, 1, '归档副本恰好一份（无双态）')
  rmSync(hub, { recursive: true, force: true })
})

test('update：目标在别的包 → NotFoundError（pack 归属校验）', async () => {
  const { hub, store, service } = makeService('auto')
  store.createPack({ memoryPackId: 'other-pack', scope: 'global' })
  const r = await service.commit({ entry: { title: '在全局包' }, pack: 'global-pack' })
  await assert.rejects(
    service.submit({ action: 'update', packId: 'other-pack', entry: { id: r.entry.id, body: 'x' } }),
    (err) => err.code === 'NOT_FOUND',
  )
  rmSync(hub, { recursive: true, force: true })
})

test('update（AI 轨道）：不置 lastVerifiedAt（人工核验语义不被 AI 路径伪造）', async () => {
  const { hub, store, service } = makeService('auto')
  const r = await service.commit({ entry: { title: 'AI 改' } })
  await service.submit({ action: 'update', packId: store.listPackIds()[0], entry: { id: r.entry.id, body: 'x' } })
  assert.equal(store.findById(r.entry.id).entry.lastVerifiedAt, null)
  rmSync(hub, { recursive: true, force: true })
})

test('update：title 传空串 → 保留旧标题（不静默替换成 name slug）', async () => {
  const { hub, store, service } = makeService('auto')
  const r = await service.commit({ entry: { title: '原标题' } })
  await service.submit({ action: 'update', packId: store.listPackIds()[0], entry: { id: r.entry.id, title: '', body: 'x' } })
  assert.equal(store.findById(r.entry.id).entry.title, '原标题')
  rmSync(hub, { recursive: true, force: true })
})

test('updateDirect（GUI 轨道）：同样仅覆盖显式字段 + revision+1 + 用户审计 + 人工核验时间戳', async () => {
  const { hub, store, service } = makeService('auto')
  const r = await service.commit({ entry: { title: 'GUI 编辑', activation: 'pinned', keywords: ['旧词'] } })
  const entry = service.updateDirect({ id: r.entry.id, title: 'GUI 编辑后', keywords: ['新词'] })
  assert.equal(entry.revision, 2)
  assert.equal(entry.activation, 'pinned', 'GUI 编辑同样保留未提供的 activation')
  assert.ok(typeof entry.lastVerifiedAt === 'string' && entry.lastVerifiedAt !== '', 'GUI 编辑应落 lastVerifiedAt（人工核验 → freshness 恒 fresh 通道）')
  const again = store.findById(r.entry.id).entry
  assert.deepEqual(again.keywords, ['新词'])
  assert.equal(again.body, '')
  const auditRow = store.auditList({ limit: 50 }).find((row) => row.action === 'update' && row.operator === 'user')
  assert.ok(auditRow, 'GUI 直接编辑应落 operator=user 审计行')
  rmSync(hub, { recursive: true, force: true })
})

test('create 同名合并：未提供字段保留（与 update 同一合并语义）', async () => {
  const { hub, store, service } = makeService('auto')
  await service.commit({ entry: { title: '同名义', name: 'rule-x', activation: 'pinned', subjectKey: 'a.b' } })
  await service.commit({ entry: { title: '同名义', name: 'rule-x', body: '补正文' } })
  const e = store.listEntries('global-pack').find((x) => x.name === 'rule-x')
  assert.equal(e.revision, 2, '同名 create = 更新 revision+1')
  assert.equal(e.activation, 'pinned', '同名 create 不擦 activation')
  assert.equal(e.subjectKey, 'a.b', '同名 create 不擦 subjectKey')
  assert.equal(e.body, '补正文')
  rmSync(hub, { recursive: true, force: true })
})

test('update：非法 id / 缺 id → InvalidInputError', async () => {
  const { hub, store, service } = makeService('auto')
  await assert.rejects(
    service.submit({ action: 'update', packId: 'global-pack', entry: { body: 'x' } }),
    (err) => err.code === 'INVALID_INPUT',
  )
  await assert.rejects(
    service.submit({ action: 'update', packId: 'global-pack', entry: { id: 'not-an-id', body: 'x' } }),
    (err) => err.code === 'INVALID_INPUT',
  )
  rmSync(hub, { recursive: true, force: true })
})

test('未知 action 在审计前拒绝（不再产生 allowed 审计噪声）', async () => {
  const { hub, store, service } = makeService('auto')
  await assert.rejects(
    service.submit({ action: 'delete', packId: 'global-pack', entry: { title: 'x' } }),
    (err) => err.code === 'INVALID_INPUT',
  )
  const rows = store.auditList({ limit: 50 })
  assert.equal(rows.length, 0, '未知动作不应落任何审计行（此前先 authorize 再校验）')
  rmSync(hub, { recursive: true, force: true })
})
