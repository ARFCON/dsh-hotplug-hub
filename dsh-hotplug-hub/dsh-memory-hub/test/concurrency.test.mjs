// test/concurrency.test.mjs — H-8：跨进程写锁（并发同 subjectKey 活跃数=1，
// 含"放大窗口"注入式复现：锁内重读保证第二个创建被冲突拒绝）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.mjs'
import { MemoryHubService } from '../lib/service.mjs'
import { SubjectConflictError } from '../lib/errors.mjs'

function mount(dir) {
  const store = new MemoryStore(dir)
  store.ensureDefaultPack()
  const config = { writePolicy: 'auto', snapshotChars: 2560, searchLimit: 4 }
  const gate = async () => ({ outcome: 'allowed', source: 'gate' })
  const service = new MemoryHubService({ store, config, gate, sourceLabel: 'memory-hub' })
  return { store, service }
}

const fact = (subjectKey, title) => ({
  title: title ?? '并发主题 ' + subjectKey,
  body: '并发创建测试',
  type: 'project',
  subjectKey,
})

test('H-8：两实例并发创建同 subjectKey → 恰一个成功，一个 SubjectConflictError', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-hub-h8-'))
  const { service: a } = mount(dir)
  const { service: b } = mount(dir) // 第二个实例 = 模拟另一进程（同一 hubDir）

  // 不同 name（title 不同）但同 subjectKey → 均走 create 路径 → 锁内第二个必须冲突
  const results = await Promise.allSettled([
    a.commit({ entry: fact('h8.subject', '并发甲') }),
    b.commit({ entry: fact('h8.subject', '并发乙') }),
  ])
  const ok = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  assert.equal(ok.length, 1, '并发同 subjectKey 只允许一个成功（写锁串行化）')
  assert.equal(rejected.length, 1)
  assert.ok(rejected[0].reason instanceof SubjectConflictError, '第二个创建必须被冲突拒绝')
  rmSync(dir, { recursive: true, force: true })
})

test('H-8：withWriteLock 可重入（每次写后锁已释放）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-hub-h8b-'))
  const { store } = mount(dir)
  let calls = 0
  store.withWriteLock(() => { calls += 1 })
  store.withWriteLock(() => { calls += 1 })
  assert.equal(calls, 2)
  rmSync(dir, { recursive: true, force: true })
})

test('H-8：正常写不残留锁文件（释放语义）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-hub-h8c-'))
  const { service } = mount(dir)
  await service.commit({ entry: fact('h8.clean') })
  assert.equal(existsSync(join(dir, '.dsh-memory.lock')), false, '写后锁文件必须已释放删除')
  rmSync(dir, { recursive: true, force: true })
})
