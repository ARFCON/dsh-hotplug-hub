/**
 * dsh-memory-hub / test/bm25-consistency.test.mjs — 检索一致性与序列化边界（M9/S2/边缘）。
 *
 * 覆盖：df/tf 同源（子串命中不再拿最大 idf）、CJK 子段命中、frontmatter 引号+逗号
 * 关键词往返、双引号关键词、snippet 码点安全、空语料/空查询、includeExpired。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.mjs'
import { MemoryHubService } from '../lib/service.mjs'
import { recall, tokenize, idf } from '../lib/bm25.mjs'
import { DEFAULTS } from '../lib/constants.mjs'

function makeService(policy = 'auto') {
  const hub = mkdtempSync(join(tmpdir(), 'dsh-mh-bm25-'))
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const service = new MemoryHubService({
    store,
    config: { writePolicy: policy },
    gate: async () => ({ outcome: policy === 'auto' ? 'allowed' : 'queued', source: policy === 'auto' ? 'gate' : 'proposals' }),
  })
  return { hub, store, service }
}

test('df/tf 同源：子串常现词如实低 idf——纯子串命中文档被相对分淘汰，稀有词文档居首（行为断言）', () => {
  const item = (title) => ({ packId: 'global-pack', entry: { id: title, name: title, title, description: '', keywords: [], body: '', type: 'project', scope: 'global', activation: 'relevant', volatility: '', updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), revision: 1, subjectKey: '', expiresAt: null, lastVerifiedAt: null, tagged: [] } })
  // 语料：10 条标题为「规则N构建」（查询词「构建」仅以子串命中全部 10 篇 → df=10 常现词）
  // + 1 条「独孤词构建」（额外命中稀有词「独孤词」，df=1）
  const items = []
  for (let i = 0; i < 10; i++) items.push(item(`规则${i}构建`))
  items.push(item('独孤词构建'))
  // 双词查询「构建 独孤词」的行为差异：
  // 新实现（df 与 tf 同口径）：「构建」idf=log(1+0.5/10.5)≈0.05（如实走低）→
  //   纯子串文档得分≈0.05，被 keepRelativeScore(0.24×top) 淘汰 → 只剩稀有词文档；
  // 旧实现（df 只统计精确 token，「构建」df=0 → idf 最大≈3.16）：纯子串文档反而
  //   拿最高分居首，稀有词文档被淘汰——排序被噪声劫持。
  const results = recall(items, '构建 独孤词', { limit: 5 })
  assert.ok(results.length >= 1, '至少返回稀有词文档')
  assert.equal(results[0].item.entry.name, '独孤词构建',
    `稀有词命中者必须第一（实际第一：${results[0].item.entry.name}，matched=${results[0].matched}）`)
  assert.ok(results[0].matched.includes('独孤词'))
  // 纯子串文档被相对分过滤（旧实现下它们会霸榜）
  assert.equal(results.length, 1, `纯子串低信号文档应被淘汰（实际返回 ${results.length} 条：${results.map((r) => r.item.entry.name).join(',')}）`)
})

test('CJK 子段命中：查询「构建」能召回标题为「构建插件规则」的条目', async () => {
  const { hub, store, service } = makeService()
  await service.commit({ entry: { title: '构建插件规则', description: '描述' } })
  const res = service.search('构建', {})
  assert.equal(res.count, 1)
  assert.deepEqual(res.hits[0].matched, ['构建'])
  rmSync(hub, { recursive: true, force: true })
})

test('keywords 含双引号 + 逗号组合：写读往返无损', async () => {
  const { hub, store, service } = makeService()
  await service.commit({ entry: { title: '引号逗号', keywords: ['say "hi", ok', 'x', '中文,词'] } })
  const e = store.allEntries()[0].entry
  assert.deepEqual(e.keywords, ['say "hi", ok', 'x', '中文,词'], '含引号+逗号的关键词必须无损往返')
  rmSync(hub, { recursive: true, force: true })
})

test('frontmatter：手改的裸值数组（未加引号）仍可解析', async () => {
  const { store } = makeService()
  const { parseFrontmatter } = await import('../lib/frontmatter.mjs')
  const fm = parseFrontmatter('keywords: [构建, 插件]\ntitle: 手改标题')
  assert.deepEqual(fm.keywords, ['构建', '插件'], '裸值数组降级解析')
  assert.equal(fm.title, '手改标题')
})

test('tokenize：CJK 整段成词 + 拉丁小写化 + 停止词抑制', () => {
  const tokens = tokenize('Continue 构建插件 OK go')
  assert.ok(tokens.includes('构建插件'))
  assert.ok(tokens.includes('构建') === false, '整段成词（不逐字拆分）')
  assert.ok(tokens.includes('ok') === false, '停止词 ok 被抑制')
  assert.ok(tokens.includes('continue') === false)
})

test('recall：空查询/空语料/全过期 → 空结果', async () => {
  assert.deepEqual(recall([], 'x', {}), [])
  assert.deepEqual(recall([{ packId: 'p', entry: { title: 'x', keywords: [], description: '', body: '' } }], '', {}), [])
  const { hub, store, service } = makeService()
  await service.commit({ entry: { title: '过期词', expiresAt: '2000-01-01', keywords: ['过期词'] } })
  assert.equal(service.search('过期词', {}).count, 0)
  assert.equal(service.search('过期词', { includeExpired: true }).count, 1, 'includeExpired 可召回')
  rmSync(hub, { recursive: true, force: true })
})

test('freshness：volatility 缺省按 type 取窗口（Spec §7.4）', async () => {
  const { hub, store, service } = makeService()
  await service.commit({ entry: { title: '类型窗口', type: 'project' } })
  const e = store.allEntries()[0].entry
  assert.equal(e.volatility, '', '缺省 volatility 序列化为空串（非 stable）')
  const { freshnessOf } = await import('../lib/bm25.mjs')
  // project 窗口 [14,45]：构造 50 天前的条目 → 三档模型 expired
  const oldish = { ...e, updatedAt: new Date(Date.now() - 50 * 86400000).toISOString() }
  assert.equal(freshnessOf(oldish), 'expired', 'project 超 45 天按三档模型 expired')
  const fresh = { ...e, updatedAt: new Date().toISOString() }
  assert.equal(freshnessOf(fresh), 'fresh')
  rmSync(hub, { recursive: true, force: true })
})

test('检索预算内 snippet：description 优先于 body', async () => {
  const { hub, store, service } = makeService()
  await service.commit({ entry: { title: '描述优先', description: '这是描述', body: '这是正文' } })
  const res = service.search('描述优先', {})
  assert.equal(res.hits[0].snippet, '这是描述')
  rmSync(hub, { recursive: true, force: true })
})

test('limit 硬上限 searchLimitMax=8（配置更大也被钳制）', async () => {
  const { hub, store, service } = makeService()
  for (let i = 0; i < 12; i++) await service.commit({ entry: { title: `同词${i}`, keywords: ['同词'] } })
  const res = service.search('同词', { limit: 100 })
  assert.ok(res.hits.length <= DEFAULTS.searchLimitMax, `hits ${res.hits.length} ≤ ${DEFAULTS.searchLimitMax}`)
  rmSync(hub, { recursive: true, force: true })
})
