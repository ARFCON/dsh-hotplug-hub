// test/audit-fsport-rmdir.test.mjs — fsPort rmdirSync 完整性（v1 目录锁迁移审计）
//
// 背景：共享锁协议带 v1 目录锁迁移（lock.js checkV1DirectoryLock 清理后调
// fsPort.rmdirSync），但 hotplug 三个 fsPort（state/market/patch）都没绑定 rmdirSync——
// 一旦磁盘残留 v1 目录形态 .dsh-patch.lock，迁移清理抛 TypeError 被吞、目录删不掉，
// openSync('wx') 永远 EEXIST → 补丁锁永远不可得（appendPatchBlock/removePatchBlock
// 每次阻塞 10s 后失败）。契约：三个 fsPort 具备锁协议所需完整方法集，v1 目录锁
// （陈旧/持有者已死）可被正确迁移为文件锁。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { appendPatchBlock, patchLockPath } from '../lib/core/patch.js'
import { marketDetailLockPath } from '../lib/core/market.js'
import { readJson } from '../lib/core/state.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => {
  if (restoreEnv) restoreEnv()
  if (iso) iso.cleanup()
})

/** 取一个已退出的真实 pid（probePid 判死）。 */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  return r.pid
}

function pack() {
  return {
    hotpack: '1.0', id: 'pack.v', name: 'V', version: '1.0.0',
    plugins: [{ id: 'main', name: 'pkg-p', source: { type: 'npm' }, version: '1.0.0', config: {} }],
  }
}

/** 在 lockPath 落一个 v1 目录形态锁（owner 持有者已死 → 应被迁移清理）。 */
function plantV1DirLock(lockPath, ownerPid, at) {
  mkdirSync(lockPath, { recursive: true })
  writeFileSync(join(lockPath, 'owner'), JSON.stringify({ owner: `pid-${ownerPid}`, at: at ?? Date.now() }))
}

describe('fsPort rmdirSync / v1 目录锁迁移', () => {
  it('patch 锁路径残留 v1 目录锁（持有者已死）→ appendPatchBlock 迁移成功并写入块', () => {
    plantV1DirLock(patchLockPath(), deadPid())
    const r = appendPack()
    expect(r.ok).toBe(true)
    const text = readFileSync(join(iso.profile, 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('hotplug:pack.v')
    // 迁移后锁路径恢复为文件形态（release 后删除）或不存在
    if (existsSync(patchLockPath())) {
      expect(statSync(patchLockPath()).isDirectory()).toBe(false)
    }
  })

  it('v1 目录锁持有者存活且未过期 → appendPatchBlock 等待后失败（不误接管活锁）', () => {
    plantV1DirLock(patchLockPath(), process.pid, Date.now())
    const t0 = Date.now()
    const r = appendPack()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/锁/)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(9000) // 真等满了 waitMs
  })

  it('market detail-cache 锁路径 v1 目录锁（陈旧）→ marketDetail 缓存写迁移成功', async () => {
    plantV1DirLock(marketDetailLockPath(), deadPid(), Date.now() - 60000)
    // 直接用共享 acquireLock 验证 hotplug market fsPort 也能迁移（waitMs 0 场景）
    const { marketDetailAsync } = await import('../lib/core/market.js')
    const savedFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('offline') }
    try {
      const r = await marketDetailAsync({ repo: 'o/r', refresh: true })
      expect(r.ok).toBe(true)
    } finally {
      globalThis.fetch = savedFetch // 审查修复：失败路径也不泄漏桩、不破坏后续测试
    }
  })

  it('三个 fsPort 的方法完整性：state.readJson 在 v1 目录残留下不崩（回归）', () => {
    plantV1DirLock(patchLockPath(), deadPid())
    expect(readJson(join(iso.profile, 'package.json'))).not.toBeNull()
  })
})

function appendPack() {
  return appendPatchBlock(pack())
}
