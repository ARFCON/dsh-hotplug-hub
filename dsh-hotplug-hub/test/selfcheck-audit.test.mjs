// test/selfcheck-audit.test.mjs — 自检诊断审计复现 + 回归（statusSync / checkAsync / store 键 / 网关大小写）
//
// 每个用例对应一条审计确认的真实缺陷（修复前红、修复后绿）：
//   R1 github 源 store 键/冲突指纹不含 repo → 跨仓库同名同 ref 静默串包 + 冲突漏报
//   R2 checkAsync 缺 stateOk → state.json 损坏时自检报告"一切正常"
//   R3 cordis.patch.yml 不可读（目录/EACCES）→ statusSync 同步抛出（status/check 双瘫）
//   R4 manifestOk 放行 JSON 数组
//   R5 memorySummarySync：pack.json 为目录的伪包计数 / *.md 子目录计为条目
//   R6 冲突矩阵只与首个出现者比对 → 非传递漏报（A/B/C 三包）
//   R7 activate 大小写变体 packId 落盘非权威 id → status active 失配 / removePack 误报未找到
// 隔离 DSH_HOME，零真实 ~/.dsh 写入，零网络。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { statusSync, checkAsync, importPackSync } from '../lib/core/status.js'
import { readState, writeState } from '../lib/core/state.js'
import { storeDirOf, isEntryCached, legacyStoreDirOf } from '../lib/core/ensure.js'
import { HotplugGateway } from '../lib/gateway.js'
import { IS_WIN, memoryDir, packsDir, profileDir, statePath, storeRoot } from '../lib/core/paths.js'
import { applyIsolatedEnv, isolatedDsh, samplePack } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

/** github 源插件包（导入零网络——仅校验；store/isEntryCached 全离线）。 */
function githubPack(id, name, repo, overrides = {}) {
  return samplePack({
    id,
    plugins: [{ id: 'main', name, source: { type: 'github', repo, ref: 'main' }, config: {} }],
    ...overrides,
  })
}

/** 合法 path 源插件包（激活零网络零 pnpm）。 */
function pathPack(id, name = 'pkg-p') {
  const src = join(iso.dshHome, 'src', name)
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  return samplePack({
    id,
    plugins: [{ id: 'main', name, source: { type: 'path', path: src }, config: {} }],
  })
}

/** 在 store 里种一个「已缓存」插件目录（package.json 内部名 = name）。 */
function seedStore(dir, name) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
}

/** 写坏 state.json（半截 JSON）。 */
function corruptState() {
  mkdirSync(join(iso.dshHome, 'hotplug-hub'), { recursive: true })
  writeFileSync(statePath(), '{ "activePack": "pack.a", "hist')
}

