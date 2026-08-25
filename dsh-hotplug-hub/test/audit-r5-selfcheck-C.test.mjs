// test/audit-r5-selfcheck-C.test.mjs — 第五轮（C）深度审计：自检 + 激活切换原子性 + 挂载事务
//
// 聚焦三个最高风险面里「部分失败」路径的原子性缺口，用真实测试钉死契约。当前实现
// 的失败点用「BUG 复现」注释标注，测试预期=正确契约 → 失败=缺陷落点（红灯）。
//
// 隔离 DSH_HOME（isolatedDsh/applyIsolatedEnv），零真实 ~/.dsh 写入；子进程仅用
// process.execPath 绝对路径伪造 pnpm（不依赖真实网络/系统二进制）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { HotplugGateway } from '../lib/gateway.js'
import { readState, writeState } from '../lib/core/state.js'
import { statusSync } from '../lib/core/status.js'
import { packsDir } from '../lib/core/paths.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null
let gateway = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
  gateway = new HotplugGateway({ reflect: { provide: () => {} } })
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

/** path 源包（激活零 spawn，零 pnpm）。 */
function pathPack(id, name) {
  const src = join(iso.dshHome, 'src', name)
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  return {
    hotpack: '1.0', id, name: id, version: '1.0.0',
    plugins: [{ id: 'main', name, source: { type: 'path', path: src }, config: {} }],
  }
}

function patchText() {
  const f = join(iso.profile, 'cordis.patch.yml')
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

/** 假 pnpm：任何调用退出码 1（此处只会命中 `pnpm remove`）。 */
function fakePnpmFail() {
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, join(iso.dshHome, 'pnpm.exe'))
    writeFileSync(join(iso.profile, 'remove'), 'process.exit(1);\n')
  } else {
    const exe = join(iso.dshHome, 'pnpm')
    writeFileSync(exe, `#!${process.execPath}\nprocess.exit(1);\n`)
    chmodSync(exe, 0o755)
  }
}

/** 把激活中的 path 包篡改为「含已安装 npm 插件 foo」——让 unmount 阶段走到 `pnpm remove`，
 *  且 remove 之前 removePatchBlock 已成功（构造 unmountPack 的部分失败窗口）。 */
function makeActivePackHaveInstalledNpm(packId, npmName) {
  writeFileSync(join(packsDir(), packId, 'hotpack.json'), JSON.stringify({
    hotpack: '1.0', id: packId, name: packId, version: '1.0.0',
    plugins: [{ id: 'foo', name: npmName, source: { type: 'npm' }, version: '1.0.0', config: {} }],
  }))
  const manifest = JSON.parse(readFileSync(join(iso.profile, 'package.json'), 'utf8'))
  manifest.dependencies = { ...(manifest.dependencies ?? {}), [npmName]: '1.0.0' }
  writeFileSync(join(iso.profile, 'package.json'), JSON.stringify(manifest, null, 2))
  const st = readState()
  st.activeInstall = { packId, installedNpm: [npmName] }
  writeState(st)
}

describe('activate 切换原子性：unmount 阶段部分失败', () => {
  it('BUG 复现：切换时 unmountPack 部分失败（patch 块已删、pnpm remove 失败）→ 不得留下「激活中但块已删」鬼状态', async () => {
    await gateway.importPack(JSON.stringify(pathPack('pack.a', 'pkg-a')))
    await gateway.importPack(JSON.stringify(pathPack('pack.b', 'pkg-b')))
    await gateway.activate('pack.a')
    expect(patchText()).toContain('hotplug:pack.a')

    makeActivePackHaveInstalledNpm('pack.a', 'foo')
    fakePnpmFail()

    const r = await gateway.activate('pack.b')
    expect(r.ok).toBe(false)

    // 契约：任何失败返回路径上「state.activePack」与「磁盘 hotplug 块」一致。
    // 当前 BUG：unmountPack 先 removePatchBlock 成功、后 pnpm remove 失败 → activate 直接
    // return unmounted，state.activePack 仍='pack.a' 而 A 的 patch 块已消失 → activePatchOk=false。
    expect(statusSync().activePatchOk).not.toBe(false)
  })

  it('BUG 复现：deactivate 时 unmountPack 部分失败 → 不得留下「激活中但块已删」鬼状态', async () => {
    await gateway.importPack(JSON.stringify(pathPack('pack.a', 'pkg-a')))
    await gateway.activate('pack.a')
    expect(patchText()).toContain('hotplug:pack.a')

    makeActivePackHaveInstalledNpm('pack.a', 'foo')
    fakePnpmFail()

    const r = await gateway.deactivate()
    expect(r.ok).toBe(false)
    expect(statusSync().activePatchOk).not.toBe(false)
  })
})

describe('importPack win32 大小写', () => {
  it.skipIf(process.platform !== 'win32')('BUG 复现：import 大小写变体 id 不得覆盖激活中的包', async () => {
    await gateway.importPack(JSON.stringify(pathPack('pack.a', 'pkg-a')))
    await gateway.activate('pack.a')
    expect(readState().activePack).toBe('pack.a')

    const variant = pathPack('PACK.A', 'pkg-evil')
    variant.name = 'Evil'
    variant.version = '2.0.0'
    const r = await gateway.importPack(JSON.stringify(variant))

    // 契约：激活中的包（含大小写变体——NTFS 大小写不敏感，'PACK.A' 与 'pack.a' 同目录）
    // 拒绝覆盖导入，与 activate/removePack 的 win32 语义一致。
    // 当前 BUG：importPackSync 用严格 `state.activePack === pack.id` 比对，'pack.a' !== 'PACK.A'
    // → 放行并覆盖 packs/pack.a/hotpack.json（激活中清单被静默替换）。
    expect(r.ok).toBe(false)
  })
})
