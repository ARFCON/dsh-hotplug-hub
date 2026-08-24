/**
 * dsh-memory-hub / test/list-limits.test.mjs — memory.list/audit limit 契约（M16/M17 根治验收）
 * 与路径安全（H4：Windows 保留名/尾点/symlink 越界拒绝）。
 *
 * 通过 fake ctx 装配真实工具（index.mjs buildTools），execute 直接驱动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MemoryStore } from '../lib/store.mjs'
import { MemoryHubService } from '../lib/service.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const indexUrl = () => pathToFileURL(join(here, '..', 'lib', 'index.mjs')).href

async function makeTools(cfg = {}) {
  const hub = mkdtempSync(join(tmpdir(), 'dsh-mh-list-'))
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const index = await import(indexUrl())
  const tools = new Map()
  const ctx = {
    inject: () => {},
    effect: (thunk) => thunk(),
    provide: () => {},
    get: () => undefined,
    on: () => () => {},
    systemPrompt: { section: () => () => {} },
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => {} } },
  }
  index.apply(ctx, { hubDir: hub, writePolicy: 'auto', ...cfg })
  return { hub, store, tools }
}

test('memory.list：pack 限定也受 limit 约束（旧缺陷：pack 分支不 slice）', async () => {
  const { hub, store, tools } = await makeTools()
  const svc = { store }
  // 直接造 7 条
  for (let i = 0; i < 7; i++) {
    await new MemoryHubService({ store, config: { writePolicy: 'auto' }, gate: async () => ({ outcome: 'allowed', source: 'gate' }) })
      .commit({ entry: { title: `条目${i}` } })
  }
  const listTool = tools.get('memory.list')
  const scoped = JSON.parse(await listTool.execute({ what: 'entries', pack: 'global-pack', limit: 3 }))
  assert.equal(scoped.length, 3, 'pack 限定 + limit=3 → 3 条')
  const all = JSON.parse(await listTool.execute({ what: 'entries', limit: 3 }))
  assert.equal(all.length, 3)
  const noLimit = JSON.parse(await listTool.execute({ what: 'entries', pack: 'global-pack' }))
  assert.equal(noLimit.length, 7, '不传 limit 默认 50 → 全部 7 条')
  rmSync(hub, { recursive: true, force: true })
})

test('memory.list：负数/0 limit 不再反常掉尾（钳制到 ≥1）', async () => {
  const { hub, store, tools } = await makeTools()
  const service = new MemoryHubService({ store, config: { writePolicy: 'auto' }, gate: async () => ({ outcome: 'allowed', source: 'gate' }) })
  for (let i = 0; i < 5; i++) await service.commit({ entry: { title: `负限${i}` } })
  const listTool = tools.get('memory.list')
  const neg = JSON.parse(await listTool.execute({ what: 'entries', limit: -3 }))
  assert.equal(neg.length, 1, 'limit=-3 → 钳为 1（旧缺陷 slice(0,-3) 反而全清空/掉尾）')
  const zero = JSON.parse(await listTool.execute({ what: 'entries', limit: 0 }))
  assert.equal(zero.length, 5, 'limit=0 → falsy 走默认 50（全 5 条）')
  rmSync(hub, { recursive: true, force: true })
})

test('memory.list：archived 分支同样受 limit', async () => {
  const { hub, store, tools } = await makeTools()
  const service = new MemoryHubService({ store, config: { writePolicy: 'auto' }, gate: async () => ({ outcome: 'allowed', source: 'gate' }) })
  for (let i = 0; i < 4; i++) await service.commit({ entry: { title: `归档${i}` } })
  for (const { entry } of store.allEntries()) await service.removeDirect(entry.id)
  const listTool = tools.get('memory.list')
  const arch = JSON.parse(await listTool.execute({ what: 'archived', limit: 2 }))
  assert.equal(arch.length, 2)
  rmSync(hub, { recursive: true, force: true })
})

test('memory.audit：负 limit 钳制 ≥1（不丢最新行）', async () => {
  const { hub, store, tools } = await makeTools()
  const service = new MemoryHubService({ store, config: { writePolicy: 'auto' }, gate: async () => ({ outcome: 'allowed', source: 'gate' }) })
  for (let i = 0; i < 3; i++) await service.commit({ entry: { title: `审${i}` } })
  const auditTool = tools.get('memory.audit')
  const rows = JSON.parse(await auditTool.execute({ limit: -1 }))
  assert.ok(rows.length >= 1, 'limit=-1 至少返回最新 1 行（旧缺陷 slice(1) 丢最新行）')
  const newest = rows[0]
  assert.ok(newest.action === 'create' || newest.action === 'update', '首行为最新')
  rmSync(hub, { recursive: true, force: true })
})

test('memory.search 工具：config.searchLimit 钳到 searchLimitMax', async () => {
  const { hub, store, tools } = await makeTools({ searchLimit: 999 })
  const service = new MemoryHubService({ store, config: { writePolicy: 'auto', searchLimit: 999 }, gate: async () => ({ outcome: 'allowed', source: 'gate' }) })
  for (let i = 0; i < 12; i++) await service.commit({ entry: { title: `钳${i}`, keywords: ['钳'] } })
  const searchTool = tools.get('memory.search')
  const res = JSON.parse(await searchTool.execute({ query: '钳' }))
  assert.ok(res.hits.length <= 8, '配置 searchLimit=999 仍被 searchLimitMax=8 钳制')
  rmSync(hub, { recursive: true, force: true })
})

// ---------- 路径安全（H4） ----------

test('Windows 保留名条目（con/nul/aux）被拒绝', async () => {
  const hub = mkdtempSync(join(tmpdir(), 'dsh-mh-path-'))
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  for (const bad of ['con', 'nul', 'aux', 'com1']) {
    assert.throws(() => store.entryPath('global-pack', bad), (err) => err.code === 'INVALID_INPUT', `${bad} 应被拒绝`)
  }
  rmSync(hub, { recursive: true, force: true })
})

test('尾点/尾空格条目名被拒绝（Windows 畸形文件名）', async () => {
  const hub = mkdtempSync(join(tmpdir(), 'dsh-mh-path2-'))
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  assert.throws(() => store.entryPath('global-pack', '名字.'), (err) => err.code === 'INVALID_INPUT')
  rmSync(hub, { recursive: true, force: true })
})

test('packId 三重标准统一：大写/CJK packId 拒绝（与 schema 小写一致）', async () => {
  const hub = mkdtempSync(join(tmpdir(), 'dsh-mh-path3-'))
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  assert.throws(() => store.createPack({ memoryPackId: '大写包' }), (err) => err.code === 'INVALID_INPUT')
  assert.throws(() => store.createPack({ memoryPackId: 'Upper-Pack' }), (err) => err.code === 'INVALID_INPUT')
  assert.equal(store.hasPack('Upper-Pack'), false, 'hasPack 对非法 id 返回 false（不抛）')
  // 合法小写 OK
  store.createPack({ memoryPackId: 'ok-pack.v2_x' })
  assert.equal(store.hasPack('ok-pack.v2_x'), true)
  rmSync(hub, { recursive: true, force: true })
})

test('symlink/junction 越界写被拒绝（realpath 校验）', { skip: process.platform !== 'win32' }, async () => {
  const hub = mkdtempSync(join(tmpdir(), 'dsh-mh-path4-'))
  const outside = mkdtempSync(join(tmpdir(), 'dsh-mh-outside-'))
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const entriesDir = join(hub, 'global-pack', 'entries')
  // 把 entries 目录替换为指向外部的 junction → 写应被 safeJoin realpath 校验拒绝
  rmSync(entriesDir, { recursive: true, force: true })
  symlinkSync(outside, entriesDir, 'junction')
  const service = new MemoryHubService({ store, config: { writePolicy: 'auto' }, gate: async () => ({ outcome: 'allowed', source: 'gate' }) })
  await assert.rejects(
    service.commit({ entry: { title: '越界写' } }),
    (err) => err.code === 'INVALID_INPUT' && /realpath|越界/.test(err.message),
    '经 junction 的越界写必须被拒绝',
  )
  rmSync(hub, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test('日志 scope 穿越向量（../ 等）被安全化', async () => {
  const hub = mkdtempSync(join(tmpdir(), 'dsh-mh-path5-'))
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const service = new MemoryHubService({ store, config: { writePolicy: 'auto' }, gate: async () => ({ outcome: 'allowed', source: 'gate' }) })
  const r = service.log({ scope: '../../evil', text: 'x' })
  assert.ok(!r.path.includes('..'), 'scope 归一后不含穿越段：' + r.path)
  assert.ok(r.path.startsWith(hub) || r.scope === 'evil', '落在 hub 内')
  rmSync(hub, { recursive: true, force: true })
})
