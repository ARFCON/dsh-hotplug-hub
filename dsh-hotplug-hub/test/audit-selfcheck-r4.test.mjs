// test/audit-selfcheck-r4.test.mjs — 第四轮自检深度审计（check()/statusSync() 及冲突矩阵正确性）
//
// 覆盖 9 大疑点，逐条用真实测试证伪/证实。命名规则：每条测试注释标注「证实/证伪/需确认」，
// 证伪即当前实现与契约不符（测试预期=正确契约 → 失败=缺陷落点）。
//
// 疑点 1：冲突矩阵（pluginFingerprint/seenPlugins/conflictReason/refOf 对 scoped 名的可靠性）
// 疑点 2：checkAsync 单次快照一致性（stateOk/activePack 同源，不二次 readState）
// 疑点 3：statusSync activePatchOk 三态（true/false/null 在四态下）
// 疑点 4：memorySummarySync 边界（junction/symlink/缺失/伪包/文件占位）
// 疑点 5：readState/loadPackManifest 三态（损坏/非对象/数组/PACK_ID_RE/缺失）
// 疑点 6：ensure 复用判定单一真源 + storeDirOf 单段 + legacyStoreDirOf 仅迁移
// 疑点 7：paths 语义（DSH_HOTPLUG_ROOT 优先 / DSH_PROFILE 显式遵守 / headless 回退）
// 疑点 8：gateway normalizeRpc（成功补 OK/0；失败 code/exitCode 兜底；错误码透传）
// 疑点 9：冲突矩阵全比对（非传递不漏报；同指纹多包不误报）
//
// 隔离 DSH_HOME，零真实 ~/.dsh 写入，零网络。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import {
  mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync,
} from 'node:fs'
import {
  statusSync, checkAsync, importPackSync, previewPack,
} from '../lib/core/status.js'
import {
  readState, writeState, readJson, loadPackManifest, listPackIds,
} from '../lib/core/state.js'
import {
  isEntryCached, storeDirOf, legacyStoreDirOf, storeKeySegment, isNpmCached, npmModuleDir, innerPackageName,
} from '../lib/core/ensure.js'
import { HotplugGateway, normalizeRpc, RPC_ERROR_CODE } from '../lib/gateway.js'
import {
  homeDir, profileName, profileDir, packsDir, storeRoot, statePath, memoryDir, hotplugRoot,
} from '../lib/core/paths.js'
import { applyIsolatedEnv, isolatedDsh, samplePack } from './helpers.mjs'

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

/** github 源插件包（导入零网络——仅校验；store/isEntryCached 全离线）。 */
function githubPack(id, name, repo, ref = 'main', overrides = {}) {
  return samplePack({
    id,
    plugins: [{ id: 'main', name, source: { type: 'github', repo, ref }, config: {} }],
    ...overrides,
  })
}

/** 直接在磁盘写 packs/<id>/hotpack.json（绕过 importPack，模拟篡改/手改）。 */
function tamper(packId, textOrObj) {
  const dir = join(packsDir(), packId)
  mkdirSync(dir, { recursive: true })
  const text = typeof textOrObj === 'string' ? textOrObj : JSON.stringify(textOrObj, null, 2)
  writeFileSync(join(dir, 'hotpack.json'), text)
}

