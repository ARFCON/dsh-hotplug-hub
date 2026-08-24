// test/mount-lifecycle.test.mjs — 挂载生命周期（最终批）
//
// 四区：
//   A. mount/unmount npm 端到端：fake pnpm（Windows = node.exe 副本 + profile/add|remove
//      脚本；POSIX = shebang 单脚本按 argv[2] 分发），调用记录追加写
//      <dshHome>/pnpm-calls.log（add 落地 = --save-exact 语义：manifest 记精确版本）。
//   B. patch 块边缘矩阵：前缀 id 碰撞族 / 新旧 marker 共存 / 移除接缝 / BOM /
//      拒绝后字节不变 / 文件缺失 / 纯注释文件。
//   C. 多 profile 隔离：DSH_PROFILE 显式切换（afterEach 经 restoreEnv 统一恢复）。
//   D. gateway 串行与恢复：篡改清单拒激活 / bundles 生命周期 / 5 轮无泄漏 /
//      并发 serialize 链 / preview wouldReplace。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import YAML from 'yaml'
import {
  mountPack, unmountPack, appendPatchBlock, removePatchBlock, patchLockPath,
} from '../lib/core/patch.js'
import { ensureNpm, installedVersion, npmModuleDir } from '../lib/core/ensure.js'
import { packsDir, profileDir } from '../lib/core/paths.js'
import { readState, readPackManifest } from '../lib/core/state.js'
import { statusSync } from '../lib/core/status.js'
import { HotplugGateway } from '../lib/gateway.js'
import { applyIsolatedEnv, isolatedDsh, samplePack } from './helpers.mjs'

let restoreEnv = null
let iso = null
let gateway = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
  gateway = new HotplugGateway({ reflect: { provide: () => {} } })
  delete process.env.DSH_ALLOW_INSTALL_SCRIPTS
})
afterEach(() => {
  if (restoreEnv) restoreEnv()
  delete process.env.HP_FAKE_PNPM_LOG
  if (iso) iso.cleanup()
})

// ---------- 夹具 ----------

const patchFile = () => join(profileDir(), 'cordis.patch.yml')
const manifestFile = () => join(profileDir(), 'package.json')
const patchText = () => readFileSync(patchFile(), 'utf8')
const readManifest = () => JSON.parse(readFileSync(manifestFile(), 'utf8'))
const hotplugMarkers = (text) => (text.match(/^##? hotplug:/gm) || []).length
const lstatThrows = (p) => { try { lstatSync(p); return false } catch { return true } }

/**
 * fake pnpm（参照 ensure-npm.test.mjs 的 fakePnpmAdd 模式，扩展 add+remove 双子命令）：
 *   add <spec>    → 落地 node_modules/<name>/package.json + manifest.dependencies[name]=<精确版本>
 *                   （pnpm add --save-exact 语义由 fake 落地）；package.json 缺失时创建
 *                   （真实 pnpm 在空目录 add 亦会创建）——供「不存在的 profile」挂载用例。
 *   remove <names>→ 删 node_modules/<name> + 清 manifest.dependencies[name]。
 * 每次调用先 append 一行 `<sub> <args...>` 到 HP_FAKE_PNPM_LOG（计数文件，位于 iso.dshHome）。
 * addExit/removeExit 非 0 时记录后直接失败退出（不落地）。
 */
function installFakePnpm(opts = {}) {
  const addExit = Number.isFinite(opts.addExit) ? opts.addExit : 0
  const removeExit = Number.isFinite(opts.removeExit) ? opts.removeExit : 0
  process.env.HP_FAKE_PNPM_LOG = join(iso.dshHome, 'pnpm-calls.log')
  const core = [
    "const fs = require('fs');",
    "const path = require('path');",
    "const log = process.env.HP_FAKE_PNPM_LOG || '';",
    "function record(line) { try { if (log) fs.appendFileSync(log, line + '\\n'); } catch (e) {} }",
    "function handle(sub, args) {",
    "  record(sub + ' ' + args.join(' '));",
    "  if (sub === 'add') {",
    `    if (${addExit} !== 0) process.exit(${addExit});`,
    "    const spec = args.find((a) => typeof a === 'string' && !a.startsWith('-') && a.includes('@'));",
    "    const m = spec ? /^([\\s\\S]+)@([^@]+)$/.exec(spec) : null;",
    "    if (!m) process.exit(1);",
    "    const dir = path.join(process.cwd(), 'node_modules', m[1]);",
    "    fs.mkdirSync(dir, { recursive: true });",
    "    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: m[1], version: m[2] }, null, 2));",
    "    const pkgPath = path.join(process.cwd(), 'package.json');",
    "    let pkg = null;",
    "    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (e) {}",
    "    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) pkg = { name: 'profile', private: true };",
    "    pkg.dependencies = (pkg.dependencies && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies)) ? pkg.dependencies : {};",
    "    pkg.dependencies[m[1]] = m[2];",
    "    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\\n');",
    "    process.exit(0);",
    "  }",
    "  if (sub === 'remove') {",
    `    if (${removeExit} !== 0) process.exit(${removeExit});`,
    "    const names = args.filter((a) => typeof a === 'string' && a !== '' && !a.startsWith('-'));",
    "    for (const name of names) {",
    "      try { fs.rmSync(path.join(process.cwd(), 'node_modules', name), { recursive: true, force: true }); } catch (e) {}",
    "    }",
    "    const pkgPath = path.join(process.cwd(), 'package.json');",
    "    try {",
    "      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));",
    "      for (const name of names) delete pkg.dependencies[name];",
    "      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\\n');",
    "    } catch (e) {}",
    "    process.exit(0);",
    "  }",
    "  process.exit(1);",
    "}",
  ].join('\n')
  // Windows：脚本文件（add/remove）必须放在 pnpm 的 cwd = 当前 profileDir 下
  //（node.exe 副本把第一个参数当脚本名、相对 cwd 解析）——按 profileDir() 动态落位，
  // 目录不存在则创建（C3 的 ghost profile 场景）。
  // 审查修复（磁盘开销）：node.exe 副本 ~15 个测试各复制一份 ≈ 1.2GB/轮——改为
  // 文件级缓存 + 每测试硬链接（同卷 linkSync，失败回退复制），字节共享零重复写。
  // CI 修复（POSIX）：ghost profile 目录创建提到平台分支之前——此前仅 Windows
  // 分支建目录（add/remove 脚本须落位其中），POSIX 上 DSH_PROFILE=ghost 时
  // runCli 以不存在的 cwd spawn → ENOENT → 挂载失败（ubuntu CI 红根因）。
  mkdirSync(profileDir(), { recursive: true })
  if (process.platform === 'win32') {
    placeFakePnpmExe(join(iso.dshHome, 'pnpm.exe'))
    writeFileSync(join(profileDir(), 'add'), `${core}\nhandle('add', process.argv.slice(2));`)
    writeFileSync(join(profileDir(), 'remove'), `${core}\nhandle('remove', process.argv.slice(2));`)
  } else {
    const exe = join(iso.dshHome, 'pnpm')
    writeFileSync(exe, `#!${process.execPath}\n${core}\nhandle(process.argv[2], process.argv.slice(3));`)
    chmodSync(exe, 0o755)
  }
}

/** 文件级 node.exe 副本缓存：首个测试复制一份到共享临时目录，其余硬链接落位。 */
let sharedPnpmExeCache = null
function placeFakePnpmExe(dest) {
  if (sharedPnpmExeCache === null) {
    const sharedDir = mkdtempSync(join(tmpdir(), 'hp-fake-pnpm-'))
    sharedPnpmExeCache = join(sharedDir, 'pnpm.exe')
    copyFileSync(process.execPath, sharedPnpmExeCache)
  }
  try {
    linkSync(sharedPnpmExeCache, dest)
  } catch {
    copyFileSync(sharedPnpmExeCache, dest) // 硬链接不可用（跨卷/权限）回退复制
  }
}

/** fake pnpm 调用记录（计数文件不存在 → []）。 */
function pnpmCalls() {
  try {
    return readFileSync(join(iso.dshHome, 'pnpm-calls.log'), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  } catch { return [] }
}
const pnpmRemoves = () => pnpmCalls().filter((line) => line.startsWith('remove'))

/** 预置 profile 既有 npm 依赖：node_modules/<name> + manifest.dependencies 均就绪。 */
function preinstallNpm(name, version) {
  const dir = npmModuleDir(name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  const manifest = readManifest()
  manifest.dependencies = { ...manifest.dependencies, [name]: version }
  writeFileSync(manifestFile(), JSON.stringify(manifest, null, 2))
}

/** 构造真实 path 源插件目录（package.json 内部包名一致）。 */
function makePathSource(pkgName, version = '1.0.0') {
  const dir = join(iso.dshHome, 'plugin-src', pkgName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkgName, version }))
  return dir
}

/** 手工建一个 profile（isolatedDsh 只建 web）。 */
function makeProfile(name) {
  const dir = join(iso.dshHome, 'profiles', name)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, private: true, dependencies: {} }, null, 2))
  return dir
}

