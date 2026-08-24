// test/audit-unmount-reused.test.mjs — 审计发现：unmountPack 对 npm 插件做 pnpm remove 时
// 不区分「本次挂载新装」与「挂载前 profile 已存在（reused）」，会把 reused 的既有依赖也误删，
// 破坏「无损替换」契约。rollbackMount 已专门修复（只撤 freshlyInstalled），但 unmountPack 自身仍残留此缺陷。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { mountPack, unmountPack } from '../lib/core/patch.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

/** 假 pnpm remove：真实删除 node_modules/<name> 并从 package.json 移除 dependencies。<name>。 */
function fakePnpmRemove() {
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "const names = process.argv.slice(2).filter((a) => a !== 'remove' && !a.startsWith('-'));",
    "for (const name of names) {",
    "  const d = path.join(process.cwd(), 'node_modules', name);",
    "  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}",
    "}",
    "const pkgPath = path.join(process.cwd(), 'package.json');",
    "try {",
    "  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));",
    "  for (const name of names) delete pkg.dependencies[name];",
    "  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));",
    "} catch {}",
    "process.exit(0);",
    '',
  ].join('\n')
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, join(iso.dshHome, 'pnpm.exe'))
    writeFileSync(join(iso.profile, 'remove'), script)
  } else {
    const exe = join(iso.dshHome, 'pnpm')
    writeFileSync(exe, `#!${process.execPath}\n` + script)
    chmodSync(exe, 0o755)
  }
}

/** 预置 profile 既有依赖 foo@1.0.0（node_modules + manifest.dependencies 均存在）。 */
function preinstallFoo() {
  const fooDir = join(iso.profile, 'node_modules', 'foo')
  mkdirSync(fooDir, { recursive: true })
  writeFileSync(join(fooDir, 'package.json'), JSON.stringify({ name: 'foo', version: '1.0.0' }))
  const manifest = JSON.parse(readFileSync(join(iso.profile, 'package.json'), 'utf8'))
  manifest.dependencies = { foo: '1.0.0' }
  writeFileSync(join(iso.profile, 'package.json'), JSON.stringify(manifest, null, 2))
}

describe('unmountPack 误删 reused 既有依赖（BUG 复现）', () => {
  it('挂载 reused 的 npm 依赖后卸载，挂载前既有的 foo 被 pnpm remove 误删', async () => {
    preinstallFoo()      // 挂载前 profile 已有 foo@1.0.0
    fakePnpmRemove()     // 假 pnpm remove 真实删除

    const pack = {
      hotpack: '1.0', id: 'pack.r', name: 'R', version: '1.0.0',
      plugins: [{ id: 'p', name: 'foo', source: { type: 'npm' }, version: '1.0.0', config: {} }],
    }

    const m = await mountPack(pack)
    expect(m.ok).toBe(true)
    expect(m.steps[0].status).toBe('reused') // foo 是挂载前既有依赖（reused）

    // 修复后：卸载只撤「本次挂载实际安装/替换」的 npm 包（mountPack 返回 installedNpm）
    const u = await unmountPack(pack, { installedNpm: m.installedNpm })
    expect(u.ok).toBe(true)

    // BUG 复现：reused 的既有依赖被误删（破坏「无损替换」契约——挂载前就有，卸载后应保留）
    expect(existsSync(join(iso.profile, 'node_modules', 'foo', 'package.json'))).toBe(true) // 实际 false
    expect(JSON.parse(readFileSync(join(iso.profile, 'package.json'), 'utf8')).dependencies.foo).toBe('1.0.0')
  })
})
