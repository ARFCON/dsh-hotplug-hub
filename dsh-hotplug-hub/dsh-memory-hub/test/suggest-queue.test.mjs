/**
 * dsh-memory-hub / test/suggest-queue.test.mjs — suggest 的 writePolicy 语义。
 *
 * auto（默认）：AI 自动直写通过（不再强制进队列）。
 * ask：进提案队列，由 AI/用户采纳。
 * off：整体拒绝并落 denied 审计。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.mjs'
import { MemoryHubService } from '../lib/service.mjs'

function makeService(policy) {
  const hub = mkdtempSync(join(tmpdir(), 'dsh-mh-sug-'))
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const service = new MemoryHubService({
    store,
    config: { writePolicy: policy },
    gate: async () => ({ outcome: policy === 'auto' ? 'allowed' : policy === 'off' ? 'rejected' : 'queued', source: 'gate' }),
  })
  return { hub, store, service }
}

test('suggest（writePolicy=auto）：AI 自动直写通过', async () => {
  const { hub, store, service } = makeService('auto')
  const res = await service.suggest({ entry: { title: '建议条目', body: 'x' }, reason: '主动提案' })
  assert.equal(res.approved, true, 'auto 下 suggest 直写')
  assert.ok(res.entry)
  assert.equal(store.allEntries().length, 1, '落活跃条目')
  assert.equal(store.allProposals('pending').length, 0)
  rmSync(hub, { recursive: true, force: true })
})

test('suggest（writePolicy=ask）：进队列（等待采纳）', async () => {
  const { hub, store, service } = makeService('ask')
  const res = await service.suggest({ entry: { title: 'ask 建议' } })
  assert.equal(res.approved, false)
  assert.equal(store.allProposals('pending').length, 1)
  assert.equal(store.allEntries().length, 0)
  rmSync(hub, { recursive: true, force: true })
})

test('suggest（writePolicy=off）：整体拒绝并落 denied 审计', async () => {
  const { hub, store, service } = makeService('off')
  await assert.rejects(service.suggest({ entry: { title: 'off 建议' } }), (err) => err.code === 'WRITE_DENIED')
  assert.equal(store.allProposals('pending').length, 0)
  assert.equal(store.allEntries().length, 0)
  const denied = store.auditList({ limit: 10 }).find((r) => r.outcome === 'denied')
  assert.ok(denied, 'off 拒绝应落 denied 审计')
  rmSync(hub, { recursive: true, force: true })
})

test('ask 模式下 suggest 的提案可被正常采纳（队列语义完整闭环）', async () => {
  const { hub, store, service } = makeService('ask')
  const res = await service.suggest({ entry: { title: '闭环', body: 'v' } })
  await service.adopt('global-pack', res.proposalId)
  assert.equal(store.allEntries().length, 1, '采纳后落活跃条目')
  assert.equal(store.allProposals('pending').length, 0)
  rmSync(hub, { recursive: true, force: true })
})

test('suggest 审计：auto 直写标 allowed，ask 队列标 queued/suggest', async () => {
  const a = makeService('auto')
  await a.service.suggest({ entry: { title: '审计源-auto' } })
  const allowedRow = a.store.auditList({ limit: 10 }).find((r) => r.outcome === 'allowed')
  assert.ok(allowedRow)
  assert.equal(allowedRow.via, 'gate', 'auto 直写的审计 via 应标注 gate')
  rmSync(a.hub, { recursive: true, force: true })

  const b = makeService('ask')
  await b.service.suggest({ entry: { title: '审计源-ask' } })
  const queuedRow = b.store.auditList({ limit: 10 }).find((r) => r.outcome === 'queued')
  assert.ok(queuedRow)
  assert.equal(queuedRow.via, 'suggest', 'ask 队列的审计 via 应标注 suggest')
  rmSync(b.hub, { recursive: true, force: true })
})
