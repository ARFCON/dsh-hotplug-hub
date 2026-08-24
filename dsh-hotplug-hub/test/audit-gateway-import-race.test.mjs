// test/audit-gateway-import-race.test.mjs — 审计发现：gateway.importPack 未走 serialize 串行化
// （会写 packs/<id>/hotpack.json），且 importPackSync 对 state.activePack===pack.id 的检查是
// 「读 state → 判断 → 写文件」非原子。并发 importPack + activate 时，可覆盖「正在激活中」的包 manifest，
// 造成「已激活状态 / 磁盘 manifest / 实际安装产物」三者不一致。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { copyFileSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { HotplugGateway } from '../lib/gateway.js'
import { readState, readPackManifest } from '../lib/core/state.js'
import { installedVersion } from '../lib/core/ensure.js'
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

/** 轮询等待文件出现。 */
async function waitFor(file, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return existsSync(file)
}

/** 假 pnpm add：安装 version 后写 started 标记，然后阻塞等待 release 标记才退出。 */
function fakePnpmAddBlocking() {
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "const spec = (process.argv.slice(2).find((a) => a.includes('@')) || '');",
    "const m = /^([^@]+)@(\\S+)$/.exec(spec);",
    "if (!m) process.exit(1);",
    "const d = path.join(process.cwd(), 'node_modules', m[1]);",
    "fs.mkdirSync(d, { recursive: true });",
    "fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: m[1], version: m[2] }));",
    "fs.writeFileSync(path.join(process.cwd(), '.fake-pnpm-started'), '1');",
    "const release = path.join(process.cwd(), '.fake-pnpm-release');",
    "const deadline = Date.now() + 15000;",
    "while (!fs.existsSync(release) && Date.now() < deadline) {",
    "  const sab = new SharedArrayBuffer(4); const a = new Int32Array(sab);",
    "  Atomics.wait(a, 0, 0, 20);",
    "}",
    "process.exit(0);",
    '',
  ].join('\n')
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, join(iso.dshHome, 'pnpm.exe'))
    writeFileSync(join(iso.profile, 'add'), script)
  } else {
    const exe = join(iso.dshHome, 'pnpm')
    writeFileSync(exe, `#!${process.execPath}\n` + script)
    chmodSync(exe, 0o755)
  }
}

describe('importPack 未串行化 → 与 activate 并发竞态（BUG 复现）', () => {
  it('activate 挂载 v1 期间 importPack 覆盖 manifest 为 v2，产生状态/清单/产物不一致', async () => {
    const v1 = {
      hotpack: '1.0', id: 'pack.a', name: 'A', version: '1.0.0',
      plugins: [{ id: 'p', name: 'pkg-a', source: { type: 'npm' }, version: '1.0.0', config: {} }],
    }
    await gateway.importPack(JSON.stringify(v1))
    fakePnpmAddBlocking()

    // 不 await：activate 挂载 v1（读 manifest → mountPack 阻塞在假 pnpm add）
    const actPromise = gateway.activate('pack.a')

    // 等假 pnpm 已开始安装（说明 activate 已读到 v1 manifest、正处于 mountPack 中）
    const started = await waitFor(join(iso.profile, '.fake-pnpm-started'))
    expect(started).toBe(true)

    // importPack 现走 serialize 链：排队在 activate 之后，不会并发覆盖「正在激活」的 manifest
    const v2 = { ...v1, plugins: [{ id: 'p', name: 'pkg-a', source: { type: 'npm' }, version: '2.0.0', config: {} }] }
    const impPromise = gateway.importPack(JSON.stringify(v2))

    writeFileSync(join(iso.profile, '.fake-pnpm-release'), '1') // 放行假 pnpm，activate 完成
    const act = await actPromise
    expect(act.ok).toBe(true)

    // 修复后：activate 完成后 activePack===pack.a → 覆盖导入被拒绝，manifest 仍是 v1（三者一致）
    const imp = await impPromise
    expect(imp.ok).toBe(false)
    expect(readState().activePack).toBe('pack.a')
    expect(readPackManifest('pack.a').plugins[0].version).toBe('1.0.0')
    expect(installedVersion('pkg-a')).toBe('1.0.0')
  })
})