// ============================================================
// 疑点 1：冲突矩阵（指纹/去重/reason/scoped 名 refOf）
// ============================================================
describe('疑点1：冲突矩阵指纹/去重/reason/scoped 名', () => {
  it('证实：github 同名 scoped 名（@scope/pkg）同 repo 异 ref → 冲突，refOf 不被 @scope 的 @ 干扰', async () => {
    importPackSync(JSON.stringify(githubPack('pack.a', '@scope/pkg', 'o/r', 'main')))
    importPackSync(JSON.stringify(githubPack('pack.b', '@scope/pkg', 'o/r', 'v2')))
    const r = await checkAsync()
    expect(r.conflicts).toHaveLength(1)
    // refOf 用 lastIndexOf('@')：store 键 o%2Fr#@scope%2Fpkg@ref，末个 @ 是 ref 分隔符
    expect(r.conflicts[0].reason).toBe('@scope/pkg github 引用冲突 main vs v2')
  })

  it('证实：github scoped 名同 repo 同 ref → 同指纹不误报', async () => {
    importPackSync(JSON.stringify(githubPack('pack.a', '@scope/pkg', 'o/r', 'main')))
    importPackSync(JSON.stringify(githubPack('pack.b', '@scope/pkg', 'o/r', 'main')))
    const r = await checkAsync()
    expect(r.conflicts).toEqual([])
  })

  it('证实：github 同名同 ref 异 repo →「仓库冲突」；同 repo 异 ref →「引用冲突」（区分正确）', async () => {
    importPackSync(JSON.stringify(githubPack('pack.a', 'pkg-x', 'alice/foo', 'main')))
    importPackSync(JSON.stringify(githubPack('pack.b', 'pkg-x', 'bob/bar', 'main')))
    importPackSync(JSON.stringify(githubPack('pack.c', 'pkg-x', 'alice/foo', 'v2')))
    const r = await checkAsync()
    const by = (packId) => r.conflicts.filter((c) => c.packId === packId)
    // pack.b vs pack.a：repo 不同 → 仓库冲突（prev=alice/foo，current=bob/bar）
    expect(by('pack.b')[0].reason).toBe('pkg-x github 仓库冲突 alice/foo vs bob/bar')
    // pack.c vs pack.a：同 repo 异 ref → 引用冲突；pack.c vs pack.b：repo 不同 → 仓库冲突
    //（prev=pack.b 的 bob/bar，current=pack.c 的 alice/foo → 顺序为 bob/bar vs alice/foo）
    expect(by('pack.c').map((c) => c.reason)).toContain('pkg-x github 引用冲突 main vs v2')
    expect(by('pack.c').map((c) => c.reason)).toContain('pkg-x github 仓库冲突 bob/bar vs alice/foo')
  })

  it('证实：异名同版本 → 不同插件名不比对、不误报', async () => {
    importPackSync(JSON.stringify(samplePack({ id: 'pack.a', plugins: [{ id: 'x', name: 'pkg-foo', source: { type: 'npm' }, version: '1.0.0', config: {} }] })))
    importPackSync(JSON.stringify(samplePack({ id: 'pack.b', plugins: [{ id: 'y', name: 'pkg-bar', source: { type: 'npm' }, version: '1.0.0', config: {} }] })))
    const r = await checkAsync()
    expect(r.conflicts).toEqual([])
  })

  it('证实：path vs github 同名 →「源类型冲突 path vs github」（插入顺序决定左右）', async () => {
    const src = join(iso.dshHome, 'src', 'pkg-x')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-x', version: '1.0.0' }))
    importPackSync(JSON.stringify(samplePack({ id: 'pack.a', plugins: [{ id: 'p', name: 'pkg-x', source: { type: 'path', path: src }, config: {} }] })))
    importPackSync(JSON.stringify(githubPack('pack.b', 'pkg-x', 'o/r', 'main')))
    const r = await checkAsync()
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0].reason).toBe('pkg-x 源类型冲突 path vs github')
  })

  it('证实（附带 cosmetic 观察）：github ref 含 / 时冲突仍被检出，reason 展示 %2F 编码形式', async () => {
    importPackSync(JSON.stringify(githubPack('pack.a', 'pkg-x', 'o/r', 'feature/x')))
    importPackSync(JSON.stringify(githubPack('pack.b', 'pkg-x', 'o/r', 'main')))
    const r = await checkAsync()
    // 正确性：不同 ref（含 /）指纹不同 → 必报冲突
    expect(r.conflicts).toHaveLength(1)
    // 观察：refOf 从 store 路径提取的是 %2F 编码后的 ref（feature%2Fx），非原始 feature/x
    expect(r.conflicts[0].reason).toContain('feature%2Fx')
  })
})