describe('R1：github store 键与冲突指纹纳入 repo（跨仓库串包根治）', () => {
  it('storeDirOf：同名同 ref 不同 repo → 不同 store 目录（repo 进键）', () => {
    const a = storeDirOf({ name: 'pkg-x', source: { type: 'github', repo: 'alice/foo', ref: 'main' } })
    const b = storeDirOf({ name: 'pkg-x', source: { type: 'github', repo: 'bob/bar', ref: 'main' } })
    expect(a).not.toBe(b)
    // 键格式：repo#name@ref（%2F 编码保持单段），同 repo 同名同 ref 稳定
    expect(a).toBe(join(storeRoot(), 'alice%2Ffoo#pkg-x@main'))
    expect(storeDirOf({ name: 'pkg-x', source: { type: 'github', repo: 'alice/foo', ref: 'main' } })).toBe(a)
    // 含 / 的 ref 仍单段编码
    expect(storeDirOf({ name: 'pkg-x', source: { type: 'github', repo: 'alice/foo', ref: 'feature/x' } }))
      .toBe(join(storeRoot(), 'alice%2Ffoo#pkg-x@feature%2Fx'))
  })

  it('legacyStoreDirOf：旧键（无 repo）仅用于迁移清理，不再作为缓存目标', () => {
    expect(legacyStoreDirOf({ name: 'pkg-x', source: { type: 'github', ref: 'main' } }))
      .toBe(join(storeRoot(), 'pkg-x@main'))
  })

  it('isEntryCached：alice 的缓存不被 bob 的同名同 ref 声明误判复用（串包隔离）', () => {
    const aliceDir = storeDirOf({ name: 'pkg-x', source: { type: 'github', repo: 'alice/foo', ref: 'main' } })
    seedStore(aliceDir, 'pkg-x')
    expect(isEntryCached({ name: 'pkg-x', source: { type: 'github', repo: 'alice/foo', ref: 'main' } })).toBe(true)
    // bob 声明同名同 ref：目标目录不同 → 未缓存（激活时重新下载，不静默复用 alice 的产物）
    expect(isEntryCached({ name: 'pkg-x', source: { type: 'github', repo: 'bob/bar', ref: 'main' } })).toBe(false)
  })

  it('checkAsync 冲突矩阵：跨仓库同名同 ref github 插件报冲突（此前指纹相同漏报）', async () => {
    importPackSync(JSON.stringify(githubPack('pack.a', 'pkg-x', 'alice/foo')))
    importPackSync(JSON.stringify(githubPack('pack.b', 'pkg-x', 'bob/bar')))
    const r = await checkAsync()
    expect(r.conflicts.length).toBe(1)
    expect(r.conflicts[0].reason).toContain('pkg-x')
  })

  it('statusSync 透出 plugins[].repo（指纹/消费方的权威输入）', () => {
    importPackSync(JSON.stringify(githubPack('pack.repo', 'pkg-x', 'alice/foo')))
    const s = statusSync()
    const plugin = s.packs.find((p) => p.id === 'pack.repo').plugins[0]
    expect(plugin.repo).toBe('alice/foo')
  })
})

describe('R2：checkAsync 补 stateOk（state.json 损坏必须可见于自检）', () => {
  it('损坏 → checkAsync().stateOk === false（不再是 undefined）且 patchOk=未知 null', async () => {
    importPackSync(JSON.stringify(pathPack('pack.a')))
    corruptState()
    const r = await checkAsync()
    expect(r.stateOk).toBe(false)
    // 损坏态不信任任何字段：patch 状态未知（null），不误报 true/false
    expect(r.patchOk).toBeNull()
    expect(r.activePack).toBeNull()
  })

  it('完好 → stateOk === true', async () => {
    const r = await checkAsync()
    expect(r.stateOk).toBe(true)
  })

  it('statusSync 损坏态回归锚点：stateOk false + packs 仍列出（不崩）', () => {
    importPackSync(JSON.stringify(pathPack('pack.a')))
    corruptState()
    const s = statusSync()
    expect(s.stateOk).toBe(false)
    expect(s.packs.map((p) => p.id)).toEqual(['pack.a'])
  })
})

describe('R3：cordis.patch.yml 不可读（目录占位/权限）不再击穿 status/check', () => {
  it('patch 路径是目录：statusSync 不抛，activePatchOk=未知 null', () => {
    importPackSync(JSON.stringify(pathPack('pack.a')))
    writeState({ ...readState(), activePack: 'pack.a' })
    mkdirSync(join(profileDir(), 'cordis.patch.yml'), { recursive: true })
    let s = null
    let thrown = null
    try { s = statusSync() } catch (e) { thrown = e }
    expect(thrown).toBeNull()
    expect(s && s.activePatchOk).toBeNull()
  })

  it('patch 路径是目录：checkAsync 不抛，patchOk=未知 null', async () => {
    importPackSync(JSON.stringify(pathPack('pack.a')))
    writeState({ ...readState(), activePack: 'pack.a' })
    mkdirSync(join(profileDir(), 'cordis.patch.yml'), { recursive: true })
    let r = null
    let thrown = null
    try { r = await checkAsync() } catch (e) { thrown = e }
    expect(thrown).toBeNull()
    expect(r && r.patchOk).toBeNull()
  })

  it('正常可读 + 激活包无块：activePatchOk=false（真缺失，区别于未知）', () => {
    importPackSync(JSON.stringify(pathPack('pack.a')))
    writeState({ ...readState(), activePack: 'pack.a' })
    writeFileSync(join(profileDir(), 'cordis.patch.yml'), '# 其他内容\n')
    expect(statusSync().activePatchOk).toBe(false)
  })
})

