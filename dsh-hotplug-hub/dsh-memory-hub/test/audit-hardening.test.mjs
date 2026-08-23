/**
 * dsh-memory-hub / test/audit-hardening.test.mjs — 全面审计加固回归测试。
 *
 * 覆盖本轮审计发现并修复的根因，每一处都用真实行为断言：
 *  1) restore 恢复后归档副本必须删除（不再"活跃+归档"双态漂移）
 *  2) 更新路径变更 subjectKey 到他人持有者 → 冲突拒绝（一 subject 一活跃值）
 *  3) subjectKey 字符集契约（与 schema 一致）强制校验
 *  4) slugify 对纯标点/emoji 标题产出合法 name（不再崩溃）
 *  5) freshness 三档（fresh/stale/expired）：超出 current 窗口归 expired
 *  6) appendProposal 返回刚构造的记录（不再按 createdAt 排序误取）
 *  7) allArchived 跨包聚合 + deleteArchivedFile 删除
 *  8) appendLog 持锁且不留锁文件
 *  9) truncateCodePoints 不在代理对中间切断（emoji 不产生孤立代理）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MemoryStore } from '../lib/store.mjs'
import { MemoryHubService } from '../lib/service.mjs'
import { slugify } from '../lib/protocol.mjs'
import { freshnessOf } from '../lib/bm25.mjs'
import { NAME_RE } from '../lib/constants.mjs'
import { SubjectConflictError, InvalidInputError } from '../lib/errors.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function mount(dir, writePolicy = 'auto') {
  const store = new MemoryStore(dir)
  store.ensureDefaultPack()
  const service = new MemoryHubService({
    store,
    config: { writePolicy, snapshotChars: 2560, searchLimit: 4 },
    gate: async () => ({ outcome: writePolicy === 'auto' ? 'allowed' : 'queued', source: 'gate' }),
  })
  return { store, service }
}

const fact = (o = {}) => ({ title: '事实', body: '正文', ...o })

// 1) restore 恢复后归档副本删除 + 不留锁文件
test('restore：恢复后归档副本删除，条目不再同时处于活跃+归档双态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-audit-restore-'))
  const { store, service } = mount(dir)
  await service.commit({ entry: fact({ title: 'A' }) })
  const e = store.allEntries()[0].entry
  await service.submit({ action: 'remove', packId: 'global-pack', entry: { id: e.id } })
  assert.equal(store.listArchived('global-pack').length, 1, '删除后归档 1 条')

  const restored = service.restoreArchived('global-pack', e.name)
  assert.equal(restored.revision, e.revision + 1, '恢复后 revision+1')
  assert.equal(store.allEntries().length, 1, '恢复后活跃 1 条')
  assert.equal(store.listArchived('global-pack').length, 0, '恢复后归档副本必须删除（根因修复）')
  assert.equal(existsSync(join(dir, '.dsh-memory.lock')), false, '恢复后锁文件必须释放')
})

// 2) 更新路径变更 subjectKey 到他人持有者 → 冲突
test('subjectKey：更新把 subjectKey 挪到他人持有者 → SubjectConflictError（一 subject 一活跃值）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-audit-subj-'))
  const { store, service } = mount(dir)
  await service.commit({ entry: fact({ title: 'A', name: 'a', subjectKey: 'x' }) })
  await service.commit({ entry: fact({ title: 'B', name: 'b', subjectKey: 'y' }) })

  await assert.rejects(
    () => service.commit({ entry: fact({ title: 'A2', name: 'a', subjectKey: 'y' }) }),
    (e) => e instanceof SubjectConflictError,
  )
  const holdersY = store.allEntries().filter(({ entry }) => entry.subjectKey === 'y')
  assert.equal(holdersY.length, 1, 'y 仍只有一个持有者')
  assert.equal(holdersY[0].entry.name, 'b', 'b 仍是 y 的持有者')
})

// 3) subjectKey 字符集契约
test('subjectKey：非法字符集（大写/空格/符号）被 InvalidInputError 拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-audit-subjre-'))
  const { service } = mount(dir)
  for (const bad of ['UPPER case!', 'x y', '.lead', 'trail.', 'a..b', '😀']) {
    await assert.rejects(
      () => service.commit({ entry: fact({ subjectKey: bad }) }),
      (e) => e instanceof InvalidInputError && e.code === 'INVALID_INPUT',
      `subjectKey ${JSON.stringify(bad)} 应被拒绝`,
    )
  }
  // 合法示例通过
  const ok = await service.commit({ entry: fact({ title: '合法', subjectKey: 'dsh.build_plugin' }) })
  assert.equal(ok.entry.subjectKey, 'dsh.build_plugin')
})

// 4) slugify 合法名
test('slugify：纯标点/emoji 标题回退 m-untitled，中文/合法名保留', () => {
  for (const t of ['!!!', '😀', '。。。', '───', '...///', '   ']) {
    const s = slugify(t)
    assert.equal(s, 'm-untitled', `标题 ${JSON.stringify(t)} 应回退 m-untitled，实得 ${s}`)
    assert.ok(NAME_RE.test(s), `${s} 必须合法`)
  }
  assert.equal(slugify('构建插件'), '构建插件', '中文标题原样保留')
  assert.equal(slugify('DSH Build'), 'dsh-build', '拉丁标题 kebab 化')
  assert.ok(NAME_RE.test(slugify('DSH Build')))
})

// 5) freshness 三档
test('freshness：三档模型——fresh / stale / expired（超出 current 窗口=expired）', () => {
  const base = { expiresAt: null, lastVerifiedAt: null, volatility: 'stable' }
  const fresh = freshnessOf({ ...base, updatedAt: new Date().toISOString() })
  assert.equal(fresh, 'fresh')
  const stale = freshnessOf({ ...base, updatedAt: new Date(Date.now() - 200 * 86400000).toISOString() })
  assert.equal(stale, 'stale', '200 天（stable current=365）应为 stale')
  const expired = freshnessOf({ ...base, updatedAt: new Date(Date.now() - 400 * 86400000).toISOString() })
  assert.equal(expired, 'expired', '400 天（超出 current=365）应为 expired（根因修复）')
  // lastVerifiedAt 手动核验 → 恒 fresh
  assert.equal(freshnessOf({ ...base, updatedAt: '2020-01-01T00:00:00Z', lastVerifiedAt: new Date().toISOString() }), 'fresh')
})

// 6) appendProposal 返回刚构造的记录
test('appendProposal：返回刚构造的记录（含 id/status/createdAt），不靠排序重读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-audit-prop-'))
  const { store } = mount(dir)
  store.ensureDefaultPack()
  const p = store.appendProposal('global-pack', { kind: 'create', entry: { title: 'X' }, reason: 'r' })
  assert.ok(p.id.startsWith('p-'), '提案 id 形如 p-')
  assert.equal(p.packId, 'global-pack')
  assert.equal(p.status, 'pending')
  assert.equal(p.kind, 'create')
  assert.ok(p.createdAt, '有 createdAt')
  // 提案文件落盘且 id 与文件名一致
  const files = readdirSync(join(store.packDir('global-pack'), '.proposals'))
  assert.ok(files.some((f) => f === `${p.id.slice(2)}.json`), '文件名与 id 对应')
})

// 7) allArchived 跨包 + deleteArchivedFile
test('allArchived：跨包聚合归档；deleteArchivedFile 删除归档副本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-audit-allarch-'))
  const { store, service } = mount(dir)
  store.createPack({ memoryPackId: 'p2', scope: 'global' })
  await service.commit({ entry: fact({ title: 'A' }) })
  await service.commit({ entry: fact({ title: 'B' }), pack: 'p2' })
  const all = store.allEntries()
  for (const { packId, entry } of all) {
    await service.submit({ action: 'remove', packId, entry: { id: entry.id } })
  }
  assert.equal(store.allArchived().length, 2, '跨包归档聚合 2 条')
  store.deleteArchivedFile('global-pack', store.listArchived('global-pack')[0].entry.name)
  assert.equal(store.listArchived('global-pack').length, 0, 'deleteArchivedFile 生效')
})

// 8) appendLog 持锁 + 不留锁文件
test('appendLog：追加累计行数，写后释放锁（不留 .dsh-memory.lock）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-audit-log-'))
  const { store } = mount(dir)
  const r1 = store.appendLog('project-x', '第一行')
  const r2 = store.appendLog('project-x', '第二行')
  assert.equal(r1.line, 1)
  assert.equal(r2.line, 2, '第二次追加累计 2 行')
  assert.equal(existsSync(join(dir, '.dsh-memory.lock')), false, '日志写后锁文件必须释放')
})

// 8b) listRevisions revision ≥ 1000 仍按数值排序
test('listRevisions：revision ≥ 1000 仍按数值排序（非字符串序）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-audit-rev-'))
  const { store } = mount(dir)
  const revDir = join(store.packDir('global-pack'), '.revisions', 'mem-1234567890abcdef')
  mkdirSync(revDir, { recursive: true })
  writeFileSync(join(revDir, '999.md'), '---\n')
  writeFileSync(join(revDir, '1000.md'), '---\n')
  writeFileSync(join(revDir, '2.md'), '---\n')
  const revs = store.listRevisions('global-pack', 'mem-1234567890abcdef')
  assert.deepEqual(revs, [2, 999, 1000], '必须按整数单调递增')
})

// 9) truncateCodePoints 不在代理对中间切断
test('truncateCodePoints：emoji（astral）边界不产生孤立代理', async () => {
  const { truncateCodePoints } = await import(pathToFileURL(join(here, '..', 'lib', 'index.mjs')).href)
  // "A😀B"：A(1) + 😀(高代理+低代理，占2) + B(1)。截到 max=2 会切在高低代理之间 → 应回退到 1
  const s = truncateCodePoints('A😀B', 2)
  assert.equal(s, 'A', '应回退到代理对之前，产出 A')
  assert.equal(s.length, 1)
  // 截断不触发（足够长）
  assert.equal(truncateCodePoints('ABC', 5), 'ABC')
  // 空/零边界
  assert.equal(truncateCodePoints('', 0), '')
  assert.equal(truncateCodePoints('ABC', 0), '')
})
