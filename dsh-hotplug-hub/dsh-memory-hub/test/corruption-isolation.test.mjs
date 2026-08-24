/**
 * dsh-memory-hub / test/corruption-isolation.test.mjs — 读路径故障隔离（H5/S3 根治验收）。
 *
 * 此前缺陷：单个损坏/手改（CRLF）条目文件让 listEntries→allEntries→search/list/
 * 快照/rebuildIndex 全线抛 InvalidInputError——一个坏文件放大为全库读写瘫痪。
 * 根治：readEntry 捕获解析错误 → 每文件一次大声告警 + 审计留痕 → 跳过（null）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.mjs'
import { MemoryHubService } from '../lib/service.mjs'

function makeHub() {
  const hub = mkdtempSync(join(tmpdir(), 'dsh-mh-corrupt-'))
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const service = new MemoryHubService({ store, config: { writePolicy: 'auto' }, gate: async () => ({ outcome: 'allowed', source: 'gate' }) })
  return { hub, store, service }
}
const packDirOf = (store) => join(store.hubDir, store.listPackIds()[0])

test('坏行文件：读跳过 + 写不受阻 + 其余条目可见', async () => {
  const { hub, store, service } = makeHub()
  await service.commit({ entry: { title: '好条目A' } })
  writeFileSync(join(packDirOf(store), 'entries', '坏行条目.md'), '---\nid: mem-0000000000000000\n这行没有冒号\n---\n\nbody')
  await service.commit({ entry: { title: '好条目B' } })
  const names = store.allEntries().map(({ entry }) => entry.name)
  assert.ok(names.includes('好条目a'), '好条目 A 可见')
  assert.ok(names.includes('好条目b'), '好条目 B 可见（坏文件不阻塞写入）')
  assert.ok(!names.includes('坏行条目'), '坏文件自身被跳过')
  const res = service.search('好条目', {})
  assert.ok(res.hits.length >= 1, 'search 不被坏文件炸掉')
  rmSync(hub, { recursive: true, force: true })
})

test('CRLF 手改文件：可正常解析（行尾归一）', async () => {
  const { hub, store, service } = makeHub()
  await service.commit({ entry: { title: 'CRLF前' } })
  writeFileSync(join(packDirOf(store), 'entries', '换行手改.md'), '---\r\nid: mem-0000000000000001\r\ntitle: "换行标题"\r\nrevision: 3\r\n---\r\n\r\n正文行\r\n第二行')
  const e = store.listEntries(store.listPackIds()[0]).find((x) => x.name === '换行手改')
  assert.ok(e, 'CRLF 文件应可解析')
  assert.equal(e.title, '换行标题')
  assert.equal(e.revision, 3)
  assert.ok(e.body.includes('正文行'))
  rmSync(hub, { recursive: true, force: true })
})

test('非法枚举（type: 私有）文件：跳过不炸', async () => {
  const { hub, store, service } = makeHub()
  await service.commit({ entry: { title: '正常' } })
  writeFileSync(join(packDirOf(store), 'entries', '坏枚举.md'), '---\nid: mem-0000000000000002\ntitle: "坏枚举"\ntype: 私有\n---\n\nbody')
  assert.equal(store.allEntries().length, 1, '坏枚举文件跳过，正常条目计数正确')
  rmSync(hub, { recursive: true, force: true })
})

test('损坏告警：每文件一次 + 审计留痕（corrupt-skip 行）', async () => {
  const { hub, store, service } = makeHub()
  writeFileSync(join(packDirOf(store), 'entries', '告警一次.md'), '---\n坏行\n---\n\nb')
  store.allEntries() // 第一次读 → 告警 + 审计
  store.allEntries() // 第二次读 → 不重复
  store.allEntries()
  const rows = store.auditList({ limit: 50 }).filter((r) => r.action === 'corrupt-skip')
  assert.equal(rows.length, 1, 'corrupt-skip 审计恰好一行（每文件一次）')
  rmSync(hub, { recursive: true, force: true })
})

test('修复坏文件后恢复正常可见', async () => {
  const { hub, store, service } = makeHub()
  const p = join(packDirOf(store), 'entries', '可修复.md')
  writeFileSync(p, '---\n坏\n---\n\nb')
  assert.equal(store.allEntries().filter(({ entry }) => entry.name === '可修复').length, 0)
  writeFileSync(p, '---\nid: mem-0000000000000003\ntitle: "修好了"\n---\n\n正文')
  const e = store.listEntries(store.listPackIds()[0]).find((x) => x.name === '可修复')
  assert.ok(e, '修复后立即可见')
  assert.equal(e.title, '修好了')
  rmSync(hub, { recursive: true, force: true })
})

test('损坏归档文件：listArchived 跳过不炸', async () => {
  const { hub, store, service } = makeHub()
  await service.commit({ entry: { title: '归档项' } })
  const id = store.allEntries()[0].entry.id
  await service.removeDirect(id)
  const archiveDir = join(packDirOf(store), '.archive')
  writeFileSync(join(archiveDir, '坏归档.md'), '---\n坏\n---\n\nb')
  const archived = store.allArchived()
  assert.equal(archived.filter((a) => a.entry.id === id).length, 1, '正常归档可见')
  assert.equal(archived.filter((a) => a.entry.name === '坏归档').length, 0, '坏归档跳过')
  rmSync(hub, { recursive: true, force: true })
})

test('routes.json 损坏：大声降级默认路由（不静默吞）', async () => {
  const { hub, store, service } = makeHub()
  writeFileSync(join(store.hubDir, 'routes.json'), '{ 这不是 json')
  const routes = store.readRoutes()
  assert.equal(routes.fallbackPackId, 'global-pack', '损坏降级默认')
  const rows = store.auditList({ limit: 50 }).filter((r) => r.action === 'corrupt-skip')
  assert.equal(rows.length, 1, 'routes 损坏应留审计')
  const res = service.search('任意', {})
  assert.ok(Array.isArray(res.hits), 'search 仍可用')
  rmSync(hub, { recursive: true, force: true })
})

test('pack.json 损坏：该包从列表消失但不炸其它包', async () => {
  const { hub, store, service } = makeHub()
  store.createPack({ memoryPackId: 'second-pack', scope: 'global' })
  await service.commit({ entry: { title: '在第二包', pack: 'second-pack' } })
  writeFileSync(join(store.hubDir, 'second-pack', 'pack.json'), '{ 坏')
  const packs = store.listPacks().map((p) => p.memoryPackId)
  assert.ok(packs.includes('global-pack'), '健康包不受影响')
  assert.ok(!packs.includes('second-pack'), '损坏包从列表隐去（大声告警）')
  assert.ok(service.search('在第二包', { pack: 'second-pack' }).count === 0, '损坏包搜索返回空')
  rmSync(hub, { recursive: true, force: true })
})

test('同名条目文件损坏时写入：报 NotFound 并给出修复指引（不裸 TypeError）', async () => {
  const { hub, store, service } = makeHub()
  const p = join(packDirOf(store), 'entries', '损坏目标.md')
  writeFileSync(p, '---\n坏\n---\n\nb')
  await assert.rejects(
    service.commit({ entry: { title: '任何', name: '损坏目标' } }),
    (err) => err.code === 'NOT_FOUND' && /损坏/.test(err.message),
  )
  rmSync(hub, { recursive: true, force: true })
})

test('非 .md 杂物文件被忽略', async () => {
  const { hub, store, service } = makeHub()
  writeFileSync(join(packDirOf(store), 'entries', 'note.txt'), 'junk')
  await service.commit({ entry: { title: '正常' } })
  assert.equal(store.allEntries().length, 1)
  rmSync(hub, { recursive: true, force: true })
})
