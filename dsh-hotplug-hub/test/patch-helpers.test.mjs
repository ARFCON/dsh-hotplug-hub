// test/patch-helpers.test.mjs — patch.js 辅助函数直测（id/marker、bundles、link、分节合并门控、npm 卸载门控）
//
// 这些导出在 patch.test.mjs 里只经 mountPack/unmountPack 间接覆盖，此处直接对单元行为钉死：
//   - patchInstanceId / patchMarker / legacyInlineMarker 的契约形状；
//   - bundlePkgNames 按 store 目录 package.json 的 dsh.bundle.patch 登记；
//   - addBundles / removeBundles 的 manifest.dsh.profile.bundles 增删、去重、无变化不写盘；
//   - linkEntryIntoProfile / unlinkEntryFromProfile 的 junction 与 link: 依赖对称性；
//   - removePatchBlock 旧内联形态手术移除与两态返回；appendPatchBlock 与异包分节块共存；
//   - unmountPack 的 npm 卸载门控（installedNpm 缺省 = 未知 → 一个都不删）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import {
  patchInstanceId, patchMarker, legacyInlineMarker,
  bundlePkgNames, addBundles, removeBundles,
  linkEntryIntoProfile, unlinkEntryFromProfile,
  appendPatchBlock, removePatchBlock, unmountPack,
} from '../lib/core/patch.js'
import { manifestPath } from '../lib/core/paths.js'
import { applyIsolatedEnv, isolatedDsh, samplePack } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

const manifestFile = () => join(iso.profile, 'package.json')
const patchFile = () => join(iso.profile, 'cordis.patch.yml')
function writeManifest(value) { writeFileSync(manifestFile(), JSON.stringify(value, null, 2)) }
function readManifest() { return JSON.parse(readFileSync(manifestFile(), 'utf8')) }
function readBundles() { return readManifest().dsh?.profile?.bundles ?? [] }

/** github 源插件条目（store 目录 = <dshHome>/hotplug-store/<repo>#<name>@<ref>）。 */
function githubEntry(name, ref = 'main') {
  return { id: name, name, source: { type: 'github', repo: `o/${name}`, ref } }
}
/** 在 store 目录落地 package.json（dshField 为 undefined 时不写 dsh 字段）。 */
function writeStorePkg(name, dshField, ref = 'main') {
  const dir = join(iso.dshHome, 'hotplug-store', `o%2F${name}#${name}@${ref}`)
  mkdirSync(dir, { recursive: true })
  const pkg = { name, version: '1.0.0' }
  if (dshField !== undefined) pkg.dsh = { bundle: { patch: dshField } }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
}