const pathPack = (id, pkgName, srcDir, pluginId = 'p') => ({
  hotpack: '1.0', id, name: id, version: '1.0.0', description: '', tags: [],
  plugins: [{ id: pluginId, name: pkgName, source: { type: 'path', path: srcDir }, config: {} }],
})
const npmPack = (id, plugins) => ({
  hotpack: '1.0', id, name: id, version: '1.0.0', description: '', tags: [],
  plugins: plugins.map(([pid, name, version]) => ({ id: pid, name, source: { type: 'npm' }, version, config: {} })),
})

// ========== A. mount/unmount npm 端到端（fake pnpm） ==========

describe('A. mountPack / unmountPack npm 端到端（fake pnpm）', () => {
  it('A1 单 npm 插件挂载：downloaded + installedNpm + 精确版本依赖 + patch 块 + restartNeeded', async () => {
    installFakePnpm()
    const pack = npmPack('pack.n1', [['a', 'pkg-a', '1.2.3']])
    const m = await mountPack(pack)
    expect(m.ok).toBe(true)
    expect(m.restartNeeded).toBe(true)
    expect(m.installedNpm).toEqual(['pkg-a'])
    expect(m.steps).toHaveLength(1)
    expect(m.steps[0]).toMatchObject({ id: 'a', name: 'pkg-a', status: 'downloaded' })
    expect(m.steps[0].detail).toContain('pnpm add pkg-a@1.2.3')
    // fake pnpm 参数：--save-exact + 默认 --ignore-scripts（RCE 纵深防御）
    expect(pnpmCalls()[0]).toBe('add --save-exact --ignore-scripts pkg-a@1.2.3')
    // manifest 依赖为精确版本（无 ^ 前缀）
    const dep = readManifest().dependencies['pkg-a']
    expect(dep).toBe('1.2.3')
    expect(String(dep).startsWith('^')).toBe(false)
    expect(installedVersion('pkg-a')).toBe('1.2.3')
    expect(patchText()).toContain('## hotplug:pack.n1')
  })

  it('A2 patch 首块格式：marker 单独成行为文件首行 + 块内 hp- 前缀插件 id + 单 marker', () => {
    appendPatchBlock(samplePack({ id: 'pack.fmt' }))
    const text = patchText()
    expect(text.startsWith('## hotplug:pack.fmt\n')).toBe(true)
    expect(text).toContain('    - id: hp-pack.fmt-a')
    expect(text).toContain('name: pkg-a')
    expect(hotplugMarkers(text)).toBe(1)
    expect(text.endsWith('\n')).toBe(true)
    // 锁已释放（无残留 .dsh-patch.lock）
    expect(existsSync(patchLockPath())).toBe(false)
  })

  it('A3 两 npm 插件挂载：installedNpm 两个 + 两条精确版本依赖 + patch 块含两插件', async () => {
    installFakePnpm()
    const pack = npmPack('pack.two', [['a', 'pkg-c', '1.0.0'], ['b', 'pkg-d', '2.5.0']])
    const m = await mountPack(pack)
    expect(m.ok).toBe(true)
    expect(m.installedNpm).toEqual(['pkg-c', 'pkg-d'])
    expect(m.steps.map((s) => s.status)).toEqual(['downloaded', 'downloaded'])
    const deps = readManifest().dependencies
    expect(deps['pkg-c']).toBe('1.0.0')
    expect(deps['pkg-d']).toBe('2.5.0')
    const text = patchText()
    expect(text).toContain('hp-pack.two-a')
    expect(text).toContain('hp-pack.two-b')
  })

  it('A4 unmountPack(installedNpm=[name])：fake pnpm remove 被调 + node_modules/依赖/patch 三清', async () => {
    installFakePnpm()
    const pack = npmPack('pack.n1', [['a', 'pkg-a', '1.2.3']])
    const m = await mountPack(pack)
    expect(m.ok).toBe(true)
    const u = await unmountPack(pack, { installedNpm: m.installedNpm })
    expect(u.ok).toBe(true)
    expect(pnpmRemoves()).toEqual(['remove pkg-a'])
    expect(existsSync(npmModuleDir('pkg-a'))).toBe(false)
    expect(readManifest().dependencies['pkg-a']).toBeUndefined()
    expect(patchText()).not.toContain('hotplug:pack.n1')
  })

  it('A5 unmountPack 无 installedNpm：不调 pnpm remove（缺省=未知，无损优先），patch 块仍移除', async () => {
    installFakePnpm()
    const pack = npmPack('pack.n1', [['a', 'pkg-a', '1.2.3']])
    await mountPack(pack)
    const u = await unmountPack(pack)
    expect(u.ok).toBe(true)
    expect(pnpmRemoves()).toEqual([])
    // patch 块照常移除，npm 依赖与落地包保留（信息缺失时绝不破坏既有依赖）
    expect(patchText()).not.toContain('hotplug:pack.n1')
    expect(readManifest().dependencies['pkg-a']).toBe('1.2.3')
    expect(existsSync(join(npmModuleDir('pkg-a'), 'package.json'))).toBe(true)
  })

  it('A6 unmountPack installedNpm 不含该名：不 remove，预存依赖保留语义', async () => {
    installFakePnpm()
    const pack = npmPack('pack.n1', [['a', 'pkg-a', '1.2.3']])
    await mountPack(pack)
    const u = await unmountPack(pack, { installedNpm: ['someone-else'] })
    expect(u.ok).toBe(true)
    expect(pnpmRemoves()).toEqual([])
    expect(patchText()).not.toContain('hotplug:pack.n1')
    expect(readManifest().dependencies['pkg-a']).toBe('1.2.3')
    expect(installedVersion('pkg-a')).toBe('1.2.3')
  })

  it('A7 ensureNpm 版本替换（直调）：预置不同版本 → replaced', async () => {
    installFakePnpm()
    preinstallNpm('pkg-a', '0.9.0')
    const r = await ensureNpm({ name: 'pkg-a', version: '1.2.3', source: { type: 'npm' } })
    expect(r.ok).toBe(true)
    expect(r.status).toBe('replaced')
    expect(installedVersion('pkg-a')).toBe('1.2.3')
    expect(readManifest().dependencies['pkg-a']).toBe('1.2.3')
  })

  it('A8 mountPack 版本替换：status replaced 且 installedNpm 含该名（替换=本次挂载实际安装）', async () => {
    installFakePnpm()
    preinstallNpm('pkg-a', '0.9.0')
    const pack = npmPack('pack.rep', [['a', 'pkg-a', '1.2.3']])
    const m = await mountPack(pack)
    expect(m.ok).toBe(true)
    expect(m.steps[0].status).toBe('replaced')
    expect(m.installedNpm).toContain('pkg-a')
    expect(readManifest().dependencies['pkg-a']).toBe('1.2.3')
  })

  it('A9 reused npm 插件：installedNpm 为空；卸载后包仍在 node_modules（无损）且零 remove', async () => {
    installFakePnpm()
    preinstallNpm('pkg-a', '1.2.3')
    const pack = npmPack('pack.reu', [['a', 'pkg-a', '1.2.3']])
    const m = await mountPack(pack)
    expect(m.ok).toBe(true)
    expect(m.steps[0].status).toBe('reused')
    expect(m.installedNpm).toEqual([])
    const u = await unmountPack(pack, { installedNpm: m.installedNpm })
    expect(u.ok).toBe(true)
    expect(pnpmRemoves()).toEqual([])
    expect(existsSync(join(npmModuleDir('pkg-a'), 'package.json'))).toBe(true)
    expect(readManifest().dependencies['pkg-a']).toBe('1.2.3')
  })

  it('A10 挂载失败回滚（第二个插件 path 源不存在）：freshly-installed npm 包被 pnpm remove，patch 无块', async () => {
    installFakePnpm()
    const pack = {
      hotpack: '1.0', id: 'pack.rb', name: 'RB', version: '1.0.0',
      plugins: [
        { id: 'a', name: 'pkg-a', source: { type: 'npm' }, version: '1.2.3', config: {} },
        { id: 'bad', name: 'pkg-bad', source: { type: 'path', path: join(iso.dshHome, 'nope') }, config: {} },
      ],
    }
    const m = await mountPack(pack)
    expect(m.ok).toBe(false)
    expect(m.error).toContain('path 源不存在')
    expect(m.steps[0].status).toBe('downloaded')
    // 计数文件证明：回滚把本次新装的 pkg-a 撤掉（node_modules + manifest 依赖 + patch）
    expect(pnpmRemoves()).toEqual(['remove pkg-a'])
    expect(existsSync(npmModuleDir('pkg-a'))).toBe(false)
    expect(readManifest().dependencies['pkg-a']).toBeUndefined()
    expect(!existsSync(patchFile()) || !patchText().includes('hotplug:pack.rb')).toBe(true)
  })

  it('A11 挂载失败回滚不触碰 reused：预存 foo 保留，且整个过程中零 pnpm 调用（计数文件不出现）', async () => {
    installFakePnpm()
    preinstallNpm('foo', '1.0.0')
    const pack = {
      hotpack: '1.0', id: 'pack.rk', name: 'RK', version: '1.0.0',
      plugins: [
        { id: 'a', name: 'foo', source: { type: 'npm' }, version: '1.0.0', config: {} },
        { id: 'bad', name: 'pkg-bad', source: { type: 'path', path: join(iso.dshHome, 'nope') }, config: {} },
      ],
    }
    const m = await mountPack(pack)
    expect(m.ok).toBe(false)
    expect(m.steps[0].status).toBe('reused')
    // reused → 无 add；回滚只撤 freshlyInstalled（空）→ 无 remove：日志文件根本不出现
    expect(pnpmCalls()).toEqual([])
    expect(existsSync(join(npmModuleDir('foo'), 'package.json'))).toBe(true)
    expect(readManifest().dependencies.foo).toBe('1.0.0')
  })

  it('A12 两插件（npm+path）挂载成功：精确版本与 link: 两种依赖形态共存', async () => {
    installFakePnpm()
    const srcB = makePathSource('pkg-b')
    const pack = {
      hotpack: '1.0', id: 'pack.mix', name: 'MIX', version: '1.0.0',
      plugins: [
        { id: 'a', name: 'pkg-a', source: { type: 'npm' }, version: '1.2.3', config: {} },
        { id: 'b', name: 'pkg-b', source: { type: 'path', path: srcB }, config: {} },
      ],
    }
    const m = await mountPack(pack)
    expect(m.ok).toBe(true)
    expect(m.installedNpm).toEqual(['pkg-a'])
    const deps = readManifest().dependencies
    expect(deps['pkg-a']).toBe('1.2.3')
    expect(String(deps['pkg-b'])).toBe(`link:${srcB.replace(/\\/g, '/')}`)
    expect(lstatSync(join(iso.profile, 'node_modules', 'pkg-b')).isSymbolicLink()).toBe(true)
    expect(patchText()).toContain('hp-pack.mix-a')
    expect(patchText()).toContain('hp-pack.mix-b')
  })

  it('A13 双形态卸载（installedNpm 只含 npm 名）：link 依赖与 npm 包同时清干净', async () => {
    installFakePnpm()
    const srcB = makePathSource('pkg-b')
    const pack = {
      hotpack: '1.0', id: 'pack.mix', name: 'MIX', version: '1.0.0',
      plugins: [
        { id: 'a', name: 'pkg-a', source: { type: 'npm' }, version: '1.2.3', config: {} },
        { id: 'b', name: 'pkg-b', source: { type: 'path', path: srcB }, config: {} },
      ],
    }
    await mountPack(pack)
    const u = await unmountPack(pack, { installedNpm: ['pkg-a'] })
    expect(u.ok).toBe(true)
    expect(readManifest().dependencies).toEqual({})
    expect(pnpmRemoves()).toEqual(['remove pkg-a'])
    expect(lstatThrows(join(iso.profile, 'node_modules', 'pkg-b'))).toBe(true)
    expect(patchText()).not.toContain('hotplug:pack.mix')
  })

  it('A14 两 npm 插件卸载：单次 pnpm remove 调用批量带两名', async () => {
    installFakePnpm()
    const pack = npmPack('pack.two', [['a', 'pkg-c', '1.0.0'], ['b', 'pkg-d', '2.5.0']])
    const m = await mountPack(pack)
    const u = await unmountPack(pack, { installedNpm: m.installedNpm })
    expect(u.ok).toBe(true)
    expect(pnpmRemoves()).toHaveLength(1)
    expect(pnpmRemoves()[0]).toBe('remove pkg-c pkg-d')
    expect(readManifest().dependencies).toEqual({})
  })

  it('A15 pnpm remove 失败（fake exit 1）→ unmountPack 显式失败，patch 块已移除、依赖残留可见', async () => {
    installFakePnpm({ removeExit: 1 })
    const pack = npmPack('pack.rf', [['a', 'pkg-a', '1.2.3']])
    await mountPack(pack)
    const u = await unmountPack(pack, { installedNpm: ['pkg-a'] })
    expect(u.ok).toBe(false)
    expect(u.error).toContain('pnpm remove 失败')
    // removePatchBlock 先于 pnpm remove 执行 → 块已移除；包与依赖因 remove 失败而保留
    expect(patchText()).not.toContain('hotplug:pack.rf')
    expect(readManifest().dependencies['pkg-a']).toBe('1.2.3')
  })

  it('A16 pnpm add 失败（fake 未落地）→ mountPack 显式失败且零残留', async () => {
    installFakePnpm({ addExit: 1 })
    const pack = npmPack('pack.af', [['a', 'pkg-x', '9.9.9']])
    const m = await mountPack(pack)
    expect(m.ok).toBe(false)
    expect(m.error).toContain('pnpm add pkg-x@9.9.9')
    expect(m.steps).toEqual([])
    expect(readManifest().dependencies['pkg-x']).toBeUndefined()
    expect(!existsSync(patchFile()) || !patchText().includes('hotplug:pack.af')).toBe(true)
  })
})