// ============================================================
// 疑点 2：checkAsync 单次快照一致性
// ============================================================
describe('疑点2：checkAsync 单次快照一致性', () => {
  it('证实：state.json 损坏时 checkAsync 各字段同源（stateOk=false/activePack=null/patchOk=null，packCount 仍来自磁盘 packs）', async () => {
    // 磁盘有一个合法包；state.json 损坏
    importPackSync(JSON.stringify(samplePack({ id: 'pack.a' })))
    mkdirSync(join(iso.dshHome, 'hotplug-hub'), { recursive: true })
    writeFileSync(statePath(), '{ "activePack": "pack.a", "hist')
    const r = await checkAsync()
    // 三字段全部来自同一次 statusSync 快照：损坏态不信任 activePack、不误报 patchOk
    expect(r.stateOk).toBe(false)
    expect(r.activePack).toBeNull()
    expect(r.patchOk).toBeNull()
    // packCount 仍反映磁盘合法包（与 stateOk 来自同一 statusSync，无二次 readState 撕裂）
    expect(r.packCount).toBe(1)
  })

  it('证实：正常态下 activePack/patchOk/packCount 与 statusSync 同源一致', async () => {
    const src = join(iso.dshHome, 'src', 'pkg-p')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }))
    importPackSync(JSON.stringify(samplePack({
      id: 'pack.a',
      plugins: [{ id: 'p', name: 'pkg-p', source: { type: 'path', path: src }, config: {} }],
    })))
    writeState({ ...readState(), activePack: 'pack.a' })
    writeFileSync(join(profileDir(), 'cordis.patch.yml'), '## hotplug:pack.a\n- insert: []\n')
    const s = statusSync()
    const r = await checkAsync()
    expect(r.stateOk).toBe(true)
    expect(r.activePack).toBe('pack.a')
    expect(r.patchOk).toBe(true)
    expect(r.packCount).toBe(1)
    // 与 statusSync 同一来源，逐字段对齐
    expect(r.activePack).toBe(s.activePack)
    expect(r.patchOk).toBe(s.activePatchOk)
    expect(r.packCount).toBe(s.packs.length)
  })
})

// ============================================================
// 疑点 3：activePatchOk 三态
// ============================================================
describe('疑点3：statusSync activePatchOk 三态', () => {
  function seedActivePackWithPatch(patchText) {
    const src = join(iso.dshHome, 'src', 'pkg-p')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }))
    importPackSync(JSON.stringify(samplePack({
      id: 'pack.a',
      plugins: [{ id: 'p', name: 'pkg-p', source: { type: 'path', path: src }, config: {} }],
    })))
    writeState({ ...readState(), activePack: 'pack.a' })
    if (patchText !== undefined) writeFileSync(join(profileDir(), 'cordis.patch.yml'), patchText)
  }

  it('证实：无激活包 → true（没有需要检查的块）', () => {
    const src = join(iso.dshHome, 'src', 'pkg-p')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }))
    importPackSync(JSON.stringify(samplePack({ id: 'pack.a', plugins: [{ id: 'p', name: 'pkg-p', source: { type: 'path', path: src }, config: {} }] })))
    expect(statusSync().activePatchOk).toBe(true)
  })

  it('证实：激活包 + 块存在 → true', () => {
    seedActivePackWithPatch('## hotplug:pack.a\n- insert: []\n')
    expect(statusSync().activePatchOk).toBe(true)
  })

  it('证实：激活包 + patch 可读但块缺失 → false（真缺失，区别于未知）', () => {
    seedActivePackWithPatch('## desktop:other\n- insert: []\n')
    expect(statusSync().activePatchOk).toBe(false)
  })

  it('证实：state 损坏 → null（未知，不信任损坏数据也不误报）', () => {
    seedActivePackWithPatch(undefined)
    mkdirSync(join(iso.dshHome, 'hotplug-hub'), { recursive: true })
    writeFileSync(statePath(), '{ "activePack": "pack.a", "hist')
    expect(statusSync().activePatchOk).toBeNull()
  })

  it('证实：激活包 + patch 不可读（目录占位）→ null（未知）', () => {
    seedActivePackWithPatch(undefined)
    mkdirSync(join(profileDir(), 'cordis.patch.yml'), { recursive: true })
    expect(statusSync().activePatchOk).toBeNull()
  })

  it('需确认：无激活包 + patch 不可读（目录占位）→ 当前实现返回 true（未暴露「文件不可读」这一健康问题）', () => {
    // 仅导入包、不激活；patch 路径被目录占位（不可读）
    const src = join(iso.dshHome, 'src', 'pkg-p')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }))
    importPackSync(JSON.stringify(samplePack({ id: 'pack.a', plugins: [{ id: 'p', name: 'pkg-p', source: { type: 'path', path: src }, config: {} }] })))
    mkdirSync(join(profileDir(), 'cordis.patch.yml'), { recursive: true })
    // 当前行为：无激活包时 patchReadable 不被消费，返回 true（自检显示「正常」）
    expect(statusSync().activePatchOk).toBe(true)
  })
})

