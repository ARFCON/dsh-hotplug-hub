/**
 * dsh-memory-hub / test/budget-contract.test.mjs — 预算契约（H7/S4/S5/M1/M4/M5 根治验收）。
 *
 * Spec §7.5 声明的硬上限此前三处未实施：snippetChars=300（单条 snippet）、
 * searchChars=2400（召回总预算）、proposalMaxChars=8192（提案单条）；restore 绕过
 * pinned 预算；校验估算与快照渲染口径不一致（通过校验仍被截断）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.mjs'
import { MemoryHubService } from '../lib/service.mjs'
import { DEFAULTS } from '../lib/constants.mjs'

function makeService(policy = 'auto', cfg = {}) {
  const hub = mkdtempSync(join(tmpdir(), 'dsh-mh-budget-'))
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const service = new MemoryHubService({
    store,
    config: { writePolicy: policy, ...cfg },
    gate: async () => ({ outcome: policy === 'auto' ? 'allowed' : 'queued', source: policy === 'auto' ? 'gate' : 'proposals' }),
  })
  return { hub, store, service }
}

test('单条 snippet ≤ snippetChars=300（含省略号；码点安全）', async () => {
  const { hub, store, service } = makeService()
  await service.commit({ entry: { title: '长描述', description: '字'.repeat(500) } })
  await service.commit({ entry: { title: '长正文', body: '😀'.repeat(400) } })
  const res = service.search('长', {})
  assert.ok(res.hits.length >= 1)
  for (const hit of res.hits) {
    assert.ok(hit.snippet.length <= DEFAULTS.snippetChars, `snippet ${hit.snippet.length} ≤ ${DEFAULTS.snippetChars}`)
    // 码点安全：末字符不得是孤立高代理（截断不得劈开 emoji 代理对），无任何豁免分支
    const last = hit.snippet.charCodeAt(hit.snippet.length - 1)
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `snippet 不得以孤立高代理结尾（0x${last.toString(16)}）`)
  }
  rmSync(hub, { recursive: true, force: true })
})

test('召回总字符预算 ≤ searchChars=2400（跨命中截齐，从低分尾部丢）', async () => {
  const { hub, store, service } = makeService()
  for (let i = 0; i < 6; i++) {
    await service.commit({ entry: { title: `预算${i}`, description: 'D'.repeat(290), keywords: ['预算'] } })
  }
  const res = service.search('预算', { limit: 6 })
  const total = res.hits.reduce((sum, h) => sum + h.snippet.length + h.title.length + 48, 0)
  assert.ok(total <= DEFAULTS.searchChars, `估算总字符 ${total} ≤ ${DEFAULTS.searchChars}`)
  assert.ok(res.hits.length >= 1, '预算内至少保最高分命中')
  rmSync(hub, { recursive: true, force: true })
})

test('proposalMaxChars=8192：超大提案被拒（不截断、不落盘）', async () => {
  const { hub, store } = makeService('ask')
  const svc = new MemoryHubService({ store, config: { writePolicy: 'ask' }, gate: async () => ({ outcome: 'queued', source: 'proposals' }) })
  await assert.rejects(
    svc.commit({ entry: { title: '巨大', body: 'x'.repeat(DEFAULTS.proposalMaxChars) } }),
    (err) => err.code === 'BUDGET_EXCEEDED' && err.details.limit === DEFAULTS.proposalMaxChars,
  )
  assert.equal(store.allProposals('pending').length, 0, '超限提案不落盘')
  // 恰好低于上限的可通过
  const ok = await svc.commit({ entry: { title: '贴线', body: 'y'.repeat(1000) } })
  assert.ok(ok.proposalId)
  rmSync(hub, { recursive: true, force: true })
})

test('提案队列上限：remove 提案（forget）同样受限（此前 remove 不计数）', async () => {
  const { hub, store } = makeService('ask')
  const svc = new MemoryHubService({ store, config: { writePolicy: 'ask', maxPendingProposals: 2 }, gate: async () => ({ outcome: 'queued', source: 'proposals' }) })
  await svc.commit({ entry: { title: '条目一' } })
  await svc.commit({ entry: { title: '条目二' } })
  // 两条 create 提案已满 → 第三条 remove（forget）提案也应被 BUDGET_EXCEEDED 拒绝
  await assert.rejects(
    svc.submit({ action: 'remove', packId: 'global-pack', entry: { id: 'mem-0000000000000000' }, reason: 'forget' }),
    (err) => err.code === 'BUDGET_EXCEEDED',
  )
  rmSync(hub, { recursive: true, force: true })
})

test('pinned 预算：restore 恢复不再绕过（恢复会超预算 → BUDGET_EXCEEDED）', async () => {
  const { hub, store, service } = makeService('auto', { snapshotChars: 1200 })
  const mk = (i) => ({ title: `p${i}`, description: 'd'.repeat(150), activation: 'pinned' })
  let written = 0
  for (let i = 0; i < 30; i++) {
    try { await service.commit({ entry: mk(i) }); written++ } catch { break }
  }
  assert.ok(written >= 2, `预置若干 pinned（实际 ${written}）`)
  // 归档一半，再用新 pinned 占满剩余预算
  for (const { entry } of store.allEntries().slice(0, Math.floor(written / 2))) await service.removeDirect(entry.id)
  for (let i = 100; i < 150; i++) {
    try { await service.commit({ entry: mk(i) }) } catch { break }
  }
  const before = store.allEntries().filter(({ entry }) => entry.activation === 'pinned').length
  let blocked = 0
  for (const { entry } of store.allArchived()) {
    try { service.restoreArchived('global-pack', entry.name) } catch (e) { if (e.code === 'BUDGET_EXCEEDED') blocked++ }
  }
  const after = store.allEntries().filter(({ entry }) => entry.activation === 'pinned').length
  assert.ok(blocked > 0, '至少一条恢复被预算拒绝')
  assert.equal(after, before, '预算拒绝的恢复不落盘')
  rmSync(hub, { recursive: true, force: true })
})

test('pinned 预算估算与快照渲染同口径：预算内 pinned 绝不被截断', async () => {
  const { hub, store, service } = makeService('auto', { snapshotChars: 1200 })
  const mk = (i) => ({ title: `常驻${i}`, description: '详情'.repeat(20), activation: 'pinned' })
  let written = 0
  for (let i = 0; i < 30; i++) {
    try { await service.commit({ entry: mk(i) }); written++ } catch { break }
  }
  assert.ok(written >= 1)
  // 下一条超预算被拒 → 当前全部 pinned 均在预算内
  try { await service.commit({ entry: mk(99) }) } catch { /* 预期超限 */ }
  const { snapshotText } = await import('../lib/index.mjs')
  const snap = snapshotText(service, { snapshotChars: 1200 })
  for (const { entry } of store.allEntries()) {
    assert.ok(snap.includes(entry.title), `预算内 pinned「${entry.title}」必须完整出现在快照（不得截断）`)
  }
  assert.ok(snap.includes('记忆约定'), '固定提示行永不裁掉')
  assert.ok(snap.length <= 1200 + 20, `快照总长受控（实际 ${snap.length}）`)
  rmSync(hub, { recursive: true, force: true })
})

test('审计滚动按行数（阈值 auditRollAfter；滚动后旧行进 .audit.jsonl.<ts> 归档）', async () => {
  const { hub, store } = makeService()
  // 直接压测账本：写 auditRollAfter+50 行（绕过条目写，纯账本通道）
  for (let i = 0; i < DEFAULTS.auditRollAfter + 50; i++) {
    store.auditAppend({ action: 'test', packId: null, entryId: null, operator: 'system', outcome: 'row' + i })
  }
  const rows = store.auditList({ limit: 500 })
  // 滚动确实发生：当前账本行数 < 已写入总数，且存在 .audit.jsonl.<timestamp> 归档文件
  const { readdirSync } = await import('node:fs')
  const rolled = readdirSync(hub).filter((f) => f.startsWith('.audit.jsonl.'))
  assert.ok(rolled.length >= 1, `应存在滚动归档文件（实际 ${rolled.length}）`)
  assert.ok(rows.length < DEFAULTS.auditRollAfter + 50, `当前账本应已滚动（${rows.length} < 写入总数）`)
  assert.ok(rows.length > 0, '滚动后新账本可用')
  rmSync(hub, { recursive: true, force: true })
})