// ========== B. patch 块边缘矩阵 ==========

describe('B. patch 块边缘矩阵（appendPatchBlock / removePatchBlock）', () => {
  it('B9a 前缀碰撞族：pack.a 已挂载 → append pack.a.b → ok，两块共存', () => {
    expect(appendPatchBlock(samplePack({ id: 'pack.a' })).ok).toBe(true)
    expect(appendPatchBlock(samplePack({ id: 'pack.a.b' })).ok).toBe(true)
    const text = patchText()
    expect(text).toContain('## hotplug:pack.a\n')
    expect(text).toContain('## hotplug:pack.a.b\n')
    expect(hotplugMarkers(text)).toBe(2)
  })

  it('B9b remove pack.a → pack.a.b 块完整保留（精确 marker 匹配，非前缀）', () => {
    appendPatchBlock(samplePack({ id: 'pack.a' }))
    appendPatchBlock(samplePack({ id: 'pack.a.b' }))
    expect(removePatchBlock('pack.a')).toEqual({ ok: true, removed: true })
    const text = patchText()
    expect(text).toContain('## hotplug:pack.a.b')
    expect(text).toContain('hp-pack.a.b-a') // pack.a.b 的块内容原样保留
    expect(text).not.toContain('## hotplug:pack.a\n')
    expect(text).not.toContain('hp-pack.a-a')
  })

  it('B9c remove pack.a 后槽位释放：re-append pack.a → ok，两块再次共存', () => {
    appendPatchBlock(samplePack({ id: 'pack.a' }))
    appendPatchBlock(samplePack({ id: 'pack.a.b' }))
    removePatchBlock('pack.a')
    expect(appendPatchBlock(samplePack({ id: 'pack.a' })).ok).toBe(true)
    expect(hotplugMarkers(patchText())).toBe(2)
  })

  it('B10 旧单 # 形态与新 ## 形态共存：removePatchBlock 两者分别精确移除', () => {
    writeFileSync(patchFile(), [
      '# hotplug:pack.old',
      '- insert:',
      "    - id: hp-old-x",
      "      name: 'oldx'",
      '      config: {}',
      '## hotplug:pack.new',
      '- insert:',
      '    - id: hp-new-x',
      "      name: 'newx'",
      '      config: {}',
      '',
    ].join('\n'))
    expect(removePatchBlock('pack.old')).toEqual({ ok: true, removed: true })
    let text = patchText()
    expect(text).not.toContain('# hotplug:pack.old')
    expect(text).not.toContain('hp-old-x')
    expect(text).toContain('## hotplug:pack.new')
    expect(text).toContain('hp-new-x')
    expect(removePatchBlock('pack.new')).toEqual({ ok: true, removed: true })
    text = patchText()
    expect(hotplugMarkers(text)).toBe(0)
    expect(text).not.toContain('hp-new-x')
  })

  it('B11 连续 remove 两块：文件尾不留双空行缝，且仍是合法 YAML（YAML.parse 可解析）', () => {
    writeFileSync(patchFile(), [
      '# header comment',
      '',
      '## desktop:keep',
      '- insert:',
      '    - id: keep',
      "      name: 'keep'",
      '      config: {}',
      '',
      '## hotplug:pack.p1',
      '- insert:',
      '    - id: hp1',
      "      name: 'p1'",
      '      config: {}',
      '## hotplug:pack.p2',
      '- insert:',
      '    - id: hp2',
      "      name: 'p2'",
      '      config: {}',
      '',
    ].join('\n'))
    expect(removePatchBlock('pack.p1')).toEqual({ ok: true, removed: true })
    expect(removePatchBlock('pack.p2')).toEqual({ ok: true, removed: true })
    const text = patchText()
    expect(text).not.toContain('pack.p1')
    expect(text).not.toContain('pack.p2')
    // 无三连换行缝、不以双换行收尾
    expect(text.includes('\n\n\n')).toBe(false)
    expect(text.endsWith('\n\n')).toBe(false)
    // 其余内容保留 + 合法 YAML
    expect(text).toContain('# header comment')
    const parsed = YAML.parse(text)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0].insert[0]).toMatchObject({ id: 'keep', name: 'keep' })
  })

  it('B12 含 BOM 的既有 patch 文件：append 不炸、BOM 与既有块保留；remove 同样正常', () => {
    writeFileSync(patchFile(), '\uFEFF## desktop:keep\n- insert: []\n')
    expect(appendPatchBlock(samplePack({ id: 'pack.bom' })).ok).toBe(true)
    let text = patchText()
    expect(text.startsWith('\uFEFF')).toBe(true)
    expect(text).toContain('## desktop:keep')
    expect(text).toContain('## hotplug:pack.bom')
    expect(removePatchBlock('pack.bom')).toEqual({ ok: true, removed: true })
    text = patchText()
    expect(text).toContain('## desktop:keep')
    expect(text).not.toContain('hotplug:pack.bom')
  })

  it('B13 append 同 id 块拒绝后文件字节不变（Buffer 级比较）', () => {
    appendPatchBlock(samplePack({ id: 'pack.dup' }))
    const before = readFileSync(patchFile())
    const r = appendPatchBlock(samplePack({ id: 'pack.dup' }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('已存在')
    const after = readFileSync(patchFile())
    expect(after.equals(before)).toBe(true)
  })

  it('B14a patch 文件不存在 → remove 返回 {ok:true, removed:false}，文件仍不存在', () => {
    expect(removePatchBlock('pack.none')).toEqual({ ok: true, removed: false })
    expect(existsSync(patchFile())).toBe(false)
  })

  it('B14b patch 文件不存在 → append 创建仅含单块的文件', () => {
    expect(appendPatchBlock(samplePack({ id: 'pack.fresh' })).ok).toBe(true)
    const text = patchText()
    expect(text.startsWith('## hotplug:pack.fresh\n')).toBe(true)
    expect(hotplugMarkers(text)).toBe(1)
  })

  it('B15 既有文件只有注释/空行：append 追加块，注释保留在块之前', () => {
    writeFileSync(patchFile(), '# only comment\n\n# another note\n')
    expect(appendPatchBlock(samplePack({ id: 'pack.cmt' })).ok).toBe(true)
    const text = patchText()
    expect(text.indexOf('# only comment')).toBeLessThan(text.indexOf('## hotplug:pack.cmt'))
    expect(text.indexOf('# another note')).toBeLessThan(text.indexOf('## hotplug:pack.cmt'))
    expect(hotplugMarkers(text)).toBe(1)
  })

  it('B26 文件存在但无该块 → remove 返回 removed:false 且字节不变', () => {
    writeFileSync(patchFile(), '## desktop:keep\n- insert: []\n')
    const before = readFileSync(patchFile())
    expect(removePatchBlock('pack.absent')).toEqual({ ok: true, removed: false })
    expect(readFileSync(patchFile()).equals(before)).toBe(true)
  })

  it('B27 append → remove → append 往返：文件字节稳定（第二次 append 与第一次产物一致）', () => {
    appendPatchBlock(samplePack({ id: 'pack.rt' }))
    const first = readFileSync(patchFile())
    expect(removePatchBlock('pack.rt')).toEqual({ ok: true, removed: true })
    appendPatchBlock(samplePack({ id: 'pack.rt' }))
    expect(readFileSync(patchFile()).equals(first)).toBe(true)
  })

  it('B45 旧内联形态（- insert:  # hotplug:x）与他人块共存：append 新块正常、内联块手术移除互不影响', () => {
    writeFileSync(patchFile(), [
      '- insert:  # hotplug:pack.legacy',
      '    - id: hp-leg',
      "      name: 'leg'",
      '      config: {}',
      '',
    ].join('\n'))
    expect(appendPatchBlock(samplePack({ id: 'pack.fresh' })).ok).toBe(true)
    let text = patchText()
    expect(text).toContain('# hotplug:pack.legacy')
    expect(text).toContain('## hotplug:pack.fresh')
    expect(removePatchBlock('pack.legacy')).toEqual({ ok: true, removed: true })
    text = patchText()
    expect(text).not.toContain('hotplug:pack.legacy')
    expect(text).not.toContain('hp-leg')
    expect(text).toContain('## hotplug:pack.fresh')
  })
})

