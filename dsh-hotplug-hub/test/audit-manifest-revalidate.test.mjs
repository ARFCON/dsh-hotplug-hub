// test/audit-manifest-revalidate.test.mjs — 磁盘 manifest 复验（信任边界审计）
//
// 背景：packs/<id>/hotpack.json 是磁盘上的可篡改输入。此前 readPackManifest 只做
// PACK_ID_RE + JSON.parse，激活/预演/状态路径不经过 parseHotpack 权威校验——
// 篡改的 plugin name / version / repo 直接进入 pnpm spec（经 cmd.exe 包装执行）
// 与 profile package.json，所有白名单正则（PLUGIN_NAME_RE / EXACT_VERSION_RE /
// REPO_RE / validateSourceRef）全部失效（注入面）。
// 契约：磁盘 manifest 在每个消费点（statusSync / previewPack / activate /
// deactivate）复验；无效清单拒绝消费并给出校验错误；removePack 仍可删除损坏包
// （恢复路径）；importPack 写入的合法 manifest 往返可复验。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { HotplugGateway } from '../lib/gateway.js'
import { statusSync, previewPack } from '../lib/core/status.js'
import { readState } from '../lib/core/state.js'
import { applyIsolatedEnv, isolatedDsh, samplePack } from './helpers.mjs'

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

/** 直接在磁盘写 packs/<id>/hotpack.json（绕过 importPack，模拟篡改/手改）。 */
function tamper(packId, manifest) {
  const dir = join(iso.dshHome, 'hotplug-hub', 'packs', packId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'hotpack.json'), JSON.stringify(manifest, null, 2))
}

/** 合法 path 源插件（激活零 spawn）。 */
function pathEntry(overrides = {}) {
  const src = join(iso.dshHome, 'src', 'pkg-p')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }))
  return {
    hotpack: '1.0', id: 'pack.t', name: 'T', version: '1.0.0',
    plugins: [{ id: 'main', name: 'pkg-p', source: { type: 'path', path: src }, config: {} }],
    ...overrides,
  }
}

