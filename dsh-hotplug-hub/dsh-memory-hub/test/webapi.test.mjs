/**
 * dsh-memory-hub / test/webapi.test.mjs — M4 /memory-hub/api 处理器核心单测。
 * （fence/HTTP 壳在 index.mjs host 面，此处验证 buildMemoryApi 纯处理器语义。）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.mjs'
import { MemoryHubService } from '../lib/service.mjs'
import { buildMemoryApi } from '../lib/webapi.mjs'
import { NotFoundError } from '../lib/errors.mjs'

function makeApi(hubDir, writePolicy = 'ask') {
  const store = new MemoryStore(hubDir)
  store.ensureDefaultPack()
  const service = new MemoryHubService({
    store,
    config: { hubDir, writePolicy, reviewEveryTurns: 8 },
    gate: async () => ({ outcome: writePolicy === 'auto' ? 'allowed' : 'queued', source: 'proposals' }),
  })
  return { store, service, api: buildMemoryApi(service) }
}

function tmpHub() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-hub-webapi-'))
}

test('webapi: stats/packs/entries/search 只读面', async () => {
  const { api, service } = makeApi(tmpHub(), 'auto')
  await service.commit({ entry: { title: 'DSH 插件构建规则', body: '构建用 dev_build_plugin', keywords: ['构建', '插件'] } })
  await service.commit({ entry: { title: '用户偏好', body: '喜欢深色', keywords: ['用户'] } })

  const stats = api.stats()
  assert.equal(stats.activeEntries, 2)
  assert.equal(stats.writePolicy, 'auto')
  assert.ok(stats.hubDir.includes('dsh-memory-hub-webapi'))

  const packs = api.packs()
  assert.ok(packs.some((p) => p.memoryPackId === 'global-pack'))

  const entries = api.entries({})
  assert.equal(entries.length, 2)
  const filtered = api.entries({ q: '构建' })
  assert.equal(filtered.length, 1)
  assert.ok(filtered[0].title.includes('构建'))

  const res = api.search({ q: '用户' })
  assert.equal(res.hits.length, 1)
})

test('webapi: ask 门 adopt/reject 全链（用户操作落审计）', async () => {
  const { api, store } = makeApi(tmpHub(), 'ask')
  const st0 = api.stats()
  assert.equal(st0.pendingProposals, 0)

  // commit → 提案
  await api.adopt // noop ref
  const { store: s2 } = makeApi(tmpHub(), 'ask')
  const proposal = await s2
  void proposal

  // 先走 service 侧产生提案，再走 webapi 采纳
  const svc = makeApi(tmpHub(), 'ask')
  const r = await svc.service.commit({ entry: { title: '待审', body: 'x' } })
  assert.ok(r.proposalId)

  const pendingBefore = svc.api.proposals({ status: 'pending' })
  assert.equal(pendingBefore.length, 1)

  const adopted = await svc.api.adopt({ packId: 'global-pack', proposalId: r.proposalId })
  assert.equal(adopted.ok, true)
  assert.equal(svc.api.proposals({ status: 'pending' }).length, 0)
  assert.equal(svc.api.stats().pendingProposals, 0)
  assert.equal(svc.api.stats().activeEntries, 1)

  // 再审一条并驳回
  const r2 = await svc.service.commit({ entry: { title: '驳回我', body: 'y' } })
  const rejected = svc.api.reject({ packId: 'global-pack', proposalId: r2.proposalId, reason: '测试驳回' })
  assert.equal(rejected.ok, true)
  assert.equal(svc.api.proposals({ status: 'pending' }).length, 0)
  assert.equal(svc.api.proposals({ status: 'rejected' }).length, 1)

  // 审计可查（含用户操作者）
  const audit = svc.api.audit({ limit: 50 })
  const adoptRow = audit.find((row) => row.action === 'adopt' && row.outcome === 'ok')
  assert.ok(adoptRow, '应存在采纳成功的 audit 行')
  const rejectRow = audit.find((row) => row.action === 'reject')
  assert.ok(rejectRow, '应存在驳回审计行')
})

test('webapi: 非法参数与错误码映射', async () => {
  const { api } = makeApi(tmpHub(), 'ask')
  await assert.rejects(api.adopt({}), (err) => err instanceof NotFoundError)
  await assert.rejects(api.adopt({ packId: 'nope', proposalId: 'p-1' }), (err) => err.code === 'NOT_FOUND')
  assert.equal(api.entries({ limit: 100000 }).length, 0)
  assert.ok(Array.isArray(api.logs({}).files))
})

test('webapi: update/forget 直接编辑删除（GUI 按钮 → 用户操作者审计、revision+1）', async () => {
  const { api, service, store } = makeApi(tmpHub(), 'auto')
  // 直写一条
  const r = await service.commit({ entry: { title: '编辑我', body: 'v1', keywords: ['旧'] } })
  const id = r.entry.id
  assert.equal(r.entry.revision, 1)

  // update：改标题/正文/关键词，revision+1
  const up = api.update({ id, title: '编辑完成', body: 'v2', keywords: ['新词'] })
  assert.equal(up.ok, true)
  assert.equal(up.revision, 2, '直接编辑应 revision+1')
  const after = api.entries({ q: '编辑完成' })
  assert.equal(after.length, 1)
  assert.equal(after[0].body, 'v2', '正文应已更新')
  assert.deepEqual(after[0].keywords, ['新词'])

  // 审计含 update 行（via=user）
  const audit = api.audit({ limit: 50 })
  const updateRow = audit.find((row) => row.action === 'update' && row.entryId === id)
  assert.ok(updateRow, '应落 update 审计行（用户直接编辑）')
  assert.equal(updateRow.via, 'user', '直接编辑操作者应为 user')

  // forget：删除 → 活跃移除 + 进归档
  const del = api.forget({ id })
  assert.equal(del.ok, true)
  assert.equal(del.removed.id, id)
  assert.equal(store.findById(id), null, '删除后活跃条目应不存在')
  const archived = store.listArchived('global-pack')
  assert.equal(archived.length, 1, '被删条目应进归档')
})

test('webapi: update/forget 对不存在 id 抛 NotFoundError', async () => {
  const { api } = makeApi(tmpHub(), 'auto')
  assert.throws(() => api.update({ id: 'mem-0000000000000000', title: 'x' }), (err) => err instanceof NotFoundError)
  assert.throws(() => api.forget({ id: 'mem-0000000000000000' }), (err) => err instanceof NotFoundError)
})

test('memory.update 语义：ask 门经 submit 进 update 类提案（与 GUI updateDirect 双轨并存）', async () => {
  const { service, store } = makeApi(tmpHub(), 'ask')
  // 经协议层直接写一条基线（模拟已有记忆；绕过门，属协议原语而非 AI 写入路径）
  const base = service.applyCreateOrUpdate('global-pack', { title: '旧标题', body: '旧正文' })
  const id = base.id

  // memory.update 工具走的路径：submit({action:'update'}) → ask 门 → 提案（kind=update）
  const res = await service.submit({
    action: 'update',
    packId: 'global-pack',
    entry: { id, title: '新标题', body: '新正文' },
    reason: 'memory.update',
  })
  assert.equal(res.approved, false, 'ask 门下 update 应进提案而非直写')
  assert.ok(res.proposalId, '应产出提案 id')
  const pending = store.allProposals('pending')
  const prop = pending.find((p) => p.id === res.proposalId)
  assert.ok(prop, '提案应入待确认队列')
  assert.equal(prop.kind, 'update', '提案 kind 应为 update')
  // 未被采纳前活跃条目标题不变
  const cur = service.store.findById(id)
  assert.equal(cur.entry.title, '旧标题', '提案未采纳前不得改动活跃条目')
})