describe('R4：manifestOk 拒绝 JSON 数组（与 readState 同族形状校验）', () => {
  it('profile package.json = [1,2,3] → manifestOk false', async () => {
    writeFileSync(join(profileDir(), 'package.json'), '[1,2,3]')
    const r = await checkAsync()
    expect(r.manifestOk).toBe(false)
  })

  it('正常对象 → true；缺文件 → false（回归锚点）', async () => {
    expect((await checkAsync()).manifestOk).toBe(true)
    rmSync(join(profileDir(), 'package.json'))
    expect((await checkAsync()).manifestOk).toBe(false)
  })
})

describe('R5：memorySummarySync 伪包/子目录条目', () => {
  it('pack.json 为目录的「伪记忆包」不计入 memory.packs', () => {
    const dir = join(memoryDir(), 'mem.fake')
    mkdirSync(join(dir, 'pack.json'), { recursive: true })
    const s = statusSync()
    expect(s.memory.packs.find((p) => p.id === 'mem.fake')).toBeUndefined()
  })

  it('entries 下名为 *.md 的子目录不计条目（只数 .md 文件）', () => {
    const dir = join(memoryDir(), 'mem.a')
    mkdirSync(join(dir, 'entries', 'sub.md'), { recursive: true })
    writeFileSync(join(dir, 'pack.json'), JSON.stringify({ id: 'mem.a' }))
    writeFileSync(join(dir, 'entries', 'a.md'), '# a')
    writeFileSync(join(dir, 'entries', 'b.txt'), 'x')
    const s = statusSync()
    const pack = s.memory.packs.find((p) => p.id === 'mem.a')
    expect(pack.entries).toBe(1)
    expect(s.memory.activeEntries).toBe(1)
  })
})

describe('R6：冲突矩阵全比对（非传递漏报根治）', () => {
  it('A(v1)/B(v2)/C(v1) 三包：B 与 C 都被点名（C 与 A 同指纹但与 B 互斥）', async () => {
    for (const [id, v] of [['pack.a', '1.0.0'], ['pack.b', '2.0.0'], ['pack.c', '1.0.0']]) {
      importPackSync(JSON.stringify(samplePack({
        id,
        plugins: [{ id: 'main', name: 'pkg-foo', source: { type: 'npm' }, version: v, config: {} }],
      })))
    }
    const r = await checkAsync()
    const flagged = r.conflicts.map((c) => c.packId).sort()
    expect(flagged).toEqual(['pack.b', 'pack.c'])
  })

  it('同指纹多包共存不误报（A/C 同版本是同一实体，互相不冲突）', async () => {
    importPackSync(JSON.stringify(samplePack({
      id: 'pack.a', plugins: [{ id: 'main', name: 'pkg-same', source: { type: 'npm' }, version: '1.0.0', config: {} }],
    })))
    importPackSync(JSON.stringify(samplePack({
      id: 'pack.c', plugins: [{ id: 'main', name: 'pkg-same', source: { type: 'npm' }, version: '1.0.0', config: {} }],
    })))
    const r = await checkAsync()
    expect(r.conflicts).toEqual([])
  })
})

