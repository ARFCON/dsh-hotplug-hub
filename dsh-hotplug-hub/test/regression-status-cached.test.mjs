// test/regression-status-cached.test.mjs — status 的 npm cached 判定须与 ensureNpm 一致
// BUG 复现：statusSync 对 npm 插件只比 `installedVersion === entry.version`，未校验
// node_modules/<name> 内部 package.json 的 name 是否等于声明名——串包（name 不符、
// 版本巧合相同）时 status 误报 cached:true，与 ensureNpm 实际会重装（replaced）矛盾。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { statusSync, importPackSync } from '../lib/core/status.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

describe('status npm cached 判定（版本 + 内部包名双校验）', () => {
  it('内部包名与声明不符（串包）时 cached 必须为 false', () => {
    // node_modules/foo 内部实际是 bar@1.0.0：name 不符、版本巧合相同
    const fooDir = join(iso.profile, 'node_modules', 'foo')
    mkdirSync(fooDir, { recursive: true })
    writeFileSync(join(fooDir, 'package.json'), JSON.stringify({ name: 'bar', version: '1.0.0' }))

    const r = importPackSync(JSON.stringify({
      hotpack: '1.0', id: 'pack.x', name: 'X', version: '1.0.0',
      plugins: [{ id: 'p', name: 'foo', source: { type: 'npm' }, version: '1.0.0', config: {} }],
    }))
    expect(r.ok).toBe(true)

    const s = statusSync()
    expect(s.packs).toHaveLength(1)
    const plugin = s.packs[0].plugins[0]
    expect(plugin.name).toBe('foo')
    // 串包：内部包名 bar ≠ 声明 foo → cached 不得为 true
    expect(plugin.cached).toBe(false)
  })

  it('内部包名与声明一致且版本一致时 cached 为 true（正向守卫）', () => {
    const fooDir = join(iso.profile, 'node_modules', 'foo')
    mkdirSync(fooDir, { recursive: true })
    writeFileSync(join(fooDir, 'package.json'), JSON.stringify({ name: 'foo', version: '1.0.0' }))

    importPackSync(JSON.stringify({
      hotpack: '1.0', id: 'pack.x', name: 'X', version: '1.0.0',
      plugins: [{ id: 'p', name: 'foo', source: { type: 'npm' }, version: '1.0.0', config: {} }],
    }))
    const s = statusSync()
    expect(s.packs[0].plugins[0].cached).toBe(true)
  })
})
