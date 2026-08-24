// test/crossproc-patch-lock.test.mjs — 跨进程锁互操作（真实子 node 进程持有 vendored 文件锁）
//
// 覆盖四写者补丁锁（<profile>/.dsh-patch.lock）与市场详情缓存锁
// （<hotplug-hub>/market-detail-cache.lock）的跨进程协议（vendor-shared fs/lock）：
//   A 他进程持有后正常释放 → 父侧 appendPatchBlock 阻塞等待后成功；
//   B 他进程带心跳长持 → 父侧按 waitMs（patch.js 固定 10s）超时失败；
//   C 持锁子进程崩溃（未释放）→ 父侧按 pid 探活立即接管；
//   D 详情缓存锁被他进程持有时 marketDetailAsync 跳过缓存写但正常返回（waitMs:0 契约）。
// 子进程经 process.execPath -e 直连 vendored CJS 入口（node -e 默认 CommonJS，require 可用）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { appendPatchBlock, patchLockPath } from '../lib/core/patch.js'
import { marketDetailAsync, marketDetailLockPath } from '../lib/core/market.js'
import { MARKET_DETAIL_CACHE_FILE } from '../lib/core/paths.js'
import { applyIsolatedEnv, isolatedDsh, samplePack } from './helpers.mjs'

// 子进程 require 的 vendored CJS 入口绝对路径（vendor-shared/index.mjs 的 ESM 垫片同源）
const VENDOR_INDEX = fileURLToPath(new URL('../vendor-shared/index.js', import.meta.url))

let restoreEnv = null
let iso = null
let savedFetch = null
const children = []

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
  savedFetch = globalThis.fetch
})
afterEach(() => {
  globalThis.fetch = savedFetch
  // 兜底清理：杀掉所有尚存活的子进程（child 本身就是 node，kill 即可终结心跳 Worker）
  for (const child of children.splice(0)) {
    try { child.kill() } catch { /* 已退出 */ }
  }
  if (restoreEnv) restoreEnv()
  if (iso) iso.cleanup()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 子进程脚本：拿锁（心跳保活）→ stdout 报告 HELD → 持有 holdMs 后释放退出；crash 时立即退出不释放。 */
function childScript(lockPath, holdMs, { refreshMs = 1000, crash = false } = {}) {
  return [
    "const fs = require('node:fs');",
    `const { acquireLock, releaseLock } = require(${JSON.stringify(VENDOR_INDEX)});`,
    `const lockPath = ${JSON.stringify(lockPath)};`,
    `const a = acquireLock(fs, lockPath, { waitMs: 5000, refreshMs: ${refreshMs} });`,
    "if (!a.ok) { process.stderr.write(String(a.error && a.error.message)); process.exit(2); }",
    "process.stdout.write('HELD');",
    crash
      ? 'process.exit(1);'
      : [
          'setTimeout(() => {',
          '  const r = releaseLock(fs, lockPath, { pid: process.pid, fd: a.fd, refresh: a.refresh });',
          "  process.stdout.write(r.ok ? 'RELEASED' : 'RELEASE_FAIL');",
          '  process.exit(0);',
          `}, ${holdMs});`,
        ].join('\n'),
  ].join('\n')
}

/** 等待 emitter 的一次事件（限时，防挂死）。 */
function waitFor(emitter, event, ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), ms)
    emitter.once(event, (...args) => { clearTimeout(timer); resolve(args) })
  })
}

