/**
 * dsh-memory-hub / test/suggest-queue.test.mjs — FR-3：suggest 永远进队列（H1 根治验收）。
 *
 * 此前缺陷：service.suggest 与 commit 逐字相同，writePolicy=auto 时 gate 放行 →
 * suggest 直写落盘，违反「永远进队列，绝不直写」。
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

test('suggest（writePolicy=auto）：强制进队列，绝不直写', async () => {
  const { hub, store, service } = makeService('auto')
  const res = await service.suggest({ entry: { title: '建议条目', body: 'x' }, reason: '主动提案' })
  assert.equal(res.approved, false, 'auto 下 suggest 也必须进队列')
  assert.ok(res.proposalId)
  assert.equal(store.allEntries().length, 0, '不落活跃条目')
  const pending = store.allProposals('pending')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].reason, '主动提案')
  rmSync(hub, { recursive: true, force: true })
})

test('suggest（writePolicy=ask）：进队列（与此前一致）', async () => {
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

test('suggest 的提案可被正常采纳（队列语义完整闭环）', async () => {
  const { hub, store, service } = makeService('auto')
  const res = await service.suggest({ entry: { title: '闭环', body: 'v' } })
  await service.adopt('global-pack', res.proposalId)
  assert.equal(store.allEntries().length, 1, '采纳后落活跃条目')
  assert.equal(store.allProposals('pending').length, 0)
  rmSync(hub, { recursive: true, force: true })
})

test('suggest 审计行 source=suggest（与 commit 的 gate/proposals 可区分）', async () => {
  const { hub, store, service } = makeService('auto')
  await service.suggest({ entry: { title: '审计源' } })
  const row = store.auditList({ limit: 10 }).find((r) => r.outcome === 'queued')
  assert.ok(row)
  assert.equal(row.via, 'suggest', '强制队列的审计 via 应标注 suggest')
  rmSync(hub, { recursive: true, force: true })
})
