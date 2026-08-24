// test/audit-activate-switch.test.mjs — activate 切换原子性（状态与磁盘一致性审计）
//
// 背景：activate(B) 的顺序是「先卸载 A → 再挂载 B」。此前若 mountPack(B) 失败，
// 直接返回错误：A 已从磁盘卸载（patch 块/link/npm 全撤），但 state.activePack 仍
// 指向 A——状态说激活、磁盘已卸载（statusSync 会显示 activePatchOk:false 的鬼状态）。
// 契约：切换是原子的——新包挂载失败时，恢复上一包（优先）或清空激活状态（兜底），
// 任何返回路径上「state.activePack」与「磁盘 hotplug 块」一致。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { HotplugGateway } from '../lib/gateway.js'
import { readState } from '../lib/core/state.js'
import { statusSync } from '../lib/core/status.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null
let gateway = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
  gateway = new HotplugGateway({ reflect: { provide: () => {} } })
})
afterEach(() => {
  if (restoreEnv) restoreEnv()
  if (iso) iso.cleanup()
})

function pathPack(id, name) {
  const src = join(iso.dshHome, 'src', name)
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  return {
    hotpack: '1.0', id, name: id, version: '1.0.0',
    plugins: [{ id: 'main', name, source: { type: 'path', path: src }, config: {} }],
  }
}

/** npm 源包（无 pnpm 可用 → mount 必失败，用于构造切换失败场景） */
function npmPack(id, name) {
  return {
    hotpack: '1.0', id, name: id, version: '1.0.0',
    plugins: [{ id: 'main', name, version: '9.9.9', source: { type: 'npm' }, config: {} }],
  }
}

function patchText() {
  const f = join(iso.profile, 'cordis.patch.yml')
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

describe('activate 切换原子性', () => {
  it('切换失败 → 上一包被恢复（patch 块回来 + state.activePack 不变 + activeInstall 更新）', async () => {
    await gateway.importPack(JSON.stringify(pathPack('pack.a', 'pkg-a')))
    await gateway.importPack(JSON.stringify(npmPack('pack.b', 'pkg-b')))
    await gateway.activate('pack.a')
    expect(patchText()).toContain('hotplug:pack.a')

    const r = await gateway.activate('pack.b')
    expect(r.ok).toBe(false)
    // A 恢复：patch 块在、state 一致
    expect(patchText()).toContain('hotplug:pack.a')
    expect(patchText()).not.toContain('hotplug:pack.b')
    expect(readState().activePack).toBe('pack.a')
    expect(statusSync().activePatchOk).toBe(true)
    // 事件里说明发生了恢复
    expect(JSON.stringify(r.events ?? [])).toMatch(/恢复/)
  })

  it('切换失败且上一包也无法恢复（源被删）→ 清空激活状态，与磁盘一致', async () => {
    const a = pathPack('pack.a', 'pkg-a')
    await gateway.importPack(JSON.stringify(a))
    await gateway.importPack(JSON.stringify(npmPack('pack.b', 'pkg-b')))
    await gateway.activate('pack.a')
    // 删除 A 的 path 源（重挂必失败）
    rmSync(a.plugins[0].source.path, { recursive: true, force: true })

    const r = await gateway.activate('pack.b')
    expect(r.ok).toBe(false)
    expect(readState().activePack).toBeNull()
    expect(readState().activeInstall).toBeNull()
    expect(patchText()).not.toContain('hotplug:pack.a')
    expect(patchText()).not.toContain('hotplug:pack.b')
  })

  it('切换成功 → 旧块移除、新块写入、installedNpm 换成新包的（回归）', async () => {
    await gateway.importPack(JSON.stringify(pathPack('pack.a', 'pkg-a')))
    await gateway.importPack(JSON.stringify(pathPack('pack.b', 'pkg-b')))
    await gateway.activate('pack.a')
    const r = await gateway.activate('pack.b')
    expect(r.ok).toBe(true)
    expect(r.events.join(';')).toMatch(/卸载上一个包/)
    expect(patchText()).not.toContain('hotplug:pack.a')
    expect(patchText()).toContain('hotplug:pack.b')
    expect(readState().activePack).toBe('pack.b')
    expect(readState().activeInstall.packId).toBe('pack.b')
    // A 的 link: 依赖被撤、B 的就位
    const manifest = JSON.parse(readFileSync(join(iso.profile, 'package.json'), 'utf8'))
    expect(manifest.dependencies['pkg-a']).toBeUndefined()
    expect(String(manifest.dependencies['pkg-b'])).toMatch(/^link:/)
  })

  it('上一包 manifest 缺失 + 新包挂载失败 → 清空激活状态（不留鬼状态）', async () => {
    await gateway.importPack(JSON.stringify(pathPack('pack.a', 'pkg-a')))
    await gateway.importPack(JSON.stringify(npmPack('pack.b', 'pkg-b')))
    await gateway.activate('pack.a')
    rmSync(join(iso.dshHome, 'hotplug-hub', 'packs', 'pack.a'), { recursive: true, force: true })

    const r = await gateway.activate('pack.b')
    expect(r.ok).toBe(false)
    expect(readState().activePack).toBeNull()
    expect(patchText()).not.toContain('hotplug:')
  })

  it('切换失败恢复后可再次正常切换（状态机不被失败卡死）', async () => {
    await gateway.importPack(JSON.stringify(pathPack('pack.a', 'pkg-a')))
    await gateway.importPack(JSON.stringify(pathPack('pack.c', 'pkg-c')))
    await gateway.importPack(JSON.stringify(npmPack('pack.b', 'pkg-b')))
    await gateway.activate('pack.a')
    const fail = await gateway.activate('pack.b')
    expect(fail.ok).toBe(false)
    expect(readState().activePack).toBe('pack.a')
    // 修复故障（导入 path 源版本替换 npm 版本）后切换成功
    await gateway.deactivate()
    const ok = await gateway.activate('pack.c')
    expect(ok.ok).toBe(true)
    expect(readState().activePack).toBe('pack.c')
  })
})
