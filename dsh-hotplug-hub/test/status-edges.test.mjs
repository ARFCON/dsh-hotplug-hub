// test/status-edges.test.mjs — 状态/自检边缘矩阵：store 排序 / activatedAt 反向扫描交错历史 /
// 损坏 state / 无效 manifest 跳过 / 冲突矩阵深度（源类型·版本·引用·指纹）/ manifestOk /
// pnpm 缺失 / previewPack 边缘 / importPackSync 覆盖与拒绝。隔离 DSH_HOME，零真实 ~/.dsh 写入。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { statusSync, importPackSync, previewPack, checkAsync } from '../lib/core/status.js'
import { readState, writeState, readPackManifest } from '../lib/core/state.js'
import { storeRoot, statePath, packsDir } from '../lib/core/paths.js'
import { applyIsolatedEnv, isolatedDsh, samplePack } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

/** 手写 packs/<id>/hotpack.json（绕过 importPack，模拟篡改/手改）。 */
function tamper(packId, manifest) {
  const dir = join(packsDir(), packId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'hotpack.json'), JSON.stringify(manifest, null, 2))
}

/** 合法 path 源插件（绝对路径、激活/预演零网络零 pnpm）。 */
function pathPack(id, overrides = {}) {
  const src = join(iso.dshHome, 'src', 'pkg-p')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }))
  return samplePack({
    id,
    plugins: [{ id: 'main', name: 'pkg-p', source: { type: 'path', path: src }, config: {} }],
    ...overrides,
  })
}

describe('statusSync（边缘）', () => {
  it('store.entries：种子 store 目录排序展示，非目录条目过滤', () => {
    mkdirSync(join(storeRoot(), 'zz-pkg'), { recursive: true })
    mkdirSync(join(storeRoot(), 'aa-pkg'), { recursive: true })
    writeFileSync(join(storeRoot(), 'not-a-dir.txt'), 'x')
    const s = statusSync()
    expect(s.store.entries).toEqual(['aa-pkg', 'zz-pkg'])
    expect(s.store.dir).toContain('hotplug-store')
  })

  it('activatedAt 反向扫描：多包交错历史各取「自己」最近一次 activate（非全局最后/最早）', () => {
    importPackSync(JSON.stringify(pathPack('pack.a')))
    importPackSync(JSON.stringify(pathPack('pack.b')))
    writeState({
      ...readState(),
      activePack: 'pack.b',
      history: [
        { event: 'activate', packId: 'pack.a', at: '2020-01-01T00:00:00.000Z' },
        { event: 'activate', packId: 'pack.b', at: '2021-01-01T00:00:00.000Z' },
        { event: 'deactivate', packId: 'pack.a', at: '2022-01-01T00:00:00.000Z' },
        { event: 'activate', packId: 'pack.b', at: '2023-01-01T00:00:00.000Z' },
      ],
    })
    const s = statusSync()
    const byId = Object.fromEntries(s.packs.map((p) => [p.id, p]))
    // pack.b：两次 activate，取第二次（2023），不是最早那次
    expect(byId['pack.b'].activatedAt).toBe('2023-01-01T00:00:00.000Z')
    expect(byId['pack.b'].active).toBe(true)
    // pack.a：自己的最近（也是唯一）一次 activate（2020），不被全局末尾的 pack.b 事件干扰
    expect(byId['pack.a'].activatedAt).toBe('2020-01-01T00:00:00.000Z')
    expect(byId['pack.a'].active).toBe(false)
  })

  it('stateOk：正常 true；state.json 损坏 → false 且 statusSync 不崩（activePack 读数为 null）', () => {
    importPackSync(JSON.stringify(pathPack('pack.ok')))
    expect(statusSync().stateOk).toBe(true)
    mkdirSync(join(iso.dshHome, 'hotplug-hub'), { recursive: true })
    writeFileSync(statePath(), '{ "activePack": "pack.ok", "hist')
    const s = statusSync()
    expect(s.stateOk).toBe(false)
    expect(s.activePack).toBeNull() // 不信任损坏数据
    expect(Array.isArray(s.packs)).toBe(true) // 不崩
    expect(s.packs.map((p) => p.id)).toEqual(['pack.ok'])
  })

  it('statusSync 跳过无效 manifest 的包（手写坏 hotpack.json 不进 packs 列表）', () => {
    importPackSync(JSON.stringify(pathPack('pack.good')))
    tamper('pack.bad', { hotpack: '1.0', id: 'pack.bad', name: 'B', version: '1.0.0', plugins: [] })
    const s = statusSync()
    expect(s.packs.map((p) => p.id)).toEqual(['pack.good'])
  })
})

