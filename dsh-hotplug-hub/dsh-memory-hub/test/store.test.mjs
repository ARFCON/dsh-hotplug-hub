// test/store.test.mjs — 存储引擎单测：原子写/记忆包/条目/索引/审计/归档/revision。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, isExpired } from '../lib/store.mjs'
import { serializeEntry, deserializeEntryFile } from '../lib/store.mjs'

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'memory-hub-test-'))
  return { dir, store: new MemoryStore(dir) }
}

test('创建默认包并写 routes', () => {
  const { store } = freshStore()
  store.ensureDefaultPack()
  assert.ok(store.hasPack('global-pack'))
  const p = store.readPack('global-pack')
  assert.equal(p.memoryPackId, 'global-pack')
  assert.equal(p.scope, 'global')
  assert.equal(p.schemaVersion, 1)
  assert.ok(Array.isArray(p.keywords))
  assert.equal(p.entries, 0)
})

test('创建多记忆包 + 关键词路由', () => {
  const { store } = freshStore()
  store.ensureDefaultPack()
  store.createPack({ memoryPackId: 'project-devtools', scope: 'global', keywords: ['构建', 'build', '插件'] })
  store.writeRoutes({
    schemaVersion: 1,
    routes: [
      { keywords: ['构建', 'build'], packId: 'project-devtools' },
      { keywords: ['用户'], packId: 'global-pack' },
    ],
    fallbackPackId: 'global-pack',
  })
  assert.deepEqual(store.listPackIds().sort(), ['global-pack', 'project-devtools'])
  // 路由包含关系（对 CJK 整段词）
  store.writeRoutes(store.readRoutes())
  assert.ok(store.readRoutes().routes.length === 2)
})

test('条目写入/读取/序列化往返', () => {
  const { store } = freshStore()
  store.ensureDefaultPack()
  const entry = {
    id: 'mem-1234567890abcdef',
    revision: 3,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T01:00:00.000Z',
    name: 'dsh-plugin-build-rule',
    title: 'DSH 插件构建规则',
    description: '插件包用 dev_build_plugin 构建，产物 tgz 进桌面',
    type: 'project',
    scope: 'global',
    activation: 'relevant',
    volatility: 'stable',
    subjectKey: 'dsh.build_plugin',
    expiresAt: null,
    lastVerifiedAt: null,
    keywords: ['构建', '插件', 'build', 'tgz'],
    tagged: ['mem-1234567890abcdef'],
    body: '插件生产线：dev_scaffold → dev_build → dev_inject。',
  }
  store.writeEntryFile('global-pack', entry)
  const path = store.entryPath('global-pack', entry.name)
  assert.ok(existsSync(path))
  const text = readFileSync(path, 'utf8')
  assert.ok(text.startsWith('---\n'), '应为 frontmatter 包裹')
  const parsed = deserializeEntryFile(text, entry.name)
  assert.equal(parsed.id, entry.id)
  assert.equal(parsed.revision, 3)
  assert.deepEqual(parsed.keywords, ['构建', '插件', 'build', 'tgz'])
  assert.equal(parsed.body, entry.body)
  assert.deepEqual(parsed.tagged, ['mem-1234567890abcdef'])
  // 重新读
  const reread = store.readEntry('global-pack', entry.name)
  assert.equal(reread.title, entry.title)
})

test('revision 快照与归档', () => {
  const { store } = freshStore()
  store.ensureDefaultPack()
  const entry = { id: 'mem-abcdefabcdefab12', revision: 1, name: 'fact-a', title: 'A', type: 'project', scope: 'global', body: 'v1' }
  store.writeEntryFile('global-pack', entry)
  store.snapshotRevision('global-pack', entry)
  assert.deepEqual(store.listRevisions('global-pack', entry.id), [1])
  const archived = { ...entry, revision: 2, body: 'v2' }
  store.archiveEntry('global-pack', archived)
  const arch = store.listArchived('global-pack')
  assert.equal(arch.length, 1)
  assert.equal(arch[0].entry.body, 'v2')
})

test('subject 冲突检测', () => {
  const { store } = freshStore()
  store.ensureDefaultPack()
  const a = { id: 'mem-aaaaaaaaaaaaaaa1', revision: 1, name: 'a', title: 'A', scope: 'global', subjectKey: 'pkg.mgr', keywords: [], tagged: [] }
  store.writeEntryFile('global-pack', a)
  const holder = store.subjectHolder('global-pack', 'pkg.mgr')
  assert.ok(holder !== null)
  assert.equal(holder.holder.name, 'a')
  assert.equal(store.subjectHolder('global-pack', 'other'), null)
})

test('审计账本追加与查询', () => {
  const { store } = freshStore()
  store.auditAppend({ action: 'create', packId: 'p', entryId: 'mem-1', operator: 'agent', outcome: 'ok' })
  store.auditAppend({ action: 'adopt', packId: 'p', proposalId: 'p-1', operator: 'user', outcome: 'ok' })
  const rows = store.auditList()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].action, 'adopt', '最新在前（reverse）')
  assert.ok(rows[0].at)
  const filtered = store.auditList({ filter: (r) => r.entryId === 'mem-1' })
  assert.equal(filtered.length, 1)
})

test('过期判定', () => {
  const old = { expiresAt: '2020-01-01T00:00:00Z' }
  const never = { expiresAt: null }
  assert.ok(isExpired(old))
  assert.ok(!isExpired(never))
})

test('原子写不残留 tmp 文件', () => {
  const { store } = freshStore()
  store.ensureDefaultPack()
  store.writeEntryFile('global-pack', { id: 'mem-1234567890abcdef', revision: 1, name: 'x', title: 'X', scope: 'global', body: 'b' })
  const entriesDir = join(store.packDir('global-pack'), 'entries')
  const names = readdirSync(entriesDir)
  assert.deepEqual(names, ['x.md'])
})

test('serializeEntry 稳定（同输入同输出）', () => {
  const entry = { id: 'mem-1', revision: 2, name: 'n', title: 'T', type: 'reference', scope: 'global', keywords: ['k'], tagged: [], body: 'b' }
  assert.equal(serializeEntry(entry), serializeEntry(entry))
})