// ============================================================
// 疑点 4：memorySummarySync 边界
// ============================================================
describe('疑点4：memorySummarySync 边界', () => {
  it('证实：symlink/junction 记忆包目录参与扫描（Windows 迁移场景不凭空消失）', () => {
    const real = join(iso.dshHome, 'real-pack')
    mkdirSync(join(real, 'entries'), { recursive: true })
    writeFileSync(join(real, 'pack.json'), JSON.stringify({ memoryPackId: 'real-pack' }))
    writeFileSync(join(real, 'entries', 'a.md'), '# a')
    const link = join(memoryDir(), 'link-pack')
    mkdirSync(memoryDir(), { recursive: true })
    try {
      symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (e) {
      console.log('SKIP symlink: ' + e.code)
      return
    }
    const s = statusSync()
    expect(s.memory.packs.find((p) => p.id === 'link-pack')).toEqual({ id: 'link-pack', entries: 1 })
    expect(s.memory.activeEntries).toBe(1)
  })

  it('证实：悬空 symlink（目标不存在）不计数、不抛异常', () => {
    mkdirSync(memoryDir(), { recursive: true })
    try {
      symlinkSync(join(iso.dshHome, 'no-such-target'), join(memoryDir(), 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (e) {
      console.log('SKIP symlink: ' + e.code)
      return
    }
    let thrown = null
    let s = null
    try { s = statusSync() } catch (e) { thrown = e }
    expect(thrown).toBeNull()
    expect(s.memory.packs).toEqual([])
  })

  it('证实：记忆目录被文件占位（ENOTDIR）→ 空摘要、不抛异常', () => {
    // memoryDir() = <dshHome>/memory-hub；isolatedDsh 未创建它，此处写成文件
    writeFileSync(memoryDir(), 'not a dir')
    let thrown = null
    let s = null
    try { s = statusSync() } catch (e) { thrown = e }
    expect(thrown).toBeNull()
    expect(s.memory.packs).toEqual([])
    expect(s.memory.activeEntries).toBe(0)
  })

  it('证实：pack.json 为目录的伪包 + entries 下 *.md 子目录均不计数（回归叠加）', () => {
    // pack.json 为目录
    const fake = join(memoryDir(), 'mem.fake')
    mkdirSync(join(fake, 'pack.json'), { recursive: true })
    // entries 下 sub.md 是目录、a.md 是文件
    const real = join(memoryDir(), 'mem.a')
    mkdirSync(join(real, 'entries', 'sub.md'), { recursive: true })
    writeFileSync(join(real, 'pack.json'), JSON.stringify({ id: 'mem.a' }))
    writeFileSync(join(real, 'entries', 'a.md'), '# a')
    const s = statusSync()
    expect(s.memory.packs.find((p) => p.id === 'mem.fake')).toBeUndefined()
    expect(s.memory.packs.find((p) => p.id === 'mem.a').entries).toBe(1)
  })
})

// ============================================================
// 疑点 5：readState/loadPackManifest 三态
// ============================================================
describe('疑点5：readState/loadPackManifest 三态', () => {
  it('证实：readState 三态——缺失默认/损坏 corrupted/数组 corrupted/非对象 corrupted', () => {
    // 缺失
    expect(readState().activePack).toBeNull()
    expect(readState().corrupted).toBeUndefined()
    mkdirSync(join(iso.dshHome, 'hotplug-hub'), { recursive: true })
    // 损坏 JSON
    writeFileSync(statePath(), '{ broken')
    expect(readState().corrupted).toBe(true)
    // 合法 JSON 数组
    writeFileSync(statePath(), '[1,2,3]')
    expect(readState().corrupted).toBe(true)
    // 合法 JSON 非对象（数字）
    writeFileSync(statePath(), '42')
    expect(readState().corrupted).toBe(true)
    // 合法 JSON 字符串
    writeFileSync(statePath(), '"str"')
    expect(readState().corrupted).toBe(true)
  })

  it('证实：loadPackManifest 三态——缺失/损坏 JSON/数组/非法 packId/合法 ok', () => {
    // 缺失文件
    expect(loadPackManifest('pack.none').status).toBe('missing')
    // 非法 packId（PACK_ID_RE 不匹配）
    expect(loadPackManifest('../x').status).toBe('missing')
    expect(loadPackManifest('').status).toBe('missing')
    expect(loadPackManifest(null).status).toBe('missing')
    // 损坏 JSON → invalid（code 为 ERR_ASSEMBLY_INVALID_JSON）
    tamper('pack.badjson', '{ not json')
    const bad = loadPackManifest('pack.badjson')
    expect(bad.status).toBe('invalid')
    expect(bad.code).toBe('ERR_ASSEMBLY_INVALID_JSON')
    // 合法 JSON 数组 → invalid（parseHotpack 拒绝非对象）
    tamper('pack.arr', '[1,2,3]')
    expect(loadPackManifest('pack.arr').status).toBe('invalid')
    // 合法 JSON 非对象（数字）
    tamper('pack.num', '5')
    expect(loadPackManifest('pack.num').status).toBe('invalid')
    // 合法 manifest → ok
    importPackSync(JSON.stringify(samplePack({ id: 'pack.ok' })))
    expect(loadPackManifest('pack.ok').status).toBe('ok')
  })

  it('证实：listPackIds 过滤 PACK_ID_RE（非法目录名/文件不列出）', () => {
    mkdirSync(join(packsDir(), 'pack.ok'), { recursive: true })
    mkdirSync(join(packsDir(), '_bad'), { recursive: true }) // 前导下划线非法
    mkdirSync(join(packsDir(), 'bad name'), { recursive: true }) // 空格非法
    writeFileSync(join(packsDir(), 'pack.file'), 'x') // 非目录
    expect(listPackIds()).toEqual(['pack.ok'])
  })

  it('需确认：readState 对「字段类型错误」的对象（activePack:123 非字符串）不标记 corrupted', () => {
    mkdirSync(join(iso.dshHome, 'hotplug-hub'), { recursive: true })
    writeFileSync(statePath(), JSON.stringify({ version: 1, activePack: 123, history: [] }))
    const s = readState()
    // 当前行为：对象形状即视为合法，字段类型错误不触发 corrupted 标记
    expect(s.corrupted).toBeUndefined()
    expect(s.activePack).toBe(123)
    // 后果观察：statusSync 会把数字 activePack 透出（active 比较恒 false）
    expect(statusSync().activePack).toBe(123)
  })
})

// ============================================================
// 疑点 6：ensure 复用判定单一真源 + storeDirOf 单段
// ============================================================
describe('疑点6：ensure 复用判定单一真源 / storeDirOf 单段 / legacy 仅迁移', () => {
  it('证实：isNpmCached 与 isEntryCached(npm) 同一真源（版本+内部包名双校验，串包 false）', () => {
    const name = 'pkg-a'
    const version = '1.0.0'
    const dir = npmModuleDir(name)
    mkdirSync(dir, { recursive: true })
    // 版本正确但内部包名不符 → 双校验 false
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'evil', version }))
    expect(isNpmCached(name, version)).toBe(false)
    expect(isEntryCached({ name, version, source: { type: 'npm' } })).toBe(false)
    // 版本+包名均符 → true
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
    expect(isNpmCached(name, version)).toBe(true)
    expect(isEntryCached({ name, version, source: { type: 'npm' } })).toBe(true)
  })

  it('证实：github/path 的 isEntryCached 与 ensure* reused 同一判定（存在 + 内部包名一致）', () => {
    // github：storeDirOf 落地目录 package.json 内部名一致 → cached
    const gh = { name: 'pkg-g', source: { type: 'github', repo: 'o/r', ref: 'v1' } }
    const ghDir = storeDirOf(gh)
    mkdirSync(ghDir, { recursive: true })
    writeFileSync(join(ghDir, 'package.json'), JSON.stringify({ name: 'pkg-g', version: '1.0.0' }))
    expect(isEntryCached(gh)).toBe(true)
    expect(innerPackageName(ghDir)).toBe('pkg-g')
    // 内部名不符 → false（与 ensureGithub 的 reused 判定零漂移）
    writeFileSync(join(ghDir, 'package.json'), JSON.stringify({ name: 'other' }))
    expect(isEntryCached(gh)).toBe(false)

    // path：与 ensurePath 同一判定
    const src = join(iso.dshHome, 'src', 'pkg-p')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }))
    const pathEntry = { name: 'pkg-p', source: { type: 'path', path: src } }
    expect(isEntryCached(pathEntry)).toBe(true)
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'not-pkg-p' }))
    expect(isEntryCached(pathEntry)).toBe(false)
  })

  it('证实：storeDirOf 对 scoped 名 + 含 / 的 ref 单段编码，无父子目录覆盖', () => {
    const d = storeDirOf({ name: '@scope/pkg', source: { type: 'github', repo: 'o/r', ref: 'feature/x' } })
    expect(d).toBe(join(storeRoot(), 'o%2Fr#@scope%2Fpkg@feature%2Fx'))
    // 末段不含路径分隔符（真正单段）
    expect(d.split(/[\\/]/).pop()).toBe('o%2Fr#@scope%2Fpkg@feature%2Fx')
    // feature 与 feature/x 无父子关系（rmSync 一个不误删另一个）
    const a = storeDirOf({ name: 'pkg', source: { type: 'github', repo: 'o/r', ref: 'feature' } })
    const b = storeDirOf({ name: 'pkg', source: { type: 'github', repo: 'o/r', ref: 'feature/x' } })
    expect(b.startsWith(a + '/') || b.startsWith(a + '\\')).toBe(false)
  })

  it('证实：legacyStoreDirOf 与新键不同、不再作为缓存目标（仅 ensureGithub 迁移清理用）', () => {
    const entry = { name: 'pkg-x', source: { type: 'github', repo: 'o/r', ref: 'main' } }
    expect(storeDirOf(entry)).toBe(join(storeRoot(), 'o%2Fr#pkg-x@main'))
    expect(legacyStoreDirOf(entry)).toBe(join(storeRoot(), 'pkg-x@main'))
    expect(storeDirOf(entry)).not.toBe(legacyStoreDirOf(entry))
  })

  it('证实：storeKeySegment 空/缺省→空串；合法输入不碰撞（% 不在合法字符集，含 % 的非法输入不保证无碰撞）', () => {
    expect(storeKeySegment('a/b')).toBe('a%2Fb')
    // % 不在 name/ref 合法字符集（validateSourceRef/repo 拒绝），故合法输入间无碰撞；
    // 含 % 的非法输入（如 'a%2Fb'）会与 'a/b' 同编码，但该输入在到达此处前已被校验层拒绝。
    expect(storeKeySegment('a/b')).not.toBe(storeKeySegment('ab'))
    expect(storeKeySegment('feature/x')).toBe('feature%2Fx')
    expect(storeKeySegment('')).toBe('')
    expect(storeKeySegment(null)).toBe('')
  })
})

