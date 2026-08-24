// test/audit-paths-profile.test.mjs — 审计发现：
// 1) profileName() 在 DSH_PROFILE 显式指定一个「尚不存在」的 profile 时，会静默回退到
//    默认 desktop/web/headless（忽略显式环境变量）——写入错误的 profile 的语义隐患。
// 2) storeDirOf 的 %2F 编码：证伪碰撞/逃逸担忧（'%' 不在合法 name/ref 字符集中，编码可逆无碰撞）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { profileName, profileDir } from '../lib/core/paths.js'
import { storeDirOf, storeKeySegment } from '../lib/core/ensure.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

describe('profileName：DSH_PROFILE 显式指定的 profile 被静默回退（潜在 bug）', () => {
  it('DSH_PROFILE=ghost（不存在）且 desktop 存在 → 静默返回 desktop，而非 ghost', () => {
    // 建一个已存在的默认 profile（desktop）
    mkdirSync(join(iso.dshHome, 'profiles', 'desktop'), { recursive: true })
    writeFileSync(join(iso.dshHome, 'profiles', 'desktop', 'package.json'), '{}')
    process.env.DSH_PROFILE = 'ghost'
    // 期望：显式 DSH_PROFILE 应被遵守（返回 ghost）或报错；实际：静默回退到 desktop
    expect(profileName()).toBe('ghost') // 实际 'desktop'（显式 env 被忽略）
    expect(profileDir()).toContain('ghost')
  })
})

describe('storeDirOf %2F 编码：证伪碰撞/逃逸', () => {
  it("storeKeySegment 只把 '/' 换成 '%2F'，'%' 不在合法 name/ref 字符集 → 无碰撞", () => {
    expect(storeKeySegment('a/b')).toBe('a%2Fb')
    expect(storeKeySegment('@scope/name')).toBe('@scope%2Fname')
    expect(storeKeySegment('no-slash')).toBe('no-slash')
  })

  it('不同 (name, ref) 映射到不同 store 目录，且无父子目录关系（无数据丢失）', () => {
    const a = storeDirOf({ name: 'pkg', source: { type: 'github', ref: 'feature' } })
    const b = storeDirOf({ name: 'pkg', source: { type: 'github', ref: 'feature/x' } })
    const c = storeDirOf({ name: '@s/name', source: { type: 'github', ref: 'main' } })
    expect(new Set([a, b, c]).size).toBe(3)
    // 无父子目录关系（rmSync 一个不会误删另一个）——按「路径段边界」判定，而非字符串前缀
    const parentOf = (x, y) => y.startsWith(x + '/') || y.startsWith(x + '\\')
    expect(parentOf(a, b) || parentOf(b, a)).toBe(false)
    expect(parentOf(a, c) || parentOf(c, a)).toBe(false)
  })
})
