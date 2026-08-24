// test/audit-check-conflicts.test.mjs — 审计发现：checkAsync 的 conflicts 只按 status.packs 里
// plugin.version 比较（github/path 源 version 恒为 null）→ 同名非 npm 插件冲突被漏报；
// npm vs 非 npm 同名时又被误报为"版本冲突"（实际是名字冲突）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { importPackSync, checkAsync } from '../lib/core/status.js'
import { applyIsolatedEnv, isolatedDsh, samplePack } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

describe('checkAsync conflicts 只按 version 比较（BUG 复现）', () => {
  it('两个 github 插件同名不同 ref：version 均 null → 冲突被漏报', async () => {
    const pack1 = samplePack({ id: 'pack.one', plugins: [
      { id: 'a', name: 'pkg-x', source: { type: 'github', repo: 'o/r', ref: 'main' }, config: {} },
    ] })
    const pack2 = samplePack({ id: 'pack.two', plugins: [
      { id: 'a', name: 'pkg-x', source: { type: 'github', repo: 'o/r', ref: 'v2' }, config: {} },
    ] })
    importPackSync(JSON.stringify(pack1))
    importPackSync(JSON.stringify(pack2))
    const r = await checkAsync()
    // BUG：同名 pkg-x、不同 ref（不同内容）应报冲突；实际 version 均 null → 漏报
    expect(r.conflicts.length).toBe(1) // 实际 0
  })

  it('两个 path 插件同名不同路径：version 均 null → 冲突被漏报', async () => {
    const pack1 = samplePack({ id: 'pack.one', plugins: [
      { id: 'a', name: 'pkg-x', source: { type: 'path', path: 'C:/a/pkg-x' }, config: {} },
    ] })
    const pack2 = samplePack({ id: 'pack.two', plugins: [
      { id: 'a', name: 'pkg-x', source: { type: 'path', path: 'C:/b/pkg-x' }, config: {} },
    ] })
    importPackSync(JSON.stringify(pack1))
    importPackSync(JSON.stringify(pack2))
    const r = await checkAsync()
    expect(r.conflicts.length).toBe(1) // 实际 0
  })

  it('npm vs github 同名：报「源类型冲突」（不再误报为版本冲突）', async () => {
    const pack1 = samplePack({ id: 'pack.one', plugins: [
      { id: 'a', name: 'pkg-x', source: { type: 'npm' }, version: '1.0.0', config: {} },
    ] })
    const pack2 = samplePack({ id: 'pack.two', plugins: [
      { id: 'a', name: 'pkg-x', source: { type: 'github', repo: 'o/r', ref: 'main' }, config: {} },
    ] })
    importPackSync(JSON.stringify(pack1))
    importPackSync(JSON.stringify(pack2))
    const r = await checkAsync()
    expect(r.conflicts.length).toBe(1)
    // 修复后：源类型不同报「源类型冲突」，不再把 github 侧 null 版本误描述为「版本冲突 ?」
    expect(r.conflicts[0].reason).toContain('源类型冲突')
    expect(r.conflicts[0].reason).toContain('npm vs github')
  })
})