/** 构造真实 path 源插件目录，返回目录路径。 */
function makePathSource(name, version = '1.0.0') {
  const dir = join(iso.dshHome, 'plugin-src', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  return dir
}

describe('patch id / marker 契约', () => {
  it('patchInstanceId：hp- 前缀、确定性、长输入 ≤64', () => {
    expect(patchInstanceId('pack.a', 'b')).toMatch(/^hp-pack\.a-b-[0-9a-f]{8}$/)
    const once = patchInstanceId('pack.a', 'plug-1')
    expect(once.startsWith('hp-')).toBe(true)
    expect(patchInstanceId('pack.a', 'plug-1')).toBe(once) // 确定性（同输入同输出）
    expect(patchInstanceId('x'.repeat(40), 'y'.repeat(40)).length).toBeLessThanOrEqual(64)
  })

  it('patchMarker 契约 ##；legacyInlineMarker 旧单 # 形态', () => {
    expect(patchMarker('pack.a')).toBe('## hotplug:pack.a')
    expect(legacyInlineMarker('pack.a')).toBe('# hotplug:pack.a')
  })
})

describe('bundlePkgNames（store 目录 dsh.bundle.patch 登记）', () => {
  it('true 入选；无字段 / 缺 store 目录 → 排除', () => {
    writeStorePkg('pkg-yes', true)
    writeStorePkg('pkg-plain', undefined)
    const names = bundlePkgNames({ plugins: [githubEntry('pkg-yes'), githubEntry('pkg-plain'), githubEntry('pkg-missing')] })
    expect(names).toEqual(['pkg-yes'])
  })

  it('dsh.bundle.patch 显式为 false → 排除（R3 根治：显式 true 才登记，与 launcher 生态契约一致）', () => {
    // 布尔标记 false = 作者明确退出 bundle patch：不得登记（此前 !== undefined 把 false 也入选）
    writeStorePkg('pkg-false', false)
    expect(bundlePkgNames({ plugins: [githubEntry('pkg-false')] })).toEqual([])
  })

  it('卸载迁移自愈（审查修复）：旧语义登记过的显式 false 条目在卸载时被清除', async () => {
    // 模拟旧版挂载残留：显式 false 的插件被旧语义（!== undefined）登记进 bundles
    writeStorePkg('pkg-legacy', false)
    const manifest = readManifest()
    manifest.dsh = manifest.dsh ?? {}
    manifest.dsh.profile = manifest.dsh.profile ?? {}
    manifest.dsh.profile.bundles = ['pkg-legacy']
    writeManifest(manifest)
    // 卸载（unmountPack 内部走移除集 ⊇ 登记集）
    const r = await unmountPack({ id: 'pack.legacy', plugins: [githubEntry('pkg-legacy')] }, {})
    expect(r.ok).toBe(true)
    expect(readBundles()).toEqual([])
  })
})

describe('addBundles / removeBundles（manifest.dsh.profile.bundles）', () => {
  it('addBundles：登记 + 去重 + 无变化不写盘（mtime 不动，正对照为写入时 mtime 变化）', () => {
    addBundles(['pkg-a', 'pkg-b'])
    expect(readBundles()).toEqual(['pkg-a', 'pkg-b'])
    // 全部已存在 → 不写盘（mtime 不变）
    const mtimeBefore = statSync(manifestFile()).mtimeMs
    addBundles(['pkg-a', 'pkg-b'])
    expect(statSync(manifestFile()).mtimeMs).toBe(mtimeBefore)
    // 正对照：确有新增时写盘（mtime 变化，证明上面的不变确因未写而非检测失灵）
    addBundles(['pkg-c'])
    expect(statSync(manifestFile()).mtimeMs).toBeGreaterThan(mtimeBefore)
    expect(readBundles()).toEqual(['pkg-a', 'pkg-b', 'pkg-c'])
    // 重复名合并（去重）
    addBundles(['pkg-a', 'pkg-d'])
    expect(readBundles()).toEqual(['pkg-a', 'pkg-b', 'pkg-c', 'pkg-d'])
  })

  it('addBundles：manifest 缺失 → 不抛不写', () => {
    rmSync(manifestFile())
    expect(() => addBundles(['x'])).not.toThrow()
    expect(existsSync(manifestFile())).toBe(false)
  })

  it('removeBundles：只移除列出的、保留其它', () => {
    addBundles(['pkg-a', 'pkg-b', 'pkg-c'])
    removeBundles(['pkg-b'])
    expect(readBundles()).toEqual(['pkg-a', 'pkg-c'])
    removeBundles(['pkg-a', 'pkg-c'])
    expect(readBundles()).toEqual([])
  })

  it('removeBundles：容忍缺失 manifest / 缺失 bundles 字段', () => {
    rmSync(manifestFile())
    expect(() => removeBundles(['x'])).not.toThrow()
    expect(existsSync(manifestFile())).toBe(false)
    writeManifest({ name: 'web', private: true, dependencies: {} }) // 无 dsh 字段
    expect(() => removeBundles(['x'])).not.toThrow()
    expect(readManifest().dsh).toBeUndefined()
  })
})

describe('linkEntryIntoProfile / unlinkEntryFromProfile（junction 对称性）', () => {
  it('link：真实目录占用 link 路径时替换为 junction；manifest 依赖值为 link:<正斜杠路径>', () => {
    const target = makePathSource('pkg-l')
    const linkPath = join(iso.profile, 'node_modules', 'pkg-l')
    // 预置真实目录（非符号链接）占用 link 路径（残留 npm 包场景）
    mkdirSync(linkPath, { recursive: true })
    writeFileSync(join(linkPath, 'stale.txt'), 'stale')
    const r = linkEntryIntoProfile({ name: 'pkg-l', source: { type: 'path', path: target } })
    expect(r.ok).toBe(true)
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
    expect(existsSync(join(linkPath, 'stale.txt'))).toBe(false) // 旧真实目录内容被清
    expect(JSON.parse(readFileSync(join(linkPath, 'package.json'), 'utf8')).version).toBe('1.0.0')
    expect(readManifest().dependencies['pkg-l']).toBe(`link:${target.replace(/\\/g, '/')}`)
  })

  it('unlink：移除 link: 依赖与 junction；非 link 依赖与真实目录不动；无事可做返回 false', () => {
    const target = makePathSource('pkg-l')
    const linkPath = join(iso.profile, 'node_modules', 'pkg-l')
    symlinkSync(target, linkPath, 'junction')
    const manifest = { dependencies: { 'pkg-l': `link:${target.replace(/\\/g, '/')}`, other: '^1.0.0' } }
    expect(unlinkEntryFromProfile({ name: 'pkg-l' }, manifest)).toBe(true)
    expect(manifest.dependencies['pkg-l']).toBeUndefined() // link: 依赖被移除
    expect(manifest.dependencies.other).toBe('^1.0.0') // 非 link 依赖不动
    expect(existsSync(linkPath)).toBe(false) // junction 被移除
    // 无事可做 → false
    expect(unlinkEntryFromProfile({ name: 'pkg-l' }, { dependencies: {} })).toBe(false)
    // 非 link 依赖（^1.0.0）不删；其真实目录（非符号链接）也不删
    const realDir = join(iso.profile, 'node_modules', 'pkg-real')
    mkdirSync(realDir, { recursive: true })
    const m2 = { dependencies: { 'pkg-real': '^1.0.0' } }
    expect(unlinkEntryFromProfile({ name: 'pkg-real' }, m2)).toBe(false)
    expect(m2.dependencies['pkg-real']).toBe('^1.0.0')
    expect(existsSync(realDir)).toBe(true)
  })
})

describe('removePatchBlock 边界（旧内联形态 + 两态返回）', () => {
  it('旧内联形态：marker 行 + 缩进行整体手术移除，其它内容保留', () => {
    writeFileSync(patchFile(), [
      '# 顶部注释',
      '- insert:  # hotplug:pack.x',
      '    - id: hp-old',
      '      name: \'old\'',
      '      config: {}',
      '## other:block',
      '- insert:',
      '    - id: keep',
      '      name: \'keep-me\'',
      '      config: {}',
      '',
    ].join('\n'))
    expect(removePatchBlock('pack.x')).toEqual({ ok: true, removed: true })
    const text = readFileSync(patchFile(), 'utf8')
    expect(text).not.toContain('hotplug:pack.x')
    expect(text).not.toContain('hp-old')
    expect(text).toContain('# 顶部注释')
    expect(text).toContain('## other:block')
    expect(text).toContain('keep-me')
  })

  it('文件存在但无该块 → {ok:true, removed:false}；文件缺失 → 同样', () => {
    writeFileSync(patchFile(), '## other:block\n- insert: []\n')
    expect(removePatchBlock('pack.none')).toEqual({ ok: true, removed: false })
    rmSync(patchFile())
    expect(removePatchBlock('pack.none')).toEqual({ ok: true, removed: false })
  })
})

describe('appendPatchBlock 与异包分节块共存', () => {
  it('异包块（## other:thing）不阻碍追加且逐字保留；同包块存在时拒绝且文件不受损', () => {
    const foreign = '## other:thing\n- insert:\n    - id: keep\n      name: \'x\'\n      config: {}\n'
    writeFileSync(patchFile(), foreign)
    const r = appendPatchBlock(samplePack())
    expect(r.ok).toBe(true)
    const text = readFileSync(patchFile(), 'utf8')
    expect(text).toContain('## other:thing') // 外块逐字保留
    expect(text).toContain("name: 'x'")
    expect(text).toContain('## hotplug:pack.test') // hotplug 块已追加
    // 同包重复追加 → 拒绝（状态不一致保护）；外块与既有内容不受损
    const r2 = appendPatchBlock(samplePack())
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain('已存在')
    expect(readFileSync(patchFile(), 'utf8')).toBe(text)
  })
})

describe('unmountPack npm 卸载门控（隔离 PATH，无 pnpm）', () => {
  // 隔离 PATH 里没有 pnpm：若 unmountPack 尝试 pnpm remove，Windows 下 cmd /c pnpm
  // 退出 1 / POSIX 下 spawn ENOENT code null ≠ 0 → ok:false。因此 ok:true 即证明未尝试。
  const npmPack = () => ({
    hotpack: '1.0', id: 'pack.npm', name: 'N', version: '1.0.0',
    plugins: [{ id: 'a', name: 'pkg-a', source: { type: 'npm' }, version: '1.0.0', config: {} }],
  })

  it('installedNpm 未提供（缺省=未知）→ 不尝试 pnpm remove（ok:true 佐证）', async () => {
    const m = readManifest()
    m.dependencies = { 'pkg-a': '1.0.0', keep: '^2.0.0' }
    writeManifest(m)
    const r = await unmountPack(npmPack())
    expect(r.ok).toBe(true)
    const after = readManifest()
    expect(after.dependencies['pkg-a']).toBe('1.0.0') // manifest 依赖不动（信息缺失不误删）
    expect(after.dependencies.keep).toBe('^2.0.0')
  })

  it('installedNpm 含该包名 → 尝试 pnpm remove → 无 pnpm 环境下优雅失败（ok:false）', async () => {
    const m = readManifest()
    m.dependencies = { 'pkg-a': '1.0.0' }
    writeManifest(m)
    const r = await unmountPack(npmPack(), { installedNpm: ['pkg-a'] })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('pnpm remove')
  })
})