// ========== C. 多 profile 隔离（DSH_PROFILE） ==========

describe('C. 多 profile 隔离（DSH_PROFILE 显式切换；afterEach restoreEnv 统一恢复）', () => {
  it('C1 DSH_PROFILE=other：activate 写 other profile 的 patch/package.json，web 不受影响', async () => {
    const other = makeProfile('other')
    const src = makePathSource('pkg-o')
    process.env.DSH_PROFILE = 'other'
    expect(profileDir()).toBe(other)
    expect(patchLockPath()).toBe(join(other, '.dsh-patch.lock'))
    const imp = await gateway.importPack(JSON.stringify(pathPack('pack.o', 'pkg-o', src)))
    expect(imp.ok).toBe(true)
    const act = await gateway.activate('pack.o')
    expect(act.ok).toBe(true)
    // other：patch 块 + link 依赖
    expect(readFileSync(join(other, 'cordis.patch.yml'), 'utf8')).toContain('## hotplug:pack.o')
    const otherManifest = JSON.parse(readFileSync(join(other, 'package.json'), 'utf8'))
    expect(String(otherManifest.dependencies['pkg-o'])).toContain('link:')
    // web：完全未触碰（无 patch 文件、依赖仍为空）——显式读 web 的 manifest
    expect(existsSync(join(iso.profile, 'cordis.patch.yml'))).toBe(false)
    const webManifest = JSON.parse(readFileSync(join(iso.profile, 'package.json'), 'utf8'))
    expect(webManifest.dependencies).toEqual({})
  })

  it('C2 other profile 上 deactivate：other 清理干净，web 仍干净，状态清空', async () => {
    const other = makeProfile('other')
    const src = makePathSource('pkg-o')
    process.env.DSH_PROFILE = 'other'
    await gateway.importPack(JSON.stringify(pathPack('pack.o', 'pkg-o', src)))
    await gateway.activate('pack.o')
    const de = await gateway.deactivate()
    expect(de.ok).toBe(true)
    expect(readFileSync(join(other, 'cordis.patch.yml'), 'utf8')).not.toContain('hotplug:pack.o')
    expect(JSON.parse(readFileSync(join(other, 'package.json'), 'utf8')).dependencies).toEqual({})
    expect(lstatThrows(join(other, 'node_modules', 'pkg-o'))).toBe(true)
    expect(existsSync(join(iso.profile, 'cordis.patch.yml'))).toBe(false)
    expect(readState().activePack).toBe(null)
  })

  it('C3 DSH_PROFILE=ghost（不存在）：profileDir 指向该名，mountPack 成功并创建 profile 内容', async () => {
    process.env.DSH_PROFILE = 'ghost'
    installFakePnpm() // fake pnpm 脚本随 profileDir 落位（目录随之建壳，但无 package.json）
    const ghost = join(iso.dshHome, 'profiles', 'ghost')
    expect(profileDir()).toBe(ghost)
    expect(existsSync(join(ghost, 'package.json'))).toBe(false) // profile 尚未引导
    const m = await mountPack(npmPack('pack.gh', [['a', 'pkg-a', '1.2.3']]))
    expect(m.ok).toBe(true)
    // 挂载创建 profile：fake pnpm add 像真实 pnpm 一样落地 package.json（精确版本依赖）；patch 由挂载写入
    const manifest = JSON.parse(readFileSync(join(ghost, 'package.json'), 'utf8'))
    expect(manifest.dependencies['pkg-a']).toBe('1.2.3')
    expect(readFileSync(join(ghost, 'cordis.patch.yml'), 'utf8')).toContain('## hotplug:pack.gh')
    expect(existsSync(join(ghost, 'node_modules', 'pkg-a', 'package.json'))).toBe(true)
    expect(installedVersion('pkg-a')).toBe('1.2.3')
  })

  it('C4 statusSync 跟随显式 DSH_PROFILE：ghost 未建时即报 profile.name=ghost', () => {
    process.env.DSH_PROFILE = 'ghost'
    const s = statusSync()
    expect(s.profile.name).toBe('ghost')
    expect(s.profile.dir).toBe(join(iso.dshHome, 'profiles', 'ghost'))
  })

  it('C5 web 与 other 各挂各的：两个 profile 的 patch 文件互不干扰（各自只含自己的块）', async () => {
    const other = makeProfile('other')
    const srcW = makePathSource('pkg-w')
    const srcO = makePathSource('pkg-o2')
    // 先挂 web
    await gateway.importPack(JSON.stringify(pathPack('pack.web', 'pkg-w', srcW)))
    expect((await gateway.activate('pack.web')).ok).toBe(true)
    // 切到 other 再挂
    process.env.DSH_PROFILE = 'other'
    await gateway.importPack(JSON.stringify(pathPack('pack.other', 'pkg-o2', srcO)))
    expect((await gateway.activate('pack.other')).ok).toBe(true)
    const webText = readFileSync(join(iso.profile, 'cordis.patch.yml'), 'utf8')
    const otherText = readFileSync(join(other, 'cordis.patch.yml'), 'utf8')
    expect(webText).toContain('## hotplug:pack.web')
    expect(webText).not.toContain('hotplug:pack.other')
    expect(otherText).toContain('## hotplug:pack.other')
    expect(otherText).not.toContain('hotplug:pack.web')
  })
})

