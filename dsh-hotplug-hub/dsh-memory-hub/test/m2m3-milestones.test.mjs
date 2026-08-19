/**
 * dsh-memory-hub / test/m2m3-milestones.test.mjs — M2 缓存友好 + M3 自动记忆验收。
 *
 * M2：前缀静态性（无写入时快照逐字节不变）+ pinned 预算 + 变更检测尾部注入（消费一次即消失）。
 * M3：L3 日志轨（daily/project 不注入）+ 回合内自我审查（review_status/review_done 定级）。
 *
 * 用最小 fake ctx 驱动 index.mjs 的 apply()（section/effect/tools 注册面），
 * 证明 DSH 宿主装配路径上的快照与尾部语义正确。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (m) => import(pathToFileURL(join(here, '..', 'lib', `${m}.mjs`)).href)
const { MemoryStore } = await lib('store')
const { MemoryHubService } = await lib('service')

/** 最小可装配的 fake ctx（覆盖 index.mjs apply() 消费的公开面）。 */
async function makeFakeCtx(hubDir, writePolicy, cfg = {}) {
  const sections = new Map()
  const effects = []
  const ctx = {
    get: () => undefined,
    on: () => () => {},
    provide: () => {},
    effect: (thunk) => { const dispose = thunk(); return typeof dispose === 'function' ? dispose : () => {} },
    systemPrompt: {
      section: (def) => { sections.set(def.name, def); return () => {} },
    },
    tools: { register: () => {} },
  }
  const index = await import(pathToFileURL(join(here, '..', 'lib', 'index.mjs')).href)
  const service = index.apply(ctx, { hubDir, writePolicy, reviewEveryTurns: 1, ...cfg })
  return { ctx, sections, effects, service, index }
}

function tmpHub() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-hub-m2m3-'))
  return dir
}

// ---------- M2：前缀静态性与注入 ----------

test('M2: 无写入时冻结快照逐字节不变（含固定提示行）', async () => {
  const { index, service } = await makeFakeCtx(tmpHub(), 'auto')
  const cfg = { snapshotChars: 1200 }
  const a = index.snapshotText(service, cfg)
  for (let i = 0; i < 5; i++) {
    assert.equal(index.snapshotText(service, cfg), a, `第 ${i} 次快照应逐字节一致`)
  }
  assert.ok(a.includes('冻结记忆快照'), '快照应含冻结警告头')
  assert.ok(a.includes('记忆约定'), '快照应含固定提示行（收尾自动沉淀引导）')
})

test('M2: pinned 写入进入稳定前缀，且 over-budget 时抛 BUDGET_EXCEEDED（禁止超预算常驻）', async () => {
  const { service } = await makeFakeCtx(tmpHub(), 'auto')
  // 每条 pinned：title 40 字符（name 前 64 内可区分）+ description 500；est≈40+500+40=580
  const mk = (i) => ({ title: `T${i}${'P'.repeat(38)}`, description: 'D'.repeat(500), activation: 'pinned' })
  // 4 条 ≈ 2320 < 2560 → 允许
  for (let i = 0; i < 4; i++) {
    const r = await service.commit({ entry: mk(i) })
    assert.equal(r.approved, true, `第 ${i + 1} 条预算内 pinned 应直写`)
    assert.equal(r.entry.activation, 'pinned')
  }
  // 第 5 条 ≈ 2900 > 2560 → 拒绝
  const budget = service.config.snapshotChars ?? 2560
  await assert.rejects(service.commit({ entry: mk(4) }), (err) => {
    assert.equal(err.code, 'BUDGET_EXCEEDED')
    assert.ok(err.details.chars > budget, `估算 ${err.details.chars} 应超预算 ${budget}`)
    return true
  })
  assert.equal(service.store.allEntries().filter(({ entry }) => entry.activation === 'pinned').length, 4, '超预算条目不应落盘')
})

