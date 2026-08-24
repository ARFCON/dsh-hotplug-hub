/**
 * dsh-memory-hub / test/review-continuity.test.mjs — 审查计数跨重启连续（H6 根治验收）。
 *
 * 此前缺陷：changeCount 进程内归零、markedTurns 持久化——重启后 changesSince 为负、
 * due 被旧 markedTurns 长期压制（需再变更 N+markedTurns 次才恢复）。
 * 根治：totalChanges 持久化（每次 _postChange 落盘）+ 构造时种子续读 + markedTurns 钳制。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.mjs'
import { MemoryHubService } from '../lib/service.mjs'

function makeService(hub, policy = 'auto', reviewEveryTurns = 8) {
  const store = hub === undefined ? undefined : new MemoryStore(hub)
  return new MemoryHubService({
    store,
    config: { writePolicy: policy, reviewEveryTurns },
    gate: async () => ({ outcome: policy === 'auto' ? 'allowed' : 'queued', source: policy === 'auto' ? 'gate' : 'proposals' }),
  })
}
function tmpHub() {
  return mkdtempSync(join(tmpdir(), 'dsh-mh-review-'))
}

test('重启（新实例）后计数连续：此前 10 次变更 + 重启后 5 次 = changesSince 5', async () => {
  const hub = tmpHub()
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const s1 = makeService(hub, 'auto')
  for (let i = 0; i < 10; i++) await s1.commit({ entry: { title: `变更${i}` } })
  s1.reviewDone() // markedTurns=10 持久化（旧缺陷现场）
  // 模拟重启：全新 service 实例
  const s2 = makeService(hub, 'auto')
  const st0 = s2.reviewStatus()
  assert.equal(st0.changesSinceReview, 0, '刚重启未新增变更时 changesSince=0')
  for (let i = 0; i < 5; i++) await s2.commit({ entry: { title: `重启后${i}` } })
  assert.equal(s2.reviewStatus().changesSinceReview, 5, '重启后 5 次变更 = changesSince 5（旧缺陷为 0）')
  rmSync(hub, { recursive: true, force: true })
})

test('重启后累计到阈值 → due（旧缺陷：due 被压制到永不）', async () => {
  const hub = tmpHub()
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const s1 = makeService(hub, 'auto', 8)
  for (let i = 0; i < 8; i++) await s1.commit({ entry: { title: `v${i}` } })
  s1.reviewDone()
  const s2 = makeService(hub, 'auto', 8)
  assert.equal(s2.reviewStatus().due, false)
  for (let i = 0; i < 8; i++) await s2.commit({ entry: { title: `w${i}` } })
  assert.equal(s2.reviewStatus().due, true, '重启后累计 8 次（≥阈值）应 due')
  rmSync(hub, { recursive: true, force: true })
})

test('reviewDone 后计数归零并可再次到期', async () => {
  const hub = tmpHub()
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const s = makeService(hub, 'auto', 3)
  for (let i = 0; i < 3; i++) await s.commit({ entry: { title: `a${i}` } })
  assert.equal(s.reviewStatus().due, true)
  s.reviewDone()
  assert.equal(s.reviewStatus().due, false)
  assert.equal(s.reviewStatus().changesSinceReview, 0)
  for (let i = 0; i < 3; i++) await s.commit({ entry: { title: `b${i}` } })
  assert.equal(s.reviewStatus().due, true, '再次到期')
  rmSync(hub, { recursive: true, force: true })
})

test('legacy review-state（无 totalChanges、markedTurns 虚高）不再压制 due', async () => {
  const hub = tmpHub()
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  // 人造旧版状态文件：markedTurns=500、无 totalChanges
  store.writeReviewState({ lastReviewedAt: new Date().toISOString(), markedTurns: 500 })
  const s = makeService(hub, 'auto', 8)
  assert.equal(s.reviewStatus().changesSinceReview, 0, '钳制语义：虚高 markedTurns 视作已审至当下（不为负）')
  for (let i = 0; i < 8; i++) await s.commit({ entry: { title: `l${i}` } })
  // 钳制后 markedTurns=当前计数：重启后的 8 次新变更在计数器上连续累计，达到阈值即 due
  assert.equal(s.reviewStatus().changesSinceReview, 8, '新变更计数不被旧 markedTurns 吞掉')
  assert.equal(s.reviewStatus().due, true, '旧状态文件不得长期压制 due（markedTurns 已钳制）')
  rmSync(hub, { recursive: true, force: true })
})

test('reject 等用户操作同样计入变更数', async () => {
  const hub = tmpHub()
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const ask = makeService(hub, 'ask', 2)
  const r = await ask.commit({ entry: { title: '采纳计数' } })
  const auto = makeService(hub, 'auto', 2)
  await auto.commit({ entry: { title: '基线' } })
  const before = auto.reviewStatus().changesSinceReview
  await makeService(hub, 'ask', 2).reject('global-pack', r.proposalId, 'x')
  const after = makeService(hub, 'auto', 2).reviewStatus().changesSinceReview
  assert.ok(after > before, `reject 应计入变更（${before} → ${after}）`)
  rmSync(hub, { recursive: true, force: true })
})

test('review-state.json 损坏 → 从零继续（不炸）', async () => {
  const hub = tmpHub()
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(hub, 'review-state.json'), '{ 坏 json')
  const s = makeService(hub, 'auto', 8)
  assert.equal(s.reviewStatus().changesSinceReview, 0, '损坏状态按全新起点')
  await s.commit({ entry: { title: 'x' } })
  assert.equal(s.reviewStatus().changesSinceReview, 1)
  rmSync(hub, { recursive: true, force: true })
})
