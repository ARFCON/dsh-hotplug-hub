// test/audit-patch-prefix.test.mjs — 审计发现：appendPatchBlock 用子串 includes 判定"已存在同名块"
// 而 shared findPatchBlock 用精确 marker 匹配。当 pack id 存在前缀关系（PACK_ID_RE 允许 `.`）
// 时，子串匹配产生误判（false positive 拒绝挂载）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { appendPatchBlock } from '../lib/core/patch.js'
import { applyIsolatedEnv, isolatedDsh, samplePack } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

describe('appendPatchBlock 前缀 id 子串误判（BUG 复现）', () => {
  it('已有 ## hotplug:pack.a.b 块时，挂载 pack.a 被误拒（pack.a 是 pack.a.b 的前缀）', async () => {
    // 预置 pack.a.b 的 patch 块
    writeFileSync(join(iso.profile, 'cordis.patch.yml'), '## hotplug:pack.a.b\n- insert: []\n')

    // shared 精确匹配正确报告 pack.a 不存在（无同名块）
    const { findPatchBlock } = await import('../vendor-shared/index.mjs')
    const text = readFileSync(join(iso.profile, 'cordis.patch.yml'), 'utf8')
    expect(findPatchBlock(text, 'hotplug', 'pack.a').found).toBe(false)

    // BUG 复现：appendPatchBlock 用 text.includes('## hotplug:pack.a') 子串匹配，
    // '## hotplug:pack.a.b' 含 '## hotplug:pack.a' 子串 → 误判"已存在"，拒绝挂载。
    // 期望：pack.a 与 pack.a.b 是不同 id，应允许挂载（ok:true）。
    const r = appendPatchBlock(samplePack({ id: 'pack.a' }))
    expect(r.ok).toBe(true) // 实际 false（error 含"已存在同名"）
  })

  it('已有 ## hotplug:pack.a 块时，挂载 pack.a.b 不受影响（反向不误判，仅作对照）', () => {
    writeFileSync(join(iso.profile, 'cordis.patch.yml'), '## hotplug:pack.a\n- insert: []\n')
    // '## hotplug:pack.a' 不含 '## hotplug:pack.a.b' 子串 → 不会误判，可正常挂载
    const r = appendPatchBlock(samplePack({ id: 'pack.a.b' }))
    expect(r.ok).toBe(true)
  })

  it('连字符前缀同理误判：pack.x 与 pack.x-extra', () => {
    writeFileSync(join(iso.profile, 'cordis.patch.yml'), '## hotplug:pack.x-extra\n- insert: []\n')
    const r = appendPatchBlock(samplePack({ id: 'pack.x' }))
    expect(r.ok).toBe(true) // 实际 false
  })
})