/** spawn 持锁子进程并等到它真正持有锁（stdout 出现 HELD；crash 模式按退出 + 锁文件残留判定）。 */
async function spawnHolder(lockPath, holdMs, opts = {}) {
  const child = spawn(process.execPath, ['-e', childScript(lockPath, holdMs, opts)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { out += c })
  if (opts.crash) {
    // 崩溃模式：子进程拿锁后立即 process.exit(1)（stdout 标记可能来不及冲刷，不依赖它）
    const [code] = await waitFor(child, 'close')
    expect(code).toBe(1) // 2 = 子进程拿锁失败（测试基础设施问题，不是被测行为）
    while (!existsSync(lockPath)) await sleep(10) // acquire 的同步 fs 写在 exit 前完成
    return child
  }
  const deadline = Date.now() + 15000
  while (!out.includes('HELD') && Date.now() < deadline) await sleep(20)
  if (!out.includes('HELD')) throw new Error(`子进程未能在限时内持有锁：${out}`)
  return child
}

describe('跨进程补丁锁互操作（真实子 node 进程）', () => {
  it('A 他进程持有 1.5s 后释放：appendPatchBlock 阻塞等待后成功写入', async () => {
    const child = await spawnHolder(patchLockPath(), 1500)
    const t0 = Date.now()
    const r = appendPatchBlock(samplePack())
    const elapsed = Date.now() - t0
    // 阻塞等待他进程释放（~1.5s）后才成功
    expect(r.ok).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(1200)
    expect(readFileSync(join(iso.profile, 'cordis.patch.yml'), 'utf8')).toContain('hotplug:pack.test')
    // 子进程退出后锁文件不残留（双方各自 release 均 unlink）
    await waitFor(child, 'close')
    expect(existsSync(patchLockPath())).toBe(false)
  })

  it('B 他进程带心跳长持（12s）：appendPatchBlock 约 10s 后以锁获取失败结束', async () => {
    // refreshMs 1000：Worker 心跳持续刷新 token，父侧不得按陈旧/pid 死误接管
    const child = await spawnHolder(patchLockPath(), 12000, { refreshMs: 1000 })
    const t0 = Date.now()
    const r = appendPatchBlock(samplePack())
    const elapsed = Date.now() - t0
    expect(r.ok).toBe(false)
    expect(r.error).toContain('锁获取失败')
    // patch.js 的 waitMs 固定 10s：必须等满（而非提前失败/提前接管）
    expect(elapsed).toBeGreaterThanOrEqual(9000)
    expect(elapsed).toBeLessThanOrEqual(14000)
    // 写路径从未执行（不产生半截产物）
    expect(existsSync(join(iso.profile, 'cordis.patch.yml'))).toBe(false)
    child.kill()
  })

  it('C 持锁子进程崩溃（未释放）：父侧按 pid 探活立即接管并成功写入', async () => {
    await spawnHolder(patchLockPath(), 0, { crash: true })
    // Windows 上子进程句柄释放需要一小段时间：稍等后 pid 探活即为 ESRCH（可立即接管）
    await sleep(300)
    expect(existsSync(patchLockPath())).toBe(true) // 崩溃残留（token 指向已死 pid）
    const r = appendPatchBlock(samplePack())
    expect(r.ok).toBe(true)
    expect(readFileSync(join(iso.profile, 'cordis.patch.yml'), 'utf8')).toContain('hotplug:pack.test')
    // 接管 + 写入 + 释放后无残留锁
    expect(existsSync(patchLockPath())).toBe(false)
  })

  it('D 市场详情缓存锁互操作：他进程持锁时 marketDetail 跳过缓存写但正常返回', async () => {
    const child = await spawnHolder(marketDetailLockPath(), 3000) // 审查修复：1s 持锁窗在重载 CI 上可能不够（marketDetailAsync 需在窗内完成才走「跳过缓存写」分支）
    // fetch 桩：仓库只有 package.json（兜底单插件 manifest 模式，market-net.test.mjs 同款）
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('package.json')) return { ok: true, status: 200, text: async () => '{"name":"pkg-r","version":"1.0.0"}' }
      return { ok: false, status: 404, text: async () => '' }
    }
    const r = await marketDetailAsync({ repo: 'o/r', ref: 'main', sources: ['github'] })
    expect(r.ok).toBe(true)
    expect(r.entry.importable).toBe(true)
    expect(r.entry.manifest.plugins[0].source.type).toBe('github')
    // 缓存写锁 waitMs:0 → 他进程持有时立即放弃：缓存文件不落地（主流程不受影响）
    expect(existsSync(MARKET_DETAIL_CACHE_FILE())).toBe(false)
    // 判定期间他进程仍持锁（1s 持有窗口内完成）
    expect(existsSync(marketDetailLockPath())).toBe(true)
    await waitFor(child, 'close')
  })
})
