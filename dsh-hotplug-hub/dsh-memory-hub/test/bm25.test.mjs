// test/bm25.test.mjs — BM25 召回内核单测（CJK / 排序 / 新鲜度 / 过期 / 强命中 / 预算）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, queryTerms, recall, freshnessOf } from '../lib/bm25.mjs'

function entry(name, overrides = {}) {
  return {
    id: `mem-${name.padStart(16, 'a')}`,
    revision: 1,
    createdAt: '2026-08-19T00:00:00Z',
    updatedAt: new Date().toISOString(),
    name,
    title: overrides.title ?? name,
    description: overrides.description ?? '',
    type: overrides.type ?? 'project',
    scope: 'global',
    activation: 'relevant',
    volatility: overrides.volatility ?? 'stable',
    subjectKey: '',
    expiresAt: overrides.expiresAt ?? null,
    lastVerifiedAt: null,
    keywords: overrides.keywords ?? [],
    tagged: [],
    body: overrides.body ?? '',
  }
}

function itemsNamed(items) {
  return items.map((row) => row.item.entry.name)
}

test('CJK + 拉丁混合分词', () => {
  const tokens = tokenize('用户偏好 user preference 构建插件')
  assert.ok(tokens.includes('用户偏好'))
  assert.ok(tokens.includes('user'))
  assert.ok(tokens.includes('preference'))
  assert.ok(tokens.includes('构建插件'))
})

test('热身语被抑制（不浪费上下文）', () => {
  assert.equal(queryTerms('好的 继续 下一步').length, 0)
  assert.equal(queryTerms('continue please go on').length, 0)
})

test('BM25：命中词排序 + 强命中捷径', () => {
  const items = [
    { packId: 'global-pack', entry: entry('fact-a', { title: '封装构建脚本', description: 'dev_build_plugin 构建插件', keywords: ['构建'] }) },
    { packId: 'global-pack', entry: entry('fact-b', { title: '买菜清单', body: '鸡蛋 牛奶' }) },
    { packId: 'global-pack', entry: entry('fact-c', { title: '构建产物', body: '构建 tgz 进桌面', keywords: ['build'] }) },
  ]
  const hits = recall(items, '构建')
  assert.ok(hits.length >= 2, '应命中两条有关构建的')
  assert.ok(itemsNamed(hits).includes('fact-a'))
  assert.ok(itemsNamed(hits).includes('fact-c'))
  // fact-b 不应因无关而排前
  const first = hits[0].item.entry.name
  assert.ok(first !== 'fact-b')
})

test('过期条目硬排除 / includeExpired 可召回', () => {
  const items = [
    { packId: 'global-pack', entry: entry('live', { title: '当前规则' }) },
    { packId: 'global-pack', entry: entry('dead', { title: '过期事实', expiresAt: '2020-01-01T00:00:00Z' }) },
  ]
  const without = recall(items, '规则 过期 事实')
  assert.ok(!itemsNamed(without).includes('dead'), '过期默认排除')
  const withExpired = recall(items, '规则 过期 事实', { includeExpired: true })
  assert.ok(itemsNamed(withExpired).includes('dead'), '显式 includeExpired 可召回')
})

test('freshness 窗口：stable 90/365', () => {
  const old = entry('old', { volatility: 'stable' })
  old.updatedAt = new Date(Date.now() - 200 * 86_400_000).toISOString()
  assert.equal(freshnessOf(old), 'stale')
  const fresh = entry('fresh')
  assert.equal(freshnessOf(fresh), 'fresh')
})

test('limit 与字符预算约束', () => {
  const items = []
  for (let index = 0; index < 20; index++) {
    items.push({ packId: 'global-pack', entry: entry(`fact-${index}`, { title: `构建规则${index}` }) })
  }
  const hits = recall(items, '构建', { limit: 3 })
  assert.ok(hits.length <= 3)
  const totalChars = hits.reduce((sum, h) => sum + h.snippet.length, 0)
  assert.ok(totalChars <= 2400 + 300, 'snippet 受控')
})

test('无查询词返回空', () => {
  assert.equal(recall([{ packId: 'global-pack', entry: entry('a', { title: 'x' }) }], '').length, 0)
  assert.equal(recall([], '构建').length, 0)
})