describe('磁盘 manifest 复验（篡改拒绝）', () => {
  it('篡改：plugin name 含 cmd 元字符 → activate 拒绝（不进 pnpm/manifest）', async () => {
    const base = pathEntry()
    base.plugins[0].name = 'pkg-p&calc.exe'
    tamper('pack.t', base)
    const r = await gateway.activate('pack.t')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/校验|name|清单/)
  })

  it('篡改：npm version 非精确 semver → activate 拒绝', async () => {
    const base = pathEntry()
    base.plugins[0] = { id: 'main', name: 'pkg-n', version: '1.x || rm -rf /', source: { type: 'npm' }, config: {} }
    tamper('pack.t', base)
    const r = await gateway.activate('pack.t')
    expect(r.ok).toBe(false)
  })

  it('篡改：github repo 穿越（../../etc）→ activate 拒绝', async () => {
    const base = pathEntry()
    base.plugins[0] = { id: 'main', name: 'pkg-g', source: { type: 'github', repo: '../../etc', ref: 'main' }, config: {} }
    tamper('pack.t', base)
    const r = await gateway.activate('pack.t')
    expect(r.ok).toBe(false)
  })

  it('篡改：plugin id 重复 → activate 拒绝', async () => {
    const base = pathEntry()
    base.plugins.push({ ...base.plugins[0] })
    tamper('pack.t', base)
    const r = await gateway.activate('pack.t')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/重复|校验|清单/)
  })

  it('篡改：plugins 为空数组 → activate 拒绝', async () => {
    tamper('pack.t', { hotpack: '1.0', id: 'pack.t', name: 'T', version: '1.0.0', plugins: [] })
    const r = await gateway.activate('pack.t')
    expect(r.ok).toBe(false)
  })

  it('篡改清单不出现在 statusSync 的 packs 列表（无效即跳过，不崩溃）', () => {
    const base = pathEntry()
    base.plugins[0].name = 'pkg-p&calc.exe'
    tamper('pack.t', base)
    tamper('pack.ok', pathEntry({ id: 'pack.ok' }))
    const s = statusSync()
    const ids = s.packs.map((p) => p.id)
    expect(ids).toEqual(['pack.ok'])
  })

  it('篡改：previewPack 返回校验失败（而非按原始 JSON 预演）', async () => {
    const base = pathEntry()
    base.plugins[0].name = 'pkg-p&calc.exe'
    tamper('pack.t', base)
    const r = await previewPack('pack.t')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/校验|清单/)
  })

  it('篡改：激活中的包清单被改坏 → deactivate 走兜底移除 patch 块并清状态', async () => {
    // 先合法激活
    const r0 = await gateway.importPack(JSON.stringify(pathEntry()))
    expect(r0.ok).toBe(true)
    await gateway.activate('pack.t')
    expect(readState().activePack).toBe('pack.t')
    // 篡改激活中包的清单
    const bad = pathEntry()
    bad.plugins[0].name = 'pkg-p&calc.exe'
    tamper('pack.t', bad)
    const d = await gateway.deactivate()
    expect(d.ok).toBe(true)
    expect(readState().activePack).toBeNull()
    const patchFile = join(iso.profile, 'cordis.patch.yml')
    expect(readFileSync(patchFile, 'utf8')).not.toContain('hotplug:pack.t')
  })

  it('篡改：removePack 仍可删除损坏包（恢复路径不受复验影响）', async () => {
    const base = pathEntry()
    base.plugins[0].name = 'pkg-p&calc.exe'
    tamper('pack.t', base)
    const r = await gateway.removePack('pack.t')
    expect(r.ok).toBe(true)
    expect(statusSync().packs).toEqual([])
  })

  it('往返：importPack 写入的合法 manifest（含 memory/tags 适配）可复验激活', async () => {
    const r = await gateway.importPack(JSON.stringify(samplePack({
      id: 'pack.rt',
      plugins: [{ id: 'main', name: 'pkg-p', source: { type: 'path', path: join(iso.dshHome, 'src', 'pkg-p') }, config: {} }],
      tags: ['a'.repeat(30)],
    })))
    expect(r.ok).toBe(true)
    // 确保路径源真实存在（samplePack 的 path 是假的，这里补真）
    const src = join(iso.dshHome, 'src', 'pkg-p')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }))
    const act = await gateway.activate('pack.rt')
    expect(act.ok).toBe(true)
    const onDisk = readFileSync(join(iso.dshHome, 'hotplug-hub', 'packs', 'pack.rt', 'hotpack.json'), 'utf8')
    expect(onDisk).toContain('"keep": true')
  })

  it('往返：importPack 拒绝后再篡改磁盘 → 激活路径同样拒绝（同一权威校验）', async () => {
    const bad = samplePack({ id: 'pack.bad' })
    bad.plugins[0].version = 'not-semver'
    const imp = await gateway.importPack(JSON.stringify(bad))
    expect(imp.ok).toBe(false) // import 即拒绝，磁盘无此包
    tamper('pack.bad', bad) // 强行落盘
    const act = await gateway.activate('pack.bad')
    expect(act.ok).toBe(false) // 激活复验同样拒绝
  })

  it('篡改：半截 JSON（非 schema 级损坏）→ invalid 而非 missing（审查修复）', async () => {
    const dir = join(iso.dshHome, 'hotplug-hub', 'packs', 'pack.half')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'hotpack.json'), '{ "hotpack": "1.0", "id": "pack.half"')
    const act = await gateway.activate('pack.half')
    expect(act.ok).toBe(false)
    expect(act.message).toMatch(/不是合法 JSON|损坏|重新导入/)
    const prev = await previewPack('pack.half')
    expect(prev.ok).toBe(false)
    expect(prev.error).toMatch(/不是合法 JSON|损坏|重新导入/)
  })

  it('readPackManifest 兼容出口：校验通过返回原始 JSON（含 memory）；无效返回 null（审查修复：不再有无校验绕过）', async () => {
    const { readPackManifest } = await import('../lib/core/state.js')
    const r = await gateway.importPack(JSON.stringify(pathEntry()))
    expect(r.ok).toBe(true)
    const raw = readPackManifest('pack.t')
    expect(raw.name).toBe('T')
    expect(raw.memory).toEqual({ keep: true }) // 原始形态保留（loadPackManifest 的规范化产物会丢弃）
    // 无效清单 → null（不再是绕过校验的裸读）
    const bad = pathEntry()
    bad.plugins[0].name = 'pkg-p&calc.exe'
    tamper('pack.t', bad)
    expect(readPackManifest('pack.t')).toBeNull()
    expect(readPackManifest('no-such')).toBeNull()
  })
})