describe('R7：packId 大小写变体（网关权威归一）', () => {
  // 大小写变体经 FS 命中清单依赖 NTFS 大小写不敏感——POSIX 上 loadPackManifest 直接
  // missing，属平台语义差异而非缺陷，仅 win32 断言归一行为。
  it.skipIf(!IS_WIN)("activate('PACK.X') 落盘权威 id pack.x（manifest 为准），status 正确标 active", async () => {
    const gateway = new HotplugGateway({ reflect: { provide: () => {} } })
    const manifest = pathPack('pack.x')
    mkdirSync(join(packsDir(), 'pack.x'), { recursive: true })
    writeFileSync(join(packsDir(), 'pack.x', 'hotpack.json'), JSON.stringify(manifest))
    const r = await gateway.activate('PACK.X')
    expect(r.ok).toBe(true)
    expect(r.packId).toBe('pack.x')
    expect(readState().activePack).toBe('pack.x')
    const s = statusSync()
    expect(s.packs.find((p) => p.id === 'pack.x').active).toBe(true)
    expect(s.activePatchOk).toBe(true)
  })

  it('重复激活（权威 id）→ already，不重挂（回归锚点）', async () => {
    const gateway = new HotplugGateway({ reflect: { provide: () => {} } })
    mkdirSync(join(packsDir(), 'pack.a'), { recursive: true })
    writeFileSync(join(packsDir(), 'pack.a', 'hotpack.json'), JSON.stringify(pathPack('pack.a')))
    const first = await gateway.activate('pack.a')
    expect(first.ok).toBe(true)
    const again = await gateway.activate('pack.a')
    expect(again.ok).toBe(true)
    expect(again.already).toBe(true)
    await gateway.deactivate()
  })

  it.skipIf(!IS_WIN)('重复激活（大小写变体，win32）→ already 判同（不再无谓卸载重挂）', async () => {
    const gateway = new HotplugGateway({ reflect: { provide: () => {} } })
    mkdirSync(join(packsDir(), 'pack.a'), { recursive: true })
    writeFileSync(join(packsDir(), 'pack.a', 'hotpack.json'), JSON.stringify(pathPack('pack.a')))
    await gateway.activate('pack.a')
    const again = await gateway.activate('PACK.A')
    expect(again.ok).toBe(true)
    expect(again.already).toBe(true)
    await gateway.deactivate()
  })

  it.skipIf(!IS_WIN)('removePack 大小写变体：激活中的包不可删（守卫与 NTFS 同语义）', async () => {
    const gateway = new HotplugGateway({ reflect: { provide: () => {} } })
    mkdirSync(join(packsDir(), 'pack.a'), { recursive: true })
    writeFileSync(join(packsDir(), 'pack.a', 'hotpack.json'), JSON.stringify(pathPack('pack.a')))
    await gateway.activate('pack.a')
    const r = await gateway.removePack('PACK.A')
    expect(r.ok).toBe(false)
    expect(String(r.error ?? r.message)).toContain('不能移除激活中的包')
    await gateway.deactivate()
  })

  it.skipIf(!IS_WIN)('历史脏 state（修复前落盘的大小写变体 activePack）→ 再次 activate 自愈为权威 id', async () => {
    const gateway = new HotplugGateway({ reflect: { provide: () => {} } })
    mkdirSync(join(packsDir(), 'pack.x'), { recursive: true })
    writeFileSync(join(packsDir(), 'pack.x', 'hotpack.json'), JSON.stringify(pathPack('pack.x')))
    await gateway.activate('pack.x')
    // 模拟修复前的脏 state：原样 packId 落盘（大小写变体）
    writeState({ ...readState(), activePack: 'PACK.X' })
    expect(statusSync().packs.find((p) => p.id === 'pack.x').active).toBe(false) // 脏态失配（复现）
    const again = await gateway.activate('PACK.X')
    expect(again.ok).toBe(true)
    expect(again.already).toBe(true)
    expect(readState().activePack).toBe('pack.x') // 已自愈为权威 id
    expect(readState().activeInstall.packId).toBe('pack.x')
    expect(statusSync().packs.find((p) => p.id === 'pack.x').active).toBe(true)
    await gateway.deactivate()
  })

  it('removePack 大小写变体：Windows 下 NTFS 大小写不敏感目录可被找到（不误报未找到）', async () => {
    const gateway = new HotplugGateway({ reflect: { provide: () => {} } })
    mkdirSync(join(packsDir(), 'pack.x'), { recursive: true })
    writeFileSync(join(packsDir(), 'pack.x', 'hotpack.json'), JSON.stringify(pathPack('pack.x')))
    const r = await gateway.removePack('PACK.X')
    if (IS_WIN) expect(r.ok).toBe(true)
    else expect(r.ok).toBe(false) // POSIX 大小写敏感：确未找到
  })
})