describe('checkAsync（冲突矩阵深度）', () => {
  it('npm 同名不同版本 →「版本冲突 1.0.0 vs 2.0.0」', async () => {
    importPackSync(JSON.stringify(samplePack({ id: 'pack.n1', plugins: [{ id: 'a', name: 'pkg-x', source: { type: 'npm' }, version: '1.0.0', config: {} }] })))
    importPackSync(JSON.stringify(samplePack({ id: 'pack.n2', plugins: [{ id: 'a', name: 'pkg-x', source: { type: 'npm' }, version: '2.0.0', config: {} }] })))
    const r = await checkAsync()
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0].reason).toBe('pkg-x 版本冲突 1.0.0 vs 2.0.0')
    expect(r.conflicts[0].packId).toBe('pack.n2')
    expect(r.conflicts[0].suggest).toContain('停用')
  })

  it('github 同名不同 ref →「github 引用冲突 main vs v2」（store 路径指纹区分）', async () => {
    importPackSync(JSON.stringify(samplePack({ id: 'pack.g1', plugins: [{ id: 'a', name: 'pkg-x', source: { type: 'github', repo: 'o/r', ref: 'main' }, config: {} }] })))
    importPackSync(JSON.stringify(samplePack({ id: 'pack.g2', plugins: [{ id: 'a', name: 'pkg-x', source: { type: 'github', repo: 'o/r', ref: 'v2' }, config: {} }] })))
    const r = await checkAsync()
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0].reason).toBe('pkg-x github 引用冲突 main vs v2')
  })

  it('npm vs github 同名 →「源类型冲突 npm vs github」', async () => {
    importPackSync(JSON.stringify(samplePack({ id: 'pack.m1', plugins: [{ id: 'a', name: 'pkg-x', source: { type: 'npm' }, version: '1.0.0', config: {} }] })))
    importPackSync(JSON.stringify(samplePack({ id: 'pack.m2', plugins: [{ id: 'a', name: 'pkg-x', source: { type: 'github', repo: 'o/r', ref: 'main' }, config: {} }] })))
    const r = await checkAsync()
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0].reason).toBe('pkg-x 源类型冲突 npm vs github')
  })

  it('相同指纹（同 path 源两包 / 同 npm 名+版本两包）→ 无冲突', async () => {
    const src = join(iso.dshHome, 'src', 'pkg-s')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-s', version: '1.0.0' }))
    const shared = [{ id: 'a', name: 'pkg-s', source: { type: 'path', path: src }, config: {} }]
    importPackSync(JSON.stringify(samplePack({ id: 'pack.p1', plugins: shared })))
    importPackSync(JSON.stringify(samplePack({ id: 'pack.p2', plugins: shared })))
    importPackSync(JSON.stringify(samplePack({ id: 'pack.q1', plugins: [{ id: 'a', name: 'pkg-z', source: { type: 'npm' }, version: '1.2.3', config: {} }] })))
    importPackSync(JSON.stringify(samplePack({ id: 'pack.q2', plugins: [{ id: 'a', name: 'pkg-z', source: { type: 'npm' }, version: '1.2.3', config: {} }] })))
    const r = await checkAsync()
    expect(r.conflicts).toEqual([])
    expect(r.packCount).toBe(4)
  })

  it('manifestOk：profile package.json 被删除 → false（其余自检照常返回）', async () => {
    rmSync(join(iso.profile, 'package.json'))
    const r = await checkAsync()
    expect(r.manifestOk).toBe(false)
    expect(r.nodeVersion).toMatch(/^v/)
    expect(Array.isArray(r.conflicts)).toBe(true)
  })

  it('pnpm 缺失（PATH 隔离）→ pnpmVersion:null；storeCount/packCount 计数', async () => {
    importPackSync(JSON.stringify(pathPack('pack.cnt')))
    mkdirSync(join(storeRoot(), 's1'), { recursive: true })
    mkdirSync(join(storeRoot(), 's2'), { recursive: true })
    const r = await checkAsync()
    expect(r.pnpmVersion).toBeNull()
    expect(r.packCount).toBe(1)
    expect(r.storeCount).toBe(2)
  })
})

