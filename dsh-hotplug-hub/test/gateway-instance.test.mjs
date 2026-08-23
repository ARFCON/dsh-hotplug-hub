// test/gateway-instance.test.mjs — HotplugGateway 实例方法（typert 基类真实接线）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { HotplugGateway } from '../lib/gateway.js'
import { readState } from '../lib/core/state.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null
let gateway = null
let savedFetch = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
  // Cordis 风格 ctx：reflect.provide 为 no-op（Service 基类注册服务用）
  gateway = new HotplugGateway({ reflect: { provide: () => {} } })
  savedFetch = globalThis.fetch
})
afterEach(() => {
  globalThis.fetch = savedFetch
  if (restoreEnv) restoreEnv()
  if (iso) iso.cleanup()
})

function pathPack() {
  const src = join(iso.dshHome, 'src', 'pkg-p')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }))
  return {
    hotpack: '1.0', id: 'pack.p', name: 'P', version: '1.0.0',
    plugins: [{ id: 'main', name: 'pkg-p', source: { type: 'path', path: src }, config: {} }],
  }
}

describe('HotplugGateway 实例', () => {
  it('status()：空状态', () => {
    const s = gateway.status()
    expect(s.activePack).toBeNull()
    expect(s.packs).toEqual([])
  })

  it('importPack()：非法 → 归一化失败 {code,message,exitCode}', () => {
    const r = gateway.importPack('{bad')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('ERR_HOTPLUG_FAILED')
    expect(typeof r.message).toBe('string')
    expect(r.exitCode).toBe(1)
  })

  it('importPack() → preview() → activate() → deactivate() 全链路（path 源，零 spawn）', async () => {
    const imp = gateway.importPack(JSON.stringify(pathPack()))
    expect(imp.ok).toBe(true)

    const prev = await gateway.preview('pack.p')
    expect(prev.ok).toBe(true)
    expect(prev.refs[0].action).toBe('reused')

    const act = await gateway.activate('pack.p')
    expect(act.ok).toBe(true)
    expect(act.restartNeeded).toBe(true)
    expect(readState().activePack).toBe('pack.p')
    // 重复激活 → already
    const again = await gateway.activate('pack.p')
    expect(again.already).toBe(true)

    const deact = await gateway.deactivate()
    expect(deact.ok).toBe(true)
    expect(readState().activePack).toBeNull()
    // 再 deactivate → 失败（归一化）
    const deact2 = await gateway.deactivate()
    expect(deact2.ok).toBe(false)
    expect(deact2.message).toContain('没有激活')
  })

  it('activate 不存在的包 → 归一化失败', async () => {
    const r = await gateway.activate('nope')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('ERR_HOTPLUG_FAILED')
  })

  it('removePack：激活中拒绝 / 不存在拒绝 / 正常移除', async () => {
    gateway.importPack(JSON.stringify(pathPack()))
    await gateway.activate('pack.p')
    const r1 = await gateway.removePack('pack.p')
    expect(r1.ok).toBe(false)
    expect(r1.message).toContain('激活中')
    await gateway.deactivate()
    const r2 = await gateway.removePack('ghost')
    expect(r2.ok).toBe(false)
    const r3 = await gateway.removePack('pack.p')
    expect(r3.ok).toBe(true)
  })

  it('activate：前一包 manifest 缺失仍移除旧 patch 块（审计修复：无孤儿块）', async () => {
    // 构造两个 path 源包并先后激活；随后删除 A 的 manifest，再激活 B
    const packA = pathPack() // id pack.p
    const packB = { ...pathPack(), id: 'pack.q', name: 'Q', plugins: [{ id: 'main', name: 'pkg-p', source: { type: 'path', path: packA.plugins[0].source.path }, config: {} }] }
    gateway.importPack(JSON.stringify(packA))
    await gateway.activate('pack.p')
    const patchFile = join(iso.profile, 'cordis.patch.yml')
    expect(readFileSync(patchFile, 'utf8')).toContain('hotplug:pack.p')
    // 删除 A 的 manifest（模拟状态引用已删包）
    rmSync(join(iso.dshHome, 'hotplug-hub', 'packs', 'pack.p'), { recursive: true, force: true })
    // 导入并激活 B：旧 patch 块应被移除，不残留 hotplug:pack.p
    gateway.importPack(JSON.stringify(packB))
    const act = await gateway.activate('pack.q')
    expect(act.ok).toBe(true)
    const patchText = readFileSync(patchFile, 'utf8')
    expect(patchText).not.toContain('hotplug:pack.p')
    expect(patchText).toContain('hotplug:pack.q')
  })

  it('check()：自检（pnpm 缺失不崩）', async () => {
    const r = await gateway.check()
    expect(r.pnpmVersion).toBeNull()
    expect(r.manifestOk).toBe(true)
  })

  it('marketList()：fetch 桩全链路 + 失败归一化', async () => {
    const searchPayload = JSON.stringify({
      total_count: 1,
      items: [{ full_name: 'o/r', default_branch: 'main', name: 'r', owner: { login: 'o' }, stargazers_count: 1, forks: 0, license: null, description: 'd', topics: [], updated_at: '', fork: false }],
    })
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('search/repositories')) return { ok: true, status: 200, text: async () => searchPayload }
      if (u.includes('repos/o/r')) return { ok: true, status: 200, text: async () => '{}' }
      if (u.includes('package.json')) return { ok: true, status: 200, text: async () => '{"name":"pkg-r","version":"1.0.0"}' }
      return { ok: false, status: 404, text: async () => '' }
    }
    const r = await gateway.marketList({ topic: 'dsh-plugin', sources: ['github'] })
    expect(r.ok).toBe(true)
    expect(r.entries).toHaveLength(1)
    // 非法参数 → 归一化失败
    const bad = await gateway.marketList({ topic: 'x'.repeat(40) })
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe('ERR_HOTPLUG_FAILED')
    expect(bad.message).toContain('topic')
  })

  it('serialize：变更操作串行化（promise 链不并发）', async () => {
    const order = []
    const task1 = gateway.serialize(async () => { order.push('a'); await new Promise((r) => setTimeout(r, 50)); order.push('b') })
    const task2 = gateway.serialize(async () => { order.push('c') })
    await Promise.all([task1, task2])
    expect(order).toEqual(['a', 'b', 'c'])
  })
})
