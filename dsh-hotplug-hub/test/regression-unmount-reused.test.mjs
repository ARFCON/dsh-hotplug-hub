// test/regression-unmount-reused.test.mjs — 无损替换根治：卸载只撤「本次实际安装/替换」的 npm 包
// BUG 复现：unmountPack 曾 `pnpm remove` 所有在 manifest.dependencies 里的 npm 插件名，
// 把 ensureNpm 判定为 reused（挂载前已存在的 profile 依赖）的包也一并删掉——破坏既有状态，
// 与 rollbackMount「只撤 freshlyInstalled」自相矛盾。现收敛为：卸载只撤 installedNpm。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { copyFileSync, writeFileSync, existsSync, readFileSync, mkdirSync, chmodSync } from 'node:fs'
import { unmountPack, mountPack } from '../lib/core/patch.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
  if (process.platform === 'win32') {
    // 假 pnpm = node 副本；`pnpm remove <name>` 实际执行 profile/remove 脚本
    copyFileSync(process.execPath, join(iso.dshHome, 'pnpm.exe'))
  } else {
    writePnpmPosix(removeScript())
  }
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

/** 假 pnpm remove：删除指定 name 的 node_modules 目录与 manifest.dependencies 条目。
 *  POSIX 下 argv.slice(2) 会含 'remove' 本身，须过滤（Windows 下 'remove' 是脚本名，已跳过）。 */
function removeScript() {
  return [
    "const fs = require('fs');",
    "const path = require('path');",
    "const names = process.argv.slice(2).filter((a) => a !== 'remove' && !a.startsWith('-'));",
    "const pkg = path.join(process.cwd(), 'package.json');",
    "const m = JSON.parse(fs.readFileSync(pkg, 'utf8'));",
    "m.dependencies = m.dependencies || {};",
    "for (const n of names) { delete m.dependencies[n]; try { fs.rmSync(path.join(process.cwd(), 'node_modules', n), { recursive: true, force: true }); } catch {} }",
    "fs.writeFileSync(pkg, JSON.stringify(m, null, 2));",
    ""
  ].join('\n')
}

function writePnpmPosix(script) {
  const exe = join(iso.dshHome, 'pnpm')
  // 必须带 shebang：PATH 被隔离（无 node），内核靠绝对 shebang 定位 node 执行脚本
  writeFileSync(exe, `#!${process.execPath}\n` + script)
  chmodSync(exe, 0o755)
}

/** 写入 Windows 版假 pnpm remove 脚本（profile/remove，node.exe 副本执行）。 */
function writeWinRemoveScript() {
  writeFileSync(join(iso.profile, 'remove'), removeScript())
}

/** 预置一个 npm 依赖（node_modules/<name> + manifest.dependencies.<name>）。 */
function seedDep(name, version) {
  const dir = join(iso.profile, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  const m = JSON.parse(readFileSync(join(iso.profile, 'package.json'), 'utf8'))
  m.dependencies = m.dependencies || {}
  m.dependencies[name] = version
  writeFileSync(join(iso.profile, 'package.json'), JSON.stringify(m, null, 2))
}

const npmPlugin = (id, name) => ({ id, name, source: { type: 'npm' }, version: '1.0.0', config: {} })

describe('unmountPack 卸载语义（只撤本次安装的 npm 包，无损替换）', () => {
  it('installedNpm 不含 reused 预存包 → 卸载后该包保留（不再误删）', async () => {
    seedDep('foo', '1.0.0')
    const pack = { hotpack: '1.0', id: 'pack.r', name: 'R', version: '1.0.0', plugins: [npmPlugin('a', 'foo')] }
    // foo 是 reused（挂载前已存在），本次挂载未安装它 → installedNpm 为空
    const r = await unmountPack(pack, { installedNpm: [] })
    expect(r.ok).toBe(true)
    const after = JSON.parse(readFileSync(join(iso.profile, 'package.json'), 'utf8'))
    // 预存依赖 foo 被保留（无损）；此前实现会 pnpm remove foo 将其删除
    expect(after.dependencies.foo).toBe('1.0.0')
    expect(existsSync(join(iso.profile, 'node_modules', 'foo', 'package.json'))).toBe(true)
  })

  it('installedNpm 含本次安装的包 → 卸载后该包被移除（只撤本次装的）', async () => {
    if (process.platform === 'win32') writeWinRemoveScript()
    seedDep('bar', '1.0.0')
    const pack = { hotpack: '1.0', id: 'pack.r', name: 'R', version: '1.0.0', plugins: [npmPlugin('b', 'bar')] }
    // bar 是本次挂载实际安装的 → installedNpm 含 bar → 卸载应移除
    const r = await unmountPack(pack, { installedNpm: ['bar'] })
    expect(r.ok).toBe(true)
    const after = JSON.parse(readFileSync(join(iso.profile, 'package.json'), 'utf8'))
    expect(after.dependencies.bar).toBeUndefined()
    expect(existsSync(join(iso.profile, 'node_modules', 'bar', 'package.json'))).toBe(false)
  })

  it('缺省 installedNpm（迁移/旧调用方）→ 一个都不删（无损优先，不因信息缺失破坏既有依赖）', async () => {
    seedDep('foo', '1.0.0')
    const pack = { hotpack: '1.0', id: 'pack.r', name: 'R', version: '1.0.0', plugins: [npmPlugin('a', 'foo')] }
    // 不传 installedNpm（未知）→ 不删除任何 npm 依赖（无需假 pnpm，pnpm remove 不会触发）
    const r = await unmountPack(pack)
    expect(r.ok).toBe(true)
    const after = JSON.parse(readFileSync(join(iso.profile, 'package.json'), 'utf8'))
    expect(after.dependencies.foo).toBe('1.0.0')
    expect(existsSync(join(iso.profile, 'node_modules', 'foo', 'package.json'))).toBe(true)
  })
})

describe('mountPack 返回 installedNpm（供激活方持久化）', () => {
  it('reused 的 npm 包不计入 installedNpm；path 源不计入', async () => {
    // 预置 foo（npm，reused）；构造真实 path 源 pkg-b
    seedDep('foo', '1.0.0')
    const srcDir = join(iso.dshHome, 'plugin-src', 'pkg-b')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'package.json'), JSON.stringify({ name: 'pkg-b', version: '1.0.0' }))
    const pack = {
      hotpack: '1.0', id: 'pack.m', name: 'M', version: '1.0.0',
      plugins: [npmPlugin('a', 'foo'), { id: 'b', name: 'pkg-b', source: { type: 'path', path: srcDir }, config: {} }],
    }
    const m = await mountPack(pack)
    expect(m.ok).toBe(true)
    // foo reused → 不在 installedNpm；path 源本就不经 pnpm
    expect(m.installedNpm).toEqual([])
  })
})