// ========== D. gateway 串行与恢复矩阵 ==========

describe('D. gateway 串行与恢复', () => {
  it('D1 activate A 成功后篡改 B 清单为非法（可解析 JSON）→ activate B 失败，A 仍是激活', async () => {
    const srcA = makePathSource('pkg-w')
    const srcB = makePathSource('pkg-b2')
    await gateway.importPack(JSON.stringify(pathPack('pack.a', 'pkg-w', srcA)))
    await gateway.importPack(JSON.stringify(pathPack('pack.b', 'pkg-b2', srcB)))
    expect((await gateway.activate('pack.a')).ok).toBe(true)
    // 篡改：可解析 JSON 但过不了权威校验（plugins 非数组）
    writeFileSync(join(packsDir(), 'pack.b', 'hotpack.json'),
      JSON.stringify({ hotpack: '1.0', id: 'pack.b', name: 'B', version: '1.0.0', plugins: 'nope' }))
    const r = await gateway.activate('pack.b')
    expect(r.ok).toBe(false)
    expect(String(r.error ?? r.message)).toContain('清单校验失败')
    // A 完整保留：状态 / patch 块 / link 依赖 / junction
    expect(readState().activePack).toBe('pack.a')
    expect(patchText()).toContain('## hotplug:pack.a')
    expect(String(readManifest().dependencies['pkg-w'])).toContain('link:')
    expect(lstatSync(join(iso.profile, 'node_modules', 'pkg-w')).isSymbolicLink()).toBe(true)
  })

  it('D2 activate 未知包（manifest 缺失）→ 失败「未找到包」，A 不受影响', async () => {
    const srcA = makePathSource('pkg-w')
    await gateway.importPack(JSON.stringify(pathPack('pack.a', 'pkg-w', srcA)))
    await gateway.activate('pack.a')
    const r = await gateway.activate('pack.nope')
    expect(r.ok).toBe(false)
    expect(String(r.error ?? r.message)).toContain('未找到包')
    expect(readState().activePack).toBe('pack.a')
    expect(patchText()).toContain('## hotplug:pack.a')
  })

  it('D3 bundles 生命周期：github store 预置 dsh.bundle.patch:true → activate 登记、deactivate 清空', async () => {
    // github store 预置法：写 store 目录 package.json 含 dsh.bundle.patch:true（ensureGithub reused，零网络）
    const storeDir = join(iso.dshHome, 'hotplug-store', 'pkg-g@main')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, 'package.json'),
      JSON.stringify({ name: 'pkg-g', version: '1.0.0', dsh: { bundle: { patch: true } } }))
    const srcP = makePathSource('pkg-p')
    const pack = {
      hotpack: '1.0', id: 'pack.bd', name: 'BD', version: '1.0.0',
      plugins: [
        { id: 'p', name: 'pkg-p', source: { type: 'path', path: srcP }, config: {} },
        { id: 'g', name: 'pkg-g', source: { type: 'github', repo: 'acme/pkg-g', ref: 'main' }, config: {} },
      ],
    }
    await gateway.importPack(JSON.stringify(pack))
    expect((await gateway.activate('pack.bd')).ok).toBe(true)
    const mounted = readManifest()
    expect(mounted.dsh.profile.bundles).toContain('pkg-g')
    expect(String(mounted.dependencies['pkg-p'])).toContain('link:')
    const de = await gateway.deactivate()
    expect(de.ok).toBe(true)
    const after = readManifest()
    expect(after.dependencies).toEqual({})
    expect((after.dsh?.profile?.bundles ?? [])).not.toContain('pkg-g')
    expect(patchText()).not.toContain('hotplug:pack.bd')
    // store 缓存原样保留（无损）
    expect(existsSync(join(storeDir, 'package.json'))).toBe(true)
    expect(readState().activePack).toBe(null)
  })

  it('D4 连续 activate/deactivate 5 轮：无泄漏（块清零、junction 消失、依赖空、状态归位）', async () => {
    const src = makePathSource('pkg-loop')
    const linkPath = join(iso.profile, 'node_modules', 'pkg-loop')
    await gateway.importPack(JSON.stringify(pathPack('pack.lp', 'pkg-loop', src)))
    for (let round = 1; round <= 5; round++) {
      const act = await gateway.activate('pack.lp')
      expect(act.ok).toBe(true)
      expect(patchText()).toContain('## hotplug:pack.lp')
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
      const de = await gateway.deactivate()
      expect(de.ok).toBe(true)
      // 每轮卸载后：无块 / 无残留 junction（lstat 不存在）/ 依赖空 / 状态清
      expect(hotplugMarkers(patchText())).toBe(0)
      expect(lstatThrows(linkPath)).toBe(true)
      expect(readManifest().dependencies).toEqual({})
      expect(readState().activePack).toBe(null)
    }
    expect(readState().history).toHaveLength(10) // 5×(activate+deactivate)
  })

  it('D5 importPack 与 activate 并发（import 先发起）：serialize 链保证先导入后激活，最终一致', async () => {
    const src = makePathSource('pkg-r1')
    const text = JSON.stringify(pathPack('pack.r1', 'pkg-r1', src))
    const [imp, act] = await Promise.all([gateway.importPack(text), gateway.activate('pack.r1')])
    expect(imp.ok).toBe(true)
    expect(act.ok).toBe(true)
    expect(readState().activePack).toBe('pack.r1')
    expect(patchText()).toContain('## hotplug:pack.r1')
  })

  it('D6 activate 与 importPack 并发（activate 先发起）：activate 读到的是完整清单或显式未找到，无半态', async () => {
    const src = makePathSource('pkg-r2')
    const text = JSON.stringify(pathPack('pack.r2', 'pkg-r2', src))
    const [act, imp] = await Promise.all([gateway.activate('pack.r2'), gateway.importPack(text)])
    // activate 排在 import 之前 → 读不到清单 → 显式失败（而非挂到半截 manifest）
    expect(act.ok).toBe(false)
    expect(String(act.error ?? act.message)).toContain('未找到包')
    expect(imp.ok).toBe(true)
    // 最终一致：包完整导入、未激活、无 patch 块
    expect(readPackManifest('pack.r2').id).toBe('pack.r2')
    expect(readState().activePack).toBe(null)
    expect(!existsSync(patchFile()) || !patchText().includes('hotplug:pack.r2')).toBe(true)
  })

  it('D7 activate A 与 activate B 并发：serialize 链串行化，最终恰好一个激活、patch 恰好一块', async () => {
    const srcA = makePathSource('pkg-ca')
    const srcB = makePathSource('pkg-cb')
    await gateway.importPack(JSON.stringify(pathPack('pack.ca', 'pkg-ca', srcA)))
    await gateway.importPack(JSON.stringify(pathPack('pack.cb', 'pkg-cb', srcB)))
    const [actA, actB] = await Promise.all([gateway.activate('pack.ca'), gateway.activate('pack.cb')])
    expect(actA.ok).toBe(true)
    expect(actB.ok).toBe(true)
    // 先 A 后 B：B 切换成功 → A 块被卸载
    expect(readState().activePack).toBe('pack.cb')
    const text = patchText()
    expect(hotplugMarkers(text)).toBe(1)
    expect(text).toContain('## hotplug:pack.cb')
    expect(text).not.toContain('## hotplug:pack.ca')
    const deps = readManifest().dependencies
    expect(deps['pkg-cb']).toContain('link:')
    expect(deps['pkg-ca']).toBeUndefined()
  })

  it('D8 preview 对 active 包：wouldReplace=null（自己不替换自己）', async () => {
    const src = makePathSource('pkg-pv')
    await gateway.importPack(JSON.stringify(pathPack('pack.pv', 'pkg-pv', src)))
    await gateway.activate('pack.pv')
    const r = await gateway.preview('pack.pv')
    expect(r.ok).toBe(true)
    expect(r.wouldReplace).toBe(null)
    expect(r.refs[0].action).toBe('reused')
  })

  it('D9 preview 对非激活包（A 激活中）：wouldReplace=当前激活包', async () => {
    const srcA = makePathSource('pkg-p1')
    const srcQ = makePathSource('pkg-p2')
    await gateway.importPack(JSON.stringify(pathPack('pack.p1', 'pkg-p1', srcA)))
    await gateway.importPack(JSON.stringify(pathPack('pack.q', 'pkg-p2', srcQ)))
    await gateway.activate('pack.p1')
    const r = await gateway.preview('pack.q')
    expect(r.ok).toBe(true)
    expect(r.wouldReplace).toBe('pack.p1')
  })

  it('D10 npm→path 切换：activeInstall.installedNpm 持久化；切换时上一包被 remove、events 记录卸载', async () => {
    installFakePnpm()
    const srcB = makePathSource('pkg-sw')
    await gateway.importPack(JSON.stringify(npmPack('pack.na', [['a', 'pkg-a', '1.2.3']])))
    await gateway.importPack(JSON.stringify(pathPack('pack.pb', 'pkg-sw', srcB)))
    const actA = await gateway.activate('pack.na')
    expect(actA.ok).toBe(true)
    expect(readState().activeInstall).toEqual({ packId: 'pack.na', installedNpm: ['pkg-a'] })
    expect(pnpmCalls()[0]).toBe('add --save-exact --ignore-scripts pkg-a@1.2.3')
    const actB = await gateway.activate('pack.pb')
    expect(actB.ok).toBe(true)
    expect((actB.events ?? []).some((e) => e.includes('已卸载上一个包'))).toBe(true)
    // 上一包「实际安装」的 npm 包被 remove（activeInstall 语义落地）
    expect(pnpmRemoves()).toEqual(['remove pkg-a'])
    const after = readManifest().dependencies
    expect(after['pkg-a']).toBeUndefined()
    expect(String(after['pkg-sw'])).toContain('link:')
    expect(hotplugMarkers(patchText())).toBe(1)
    expect(patchText()).toContain('## hotplug:pack.pb')
    expect(readState().activeInstall).toEqual({ packId: 'pack.pb', installedNpm: [] })
  })

  it('D11 deactivate 时 manifest 已缺失（packs 目录被删）：仍移除旧块并清空状态', async () => {
    const src = makePathSource('pkg-mv')
    await gateway.importPack(JSON.stringify(pathPack('pack.mv', 'pkg-mv', src)))
    await gateway.activate('pack.mv')
    rmSync(join(packsDir(), 'pack.mv'), { recursive: true, force: true })
    const de = await gateway.deactivate()
    expect(de.ok).toBe(true)
    expect(patchText()).not.toContain('hotplug:pack.mv')
    // 该分支只承诺「移除旧块 + 清空状态」——manifest 缺失时无从得知插件清单，
    // link 依赖按尽力而为语义保留（junction 一并留存）
    expect(String(readManifest().dependencies['pkg-mv'])).toContain('link:')
    expect(readState().activePack).toBe(null)
  })

  it('D12 gateway.status() 反映激活态：activePack + activePatchOk=true + 成功信封 code=OK', async () => {
    const src = makePathSource('pkg-st')
    await gateway.importPack(JSON.stringify(pathPack('pack.st', 'pkg-st', src)))
    await gateway.activate('pack.st')
    const s = await gateway.status()
    expect(s.ok).not.toBe(false)
    expect(s.code).toBe('OK')
    expect(s.exitCode).toBe(0)
    expect(s.activePack).toBe('pack.st')
    expect(s.activePatchOk).toBe(true)
    expect(s.profile.name).toBe('web')
    expect(s.packs.find((p) => p.id === 'pack.st').active).toBe(true)
  })
})