test('M2: 尾部注入——发生变更后注入一次、消费后消失（空闲轮前缀稳定）', async () => {
  const { sections, service } = await makeFakeCtx(tmpHub(), 'auto')
  const session = {}
  const assemble = { agent: { session } }
  const tail = sections.get('dsh-memory-hub:memory-tail').text
  const snapshot = sections.get('dsh-memory-hub:memory').text

  assert.equal(tail(assemble), '', '无变更时尾部必须为空字符串（不破坏前缀缓存）')
  const snapA = snapshot(assemble)

  // 一次 commit → 变更进通知队列
  const r = await service.commit({ entry: { title: '尾部验证', description: '触发尾部注入' } })
  assert.equal(r.approved, true)

  const t1 = tail(assemble)
  assert.ok(t1.includes('记忆变更'), '变更后应注入尾部块')
  assert.ok(t1.includes('create'), '尾部应含动作')
  const t2 = tail(assemble)
  assert.equal(t2, '', '尾部消费一次后应消失（后续轮前缀稳定）')

  // 快照仍是冻结的（不变）
  assert.equal(snapshot(assemble), snapA, '会话内快照应保持冻结不变')
})

test('M2: 提案（ask 门）也产生尾部通知（新提案 → 下一轮可见）', async () => {
  const { sections, service } = await makeFakeCtx(tmpHub(), 'ask')
  const session = {}
  const assemble = { agent: { session } }
  const tail = sections.get('dsh-memory-hub:memory-tail').text
  const r = await service.commit({ entry: { title: '提案测试', body: 'ask 门' } })
  assert.equal(r.approved, false)
  assert.ok(r.proposalId, 'ask 门应产出提案 id')
  const t1 = tail(assemble)
  assert.ok(t1.includes(r.proposalId), '提案 id 应出现在尾部通知')
})

// ---------- M3：L3 日志轨 + 自我审查 ----------

test('M3: L3 日志轨——写入后不注入、可读取、按 scope 隔离', async () => {
  const { service, sections } = await makeFakeCtx(tmpHub(), 'auto')
  const session = {}
  const assemble = { agent: { session } }
  const snapshot = sections.get('dsh-memory-hub:memory').text
  const snapA = snapshot(assemble)

  const r = service.log({ scope: 'project-devtools', text: '完成 M2 验证' })
  assert.ok(r.path.endsWith('.md'), '日志应落盘 md')
  const r2 = service.log({ scope: 'project-devtools', text: '准备 M3' })
  assert.equal(r2.line, 2, '二次追加应累计行数')

  const files = service.listLogs({ scope: 'project-devtools' })
  assert.equal(files.length, 1)
  const content = service.readLog({ scope: 'project-devtools' })
  assert.ok(content.includes('完成 M2 验证'))
  assert.ok(content.includes('准备 M3'))

  // 日志不进条目、不注入：快照仍逐字节一致，活跃条目不变
  assert.equal(snapshot(assemble), snapA, '写日志不得改变冻结快照')
  assert.equal(service.store.allEntries().length, 0, 'L3 日志是独立轨，不产生条目')
})

test('M3: review_status 按变更数定级，review_done 重置', async () => {
  const { service } = await makeFakeCtx(tmpHub(), 'auto') // reviewEveryTurns=1
  assert.equal(service.reviewStatus().due, false, '无变更不 due')
  assert.equal(service.reviewStatus().changesSinceReview, 0)

  await service.commit({ entry: { title: '变更1' } })
  await service.commit({ entry: { title: '变更2' } })
  const st = service.reviewStatus()
  assert.equal(st.due, true, '变更 ≥ 阈值应 due')
  assert.ok(st.changesSinceReview >= 1)

  const done = service.reviewDone()
  assert.equal(done.changesSinceReview, 0, '标记后计数归零')
  assert.ok(service.reviewStatus().lastReviewedAt, '应持久化 lastReviewedAt')
  assert.equal(service.reviewStatus().due, false)
})

test('M3: review_status 报告 pending 提案与写策略（供回合内审查决策）', async () => {
  const { service } = await makeFakeCtx(tmpHub(), 'ask')
  const before = service.reviewStatus()
  assert.equal(before.writePolicy, 'ask')
  await service.commit({ entry: { title: '待审 A' } })
  assert.equal(service.reviewStatus().pendingProposals, 1, 'ask 门提案例应计入 pending')
})
