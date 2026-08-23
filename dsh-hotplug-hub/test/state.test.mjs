// test/state.test.mjs — 状态 / 包清单 / 导入（隔离 DSH_HOME）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { readState, writeState, readPackManifest, listPackIds, readJson, writeJsonSafe } from '../lib/core/state.js'
import { importPackSync } from '../lib/core/status.js'
import { applyIsolatedEnv, isolatedDsh, samplePack } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

describe('lib/core/state', () => {
  it('readState 缺省骨架 / writeState 往返', () => {
    const s0 = readState()
    expect(s0.version).toBe(1)
    expect(s0.activePack).toBeNull()
    s0.activePack = 'pack.x'
    writeState(s0)
    const s1 = readState()
    expect(s1.activePack).toBe('pack.x')
    expect(typeof s1.updatedAt).toBe('string')
  })

  it('readPackManifest：非法 id 拒绝；不存在返回 null', () => {
    expect(readPackManifest('../x')).toBeNull()
    expect(readPackManifest('no-such')).toBeNull()
  })

  it('importPackSync：落盘 hotpack.json + listPackIds 可见', () => {
    const r = importPackSync(JSON.stringify(samplePack()))
    expect(r.ok).toBe(true)
    expect(r.pack.id).toBe('pack.test')
    expect(listPackIds()).toEqual(['pack.test'])
    const manifest = readPackManifest('pack.test')
    expect(manifest.name).toBe('Test Pack')
    expect(manifest.memory).toEqual({ keep: true })
  })

  it('importPackSync：非法输入 / 激活中拒绝', () => {
    expect(importPackSync('{bad').ok).toBe(false)
    importPackSync(JSON.stringify(samplePack()))
    const st = readState()
    st.activePack = 'pack.test'
    writeState(st)
    const r = importPackSync(JSON.stringify(samplePack()))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('激活中')
  })

  it('readJson / writeJsonSafe', () => {
    const f = join(iso.dshHome, 'x.json')
    writeJsonSafe(f, { a: 1 })
    expect(readJson(f)).toEqual({ a: 1 })
    expect(readJson(join(iso.dshHome, 'nope.json'))).toBeNull()
    expect(readJson(f + '?bad')).toBeNull()
  })

  it('writeJsonSafe 原子写（审计修复 M-44）：覆盖写往返一致、无 .tmp/.bak 残留', () => {
    const f = join(iso.dshHome, 'atomic.json')
    writeJsonSafe(f, { a: 1 })
    writeJsonSafe(f, { a: 2 }) // 覆盖写
    expect(readJson(f)).toEqual({ a: 2 })
    const files = readdirSync(iso.dshHome)
    expect(files.some((x) => x.includes('.tmp'))).toBe(false)
    expect(files.some((x) => x.endsWith('.bak'))).toBe(false)
  })
})
