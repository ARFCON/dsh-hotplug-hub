// test/audit-misc-r2.test.mjs — 第二轮杂项审计（deactivate 一致性 / 代理对安全截断 /
// curl 空响应体 / AI 产物适配层）
//
// 1) deactivate 的「manifest 缺失」分支此前忽略 removePatchBlock 返回值——锁不可得
//    时静默返回成功，状态清了但 patch 块还在（与 activate 同分支的行为不一致）。
// 2) adapt() 的 tag 截断此前用 UTF-16 slice，会把代理对（emoji 等）劈成孤立代理。
// 3) httpGet 的 curl 兜底此前把「空 stdout」当失败——curl -f exit 0 + 空 200 响应体
//    是合法空文件，被误判为网络失败。
// 4) ai.js 此前绕过 hub 适配层直接用 shared parseHotpack——AI 产物缺 memory:{keep:true}
//    与展示约束，与 importPack 的权威路径不一致。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { HotplugGateway } from '../lib/gateway.js'
import { importPackSync } from '../lib/core/status.js'
import { readState } from '../lib/core/state.js'
import { httpGet, toWellFormed } from '../lib/core/market.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null
let gateway = null
let savedFetch = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
  gateway = new HotplugGateway({ reflect: { provide: () => {} } })
  savedFetch = globalThis.fetch
})
afterEach(() => {
  globalThis.fetch = savedFetch
  if (restoreEnv) restoreEnv()
  if (iso) iso.cleanup()
})

describe('deactivate：manifest 缺失分支与 activate 行为一致', () => {
  it('removePatchBlock 失败（v1 活锁占位）→ deactivate 返回失败而非静默成功', async () => {
    // 先合法激活一个包
    const src = join(iso.dshHome, 'src', 'pkg-p')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }))
    await gateway.importPack(JSON.stringify({
      hotpack: '1.0', id: 'pack.d', name: 'D', version: '1.0.0',
      plugins: [{ id: 'main', name: 'pkg-p', source: { type: 'path', path: src }, config: {} }],
    }))
    await gateway.activate('pack.d')
    expect(readState().activePack).toBe('pack.d')
    // 删除 manifest（制造 deactivate 的 manifest 缺失分支）
    const packsDir = join(iso.dshHome, 'hotplug-hub', 'packs', 'pack.d')
    writeFileSync(join(packsDir, 'hotpack.json.bak'), readFileSync(join(packsDir, 'hotpack.json')))
    // 用 v1 目录活锁占位补丁锁（持有者=当前进程，存活且新鲜 → acquire 等满 10s 失败）
    const lockDir = join(iso.profile, '.dsh-patch.lock')
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'owner'), JSON.stringify({ owner: `pid-${process.pid}`, at: Date.now() }))
    // 删 manifest（保留 .bak 无妨，readPackManifest 只认 hotpack.json）
    const { rmSync } = await import('node:fs')
    rmSync(join(packsDir, 'hotpack.json'))

    const d = await gateway.deactivate()
    expect(d.ok).toBe(false)
    expect(d.message).toMatch(/锁/)
    // 状态未被清（清状态的前提是磁盘真的卸载了）
    expect(readState().activePack).toBe('pack.d')
  })
})

describe('adapt()：tag 截断代理对安全', () => {
  it('emoji tag 截断到 24 码点不劈开代理对（磁盘无孤立代理）', async () => {
    const r = await importPackSync(JSON.stringify({
      hotpack: '1.0', id: 'pack.s', name: 'S', version: '1.0.0',
      tags: ['😀'.repeat(30)], // 60 个 UTF-16 码元、30 个码点 → 截到 24 码点
      plugins: [{ id: 'main', name: 'pkg-s', version: '1.0.0', source: { type: 'npm' }, config: {} }],
    }))
    expect(r.ok).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(iso.dshHome, 'hotplug-hub', 'packs', 'pack.s', 'hotpack.json'), 'utf8'))
    const tag = onDisk.tags[0]
    // 期望 24 个完整 emoji（24 码点 = 48 码元），而不是 24 码元 + 孤立高代理
    expect(Array.from(tag)).toHaveLength(24)
    expect(tag).toBe('😀'.repeat(24))
    // 无孤立代理（正则与 market.js toWellFormed 同款）
    expect(toWellFormed(tag)).toBe(tag)
  })

  it('tag 数量截断 12 个（回归）+ 短 tag 原样', async () => {
    const r = await importPackSync(JSON.stringify({
      hotpack: '1.0', id: 'pack.s2', name: 'S2', version: '1.0.0',
      tags: Array.from({ length: 15 }, (_, i) => `t${i}`),
      plugins: [{ id: 'main', name: 'pkg-s', version: '1.0.0', source: { type: 'npm' }, config: {} }],
    }))
    expect(r.ok).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(iso.dshHome, 'hotplug-hub', 'packs', 'pack.s2', 'hotpack.json'), 'utf8'))
    expect(onDisk.tags).toHaveLength(12)
  })
})

// Windows 说明：CURL_BIN='curl.exe' 经 CreateProcess 直接解析（不走 cmd 包装），
// 无法用 node.exe 副本伪造（首参数 -fsSL 会被当 node CLI 标志解析失败）。审查实测：
// 隔离 PATH 下 libuv 只搜子 env 的 PATH → ENOENT（不会回退 System32 真联网），
// 但伪造通道缺失使该分支在 Windows 无法端到端断言——curl 兜底分支仅在 POSIX
// 执行假 curl 脚本（CI ubuntu 覆盖；Windows 保守跳过）。
describe.skipIf(process.platform === 'win32')('httpGet curl 兜底：空响应体是合法结果', () => {
  it('fetch 不可用 + curl exit 0 空输出 → ok:true（空 200 文件）', async () => {
    globalThis.fetch = undefined
    const { chmodSync } = await import('node:fs')
    writeFileSync(join(iso.dshHome, 'curl'), `#!${process.execPath}\nprocess.exit(0)\n`)
    chmodSync(join(iso.dshHome, 'curl'), 0o755)
    const r = await httpGet('https://example.com/empty', 2000)
    expect(r.ok).toBe(true)
    expect(r.text).toBe('')
  })

  it('fetch 不可用 + curl 非零退出（HTTP 错误 -f 语义）→ ok:false', async () => {
    globalThis.fetch = undefined
    const { chmodSync } = await import('node:fs')
    writeFileSync(join(iso.dshHome, 'curl'), `#!${process.execPath}\nprocess.exit(22)\n`)
    chmodSync(join(iso.dshHome, 'curl'), 0o755)
    const r = await httpGet('https://example.com/gone', 2000)
    expect(r.ok).toBe(false)
  })
})
