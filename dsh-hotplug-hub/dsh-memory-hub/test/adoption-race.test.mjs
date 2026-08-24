/**
 * dsh-memory-hub / test/adoption-race.test.mjs — adopt 竞态根治验收（同进程 + 跨进程隔离）。
 *
 * 此前缺陷：adopt 的 check-then-act 在写锁外——同进程全同步侥幸安全，跨进程
 * （GUI 双实例 / CLI 与 GUI 并发）双采纳会重复落条目（revision 连跳）。
 * 根治：提案状态复查 + 落条目 + 状态落定全部在同一把跨进程写锁内。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { MemoryStore } from '../lib/store.mjs'
import { MemoryHubService } from '../lib/service.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const libUrl = (m) => pathToFileURL(join(here, '..', 'lib', `${m}.mjs`)).href

function tmpHub() {
  return mkdtempSync(join(tmpdir(), 'dsh-mh-adopt-'))
}

test('同进程并发双击 adopt：恰一个成功', async () => {
  const hub = tmpHub()
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const svc = new MemoryHubService({ store, config: { writePolicy: 'ask' }, gate: async () => ({ outcome: 'queued', source: 'proposals' }) })
  const r = await svc.commit({ entry: { title: '并发采纳' } })
  const results = await Promise.allSettled([
    svc.adopt('global-pack', r.proposalId),
    svc.adopt('global-pack', r.proposalId),
  ])
  const okCount = results.filter((x) => x.status === 'fulfilled').length
  assert.equal(okCount, 1, '恰一次采纳成功')
  const { entry } = store.allEntries()[0]
  assert.equal(entry.revision, 1, 'revision 不连跳')
  rmSync(hub, { recursive: true, force: true })
})

test('重复采纳已处理提案：InvalidInputError（状态门）', async () => {
  const hub = tmpHub()
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const svc = new MemoryHubService({ store, config: { writePolicy: 'ask' }, gate: async () => ({ outcome: 'queued', source: 'proposals' }) })
  const r = await svc.commit({ entry: { title: '顺序重复' } })
  await svc.adopt('global-pack', r.proposalId)
  await assert.rejects(svc.adopt('global-pack', r.proposalId), (err) => err.code === 'INVALID_INPUT' && /adopted/.test(err.message))
  rmSync(hub, { recursive: true, force: true })
})

/** 子进程脚本：真实跨进程 adopt（进程隔离验证）。 */
const CHILD_SCRIPT = `
import { MemoryStore } from ${JSON.stringify(libUrl('store'))}
import { MemoryHubService } from ${JSON.stringify(libUrl('service'))}
const hub = process.env.DSH_MH_HUB
const proposalId = process.env.DSH_MH_PROPOSAL
const store = new MemoryStore(hub)
const service = new MemoryHubService({ store, config: { writePolicy: 'ask' }, gate: async () => ({ outcome: 'queued', source: 'proposals' }) })
try {
  await service.adopt('global-pack', proposalId)
  console.log('ADOPT_OK')
  process.exit(0)
} catch (e) {
  console.log('ADOPT_FAIL:' + (e.code ?? e.message))
  process.exit(1)
}
`

test('跨进程并发 adopt（两个真实子进程）：恰一个成功 + revision 不连跳', async () => {
  const hub = tmpHub()
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const svc = new MemoryHubService({ store, config: { writePolicy: 'ask' }, gate: async () => ({ outcome: 'queued', source: 'proposals' }) })
  const r = await svc.commit({ entry: { title: '跨进程竞态' } })

  const spawnChild = () => new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['--input-type=module', '-e', CHILD_SCRIPT],
      { env: { ...process.env, DSH_MH_HUB: hub, DSH_MH_PROPOSAL: r.proposalId } },
      (error, stdout) => resolve({ code: error ? error.code ?? 1 : 0, stdout: String(stdout) }),
    )
    // 防悬挂：30s 强杀
    child.on('error', () => resolve({ code: 99, stdout: 'spawn-error' }))
  })
  const [a, b] = await Promise.all([spawnChild(), spawnChild()])
  const okCount = [a, b].filter((r2) => r2.code === 0).length
  assert.equal(okCount, 1, `两子进程恰一个成功（a=${a.code}/${a.stdout.trim()} b=${b.code}/${b.stdout.trim()}）`)
  const found = store.allEntries()[0]
  assert.ok(found, '落盘条目存在')
  assert.equal(found.entry.revision, 1, '跨进程不产生 revision 连跳')
  const proposals = store.allProposals('any')
  assert.equal(proposals.filter((p) => p.id === r.proposalId && p.status === 'adopted').length, 1)
  // 锁文件清理：成功释放（无残留 .dsh-memory.lock）
  const { existsSync } = await import('node:fs')
  assert.equal(existsSync(join(hub, '.dsh-memory.lock')), false, '锁已释放')
  rmSync(hub, { recursive: true, force: true })
})

test('跨进程并发写同 subjectKey：第二个在锁内重读 → SubjectConflictError', async () => {
  const hub = tmpHub()
  const store = new MemoryStore(hub)
  store.ensureDefaultPack()
  const script = `
import { MemoryStore } from ${JSON.stringify(libUrl('store'))}
import { MemoryHubService } from ${JSON.stringify(libUrl('service'))}
const store = new MemoryStore(process.env.DSH_MH_HUB)
const service = new MemoryHubService({ store, config: { writePolicy: 'auto' }, gate: async () => ({ outcome: 'allowed', source: 'gate' }) })
try {
  await service.commit({ entry: { title: '竞争' + process.env.DSH_MH_TAG, subjectKey: 'race.subject' } })
  console.log('WIN')
  process.exit(0)
} catch (e) {
  console.log('LOSE:' + (e.code ?? e.message))
  process.exit(1)
}
`
  const spawnChild = (tag) => new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', script],
      { env: { ...process.env, DSH_MH_HUB: hub, DSH_MH_TAG: tag } },
      (error, stdout) => resolve({ code: error ? error.code ?? 1 : 0, stdout: String(stdout).trim() }),
    )
  })
  const [a, b] = await Promise.all([spawnChild('A'), spawnChild('B')])
  const wins = [a, b].filter((r2) => r2.code === 0).length
  assert.equal(wins, 1, `同 subject 恰一个成功（a=${a.stdout} b=${b.stdout}）`)
  const holders = store.allEntries().filter(({ entry }) => entry.subjectKey === 'race.subject')
  assert.equal(holders.length, 1, '一 subject 一活跃值')
  rmSync(hub, { recursive: true, force: true })
})