// ============================================================
// 疑点 7：paths 语义
// ============================================================
describe('疑点7：paths 语义（DSH_HOTPLUG_ROOT / DSH_PROFILE / headless 回退）', () => {
  it('证实：DSH_HOTPLUG_ROOT 优先于 DSH_HOME（dshRoot = <root>/.dsh）', () => {
    const prev = process.env.DSH_HOTPLUG_ROOT
    const rootA = join(iso.dshHome, 'hotplug-root')
    process.env.DSH_HOTPLUG_ROOT = rootA
    try {
      // DSH_HOME 已被 applyIsolatedEnv 设为 iso.dshHome；DSH_HOTPLUG_ROOT 应覆盖之
      expect(homeDir()).toBe(join(rootA, '.dsh'))
      expect(hotplugRoot()).toBe(join(rootA, '.dsh', 'hotplug-hub'))
      expect(packsDir()).toBe(join(rootA, '.dsh', 'hotplug-hub', 'packs'))
    } finally {
      if (prev === undefined) delete process.env.DSH_HOTPLUG_ROOT
      else process.env.DSH_HOTPLUG_ROOT = prev
    }
  })

  it('证实：DSH_PROFILE 显式指定（即使不存在）无条件遵守，不回退 desktop/web/headless', () => {
    // 先造一个存在的默认 profile（desktop），若回退则命中它
    mkdirSync(join(iso.dshHome, 'profiles', 'desktop'), { recursive: true })
    writeFileSync(join(iso.dshHome, 'profiles', 'desktop', 'package.json'), '{}')
    process.env.DSH_PROFILE = 'ghost'
    expect(profileName()).toBe('ghost')
    expect(profileDir()).toBe(join(iso.dshHome, 'profiles', 'ghost'))
  })

  it('证实：未指定 DSH_PROFILE 时 desktop→web→headless 取第一个存在（含 headless 兜底）', () => {
    delete process.env.DSH_PROFILE
    // isolatedDsh 默认创建 web profile，先移除才能验证 headless 兜底
    rmSync(join(iso.dshHome, 'profiles', 'web'), { recursive: true, force: true })
    // 仅 headless 存在（desktop/web 均无）→ headless
    mkdirSync(join(iso.dshHome, 'profiles', 'headless'), { recursive: true })
    writeFileSync(join(iso.dshHome, 'profiles', 'headless', 'package.json'), '{}')
    expect(profileName()).toBe('headless')
  })

  it('需确认：DSH_PROFILE 为空串/纯空白 → 视为未指定，走回退（不遵守「显式但空」）', () => {
    mkdirSync(join(iso.dshHome, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(iso.dshHome, 'profiles', 'web', 'package.json'), '{}')
    process.env.DSH_PROFILE = '   '
    expect(profileName()).toBe('web')
  })
})

// ============================================================
// 疑点 8：gateway normalizeRpc（错误码透传）
// ============================================================
describe('疑点8：normalizeRpc 归一化与 CLI 域错误码透传', () => {
  it('证实：成功补 code:OK/exitCode:0；已带 code 保留', () => {
    expect(normalizeRpc({ ok: true, data: 1 })).toMatchObject({ code: 'OK', exitCode: 0, data: 1 })
    expect(normalizeRpc({ ok: true, code: 'OK', exitCode: 0 }).code).toBe('OK')
  })

  it('证实：失败 code 由 result.code 兜底 RPC_ERROR_CODE；exitCode 由 exitCodeForCode 推导', () => {
    expect(normalizeRpc({ ok: false, error: 'x' }).code).toBe(RPC_ERROR_CODE)
    expect(normalizeRpc({ ok: false, error: 'x' }).exitCode).toBe(1)
    expect(normalizeRpc({ ok: false, code: 'ERR_ASSEMBLY_FIELD', error: 'x' }).exitCode).toBe(3)
    expect(normalizeRpc({ ok: false, code: '', error: 'x' }).code).toBe(RPC_ERROR_CODE)
    expect(normalizeRpc({ ok: false, message: 'm', error: '旧' }).message).toBe('m')
  })

  it('证伪（缺陷 A）：gateway.importPack 非法 JSON 丢失 CLI 域错误码——exitCode 应为 3 实为 1', async () => {
    const gateway = new HotplugGateway({ reflect: { provide: () => {} } })
    const r = await gateway.importPack('{bad')
    expect(r.ok).toBe(false)
    // 契约：parseHotpack 已产出 code=ERR_ASSEMBLY_INVALID_JSON（应 exit 3）；
    // 但 importPackSync 只透传 error 丢弃 code → normalizeRpc 兜底 ERR_HOTPLUG_FAILED/exit 1
    expect(r.code).toBe('ERR_ASSEMBLY_INVALID_JSON')
  })

  it('证伪（缺陷 A）：gateway.preview 无效清单丢失 CLI 域错误码', async () => {
    const gateway = new HotplugGateway({ reflect: { provide: () => {} } })
    tamper('pack.bad', '{ not json')
    const r = await gateway.preview('pack.bad')
    expect(r.ok).toBe(false)
    // loadPackManifest 产出 code=ERR_ASSEMBLY_INVALID_JSON，previewPack 丢弃之
    expect(r.code).toBe('ERR_ASSEMBLY_INVALID_JSON')
  })

  it('证伪（缺陷 A）：gateway.activate 无效清单丢失 CLI 域错误码', async () => {
    const gateway = new HotplugGateway({ reflect: { provide: () => {} } })
    tamper('pack.bad', '{ not json')
    const r = await gateway.activate('pack.bad')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('ERR_ASSEMBLY_INVALID_JSON')
  })
})

// ============================================================
// 疑点 9：冲突矩阵全比对（非传递不漏报；同指纹不误报）
// ============================================================
describe('疑点9：冲突矩阵全比对', () => {
  it('证实：A(v1)/B(v2)/C(v3)/D(v1) 四包——每个「指纹互异对」都报冲突，D 与 B/C 均被点名', async () => {
    const mk = (id, v) => samplePack({ id, plugins: [{ id: 'main', name: 'pkg-foo', source: { type: 'npm' }, version: v, config: {} }] })
    for (const [id, v] of [['pack.a', '1.0.0'], ['pack.b', '2.0.0'], ['pack.c', '3.0.0'], ['pack.d', '1.0.0']]) {
      importPackSync(JSON.stringify(mk(id, v)))
    }
    const r = await checkAsync()
    const count = (packId) => r.conflicts.filter((c) => c.packId === packId).length
    expect(count('pack.a')).toBe(0) // 首个出现无冲突
    expect(count('pack.b')).toBe(1) // vs a
    expect(count('pack.c')).toBe(2) // vs a、vs b
    expect(count('pack.d')).toBe(2) // vs b、vs c（与 a 同指纹不报）
    expect(r.conflicts).toHaveLength(5)
  })

  it('证实：同指纹三包共存不误报（同 name+version 是同一实体）', async () => {
    const mk = (id) => samplePack({ id, plugins: [{ id: 'main', name: 'pkg-same', source: { type: 'npm' }, version: '1.0.0', config: {} }] })
    importPackSync(JSON.stringify(mk('pack.a')))
    importPackSync(JSON.stringify(mk('pack.b')))
    importPackSync(JSON.stringify(mk('pack.c')))
    const r = await checkAsync()
    expect(r.conflicts).toEqual([])
  })

  it('证实：同一插件名在 A/B/C 三包中「与全部已见指纹逐一比对」不漏非传递冲突（异源三混合）', async () => {
    // A=npm v1, B=github o/r main, C=npm v1（与 A 同指纹但与 B 互斥）
    const src = join(iso.dshHome, 'src', 'pkg-x')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-x', version: '1.0.0' }))
    importPackSync(JSON.stringify(samplePack({ id: 'pack.a', plugins: [{ id: 'm', name: 'pkg-x', source: { type: 'npm' }, version: '1.0.0', config: {} }] })))
    importPackSync(JSON.stringify(githubPack('pack.b', 'pkg-x', 'o/r', 'main')))
    importPackSync(JSON.stringify(samplePack({ id: 'pack.c', plugins: [{ id: 'm', name: 'pkg-x', source: { type: 'npm' }, version: '1.0.0', config: {} }] })))
    const r = await checkAsync()
    const by = (packId) => r.conflicts.filter((c) => c.packId === packId)
    expect(by('pack.b').length).toBe(1) // vs a（源类型冲突）
    expect(by('pack.c').length).toBe(1) // vs b（源类型冲突），与 a 同指纹不报
    expect(by('pack.a').length).toBe(0)
  })
})