describe('previewPack（边缘）', () => {
  it('未找到包 → 明确错误', async () => {
    const r = await previewPack('nope')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未找到包')
  })

  it('无效 manifest（手写坏清单）→ 清单校验失败（不按原始 JSON 预演）', async () => {
    tamper('pack.t', { hotpack: '1.0', id: 'pack.t', name: 'T', version: '1.0.0', plugins: [] })
    const r = await previewPack('pack.t')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('清单校验失败')
  })

  it('wouldReplace：另一包激活时预演 → 返回该激活包 id；自激活/无激活 → null', async () => {
    importPackSync(JSON.stringify(pathPack('pack.x')))
    importPackSync(JSON.stringify(pathPack('pack.y')))
    writeState({ ...readState(), activePack: 'pack.y' })
    const r = await previewPack('pack.x')
    expect(r.ok).toBe(true)
    expect(r.wouldReplace).toBe('pack.y')
    writeState({ ...readState(), activePack: 'pack.x' })
    const self = await previewPack('pack.x')
    expect(self.wouldReplace).toBeNull()
  })

  it('npm 当前版本消息：profile 装了旧版 →「将替换为」；精确匹配且内部包名一致 → reused', async () => {
    const modDir = join(iso.profile, 'node_modules', 'pkg-a')
    mkdirSync(modDir, { recursive: true })
    writeFileSync(join(modDir, 'package.json'), JSON.stringify({ name: 'pkg-a', version: '0.9.0' }))
    importPackSync(JSON.stringify(samplePack({ id: 'pack.v', plugins: [{ id: 'a', name: 'pkg-a', source: { type: 'npm' }, version: '1.0.0', config: {} }] })))
    const r = await previewPack('pack.v')
    expect(r.ok).toBe(true)
    expect(r.refs[0].action).toBe('download')
    expect(r.refs[0].detail).toContain('profile 现为 pkg-a@0.9.0')
    expect(r.refs[0].detail).toContain('将替换为 1.0.0')
    // 版本精确匹配 + 内部包名一致 → reused
    writeFileSync(join(modDir, 'package.json'), JSON.stringify({ name: 'pkg-a', version: '1.0.0' }))
    const r2 = await previewPack('pack.v')
    expect(r2.refs[0].action).toBe('reused')
    expect(r2.refs[0].detail).toContain('profile 已有 pkg-a@1.0.0')
    // 内部包名不符（串包）即使版本相同也视为未就绪（不再误报 reused）
    writeFileSync(join(modDir, 'package.json'), JSON.stringify({ name: 'evil', version: '1.0.0' }))
    const r3 = await previewPack('pack.v')
    expect(r3.refs[0].action).toBe('download')
  })
})

describe('importPackSync（覆盖与拒绝）', () => {
  it('激活中拒绝覆盖（先 deactivate）', () => {
    const r1 = importPackSync(JSON.stringify(pathPack('pack.w')))
    expect(r1.ok).toBe(true)
    writeState({ ...readState(), activePack: 'pack.w' })
    const r2 = importPackSync(JSON.stringify(pathPack('pack.w', { name: 'W2', version: '2.0.0' })))
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain('激活中')
  })

  it('未激活时覆盖导入：磁盘 manifest 更新为新版本', () => {
    importPackSync(JSON.stringify(pathPack('pack.w', { name: 'W1', version: '1.0.0' })))
    expect(readPackManifest('pack.w').name).toBe('W1')
    const r2 = importPackSync(JSON.stringify(pathPack('pack.w', { name: 'W2', version: '2.0.0' })))
    expect(r2.ok).toBe(true)
    const onDisk = readPackManifest('pack.w')
    expect(onDisk.name).toBe('W2')
    expect(onDisk.version).toBe('2.0.0')
  })

  it('state.json 损坏 → 拒绝导入（宁可拒绝也不在不可信状态上写盘）', () => {
    mkdirSync(join(iso.dshHome, 'hotplug-hub'), { recursive: true })
    writeFileSync(statePath(), '{ broken')
    const r = importPackSync(JSON.stringify(pathPack('pack.r')))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('损坏')
  })
})
